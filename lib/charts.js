// Chart data, stored locally under data/charts and refreshed on demand:
// - Billboard Hot 100: every weekly chart since 1958 (UT Austin "rwd-billboard-data", updated weekly).
//   Re-downloaded when the local copy is over a week old.
// - iTunes Top Songs: Apple only publishes the current top 100, so we keep a daily snapshot
//   and build our own history from those.
import fs from 'node:fs';
import path from 'node:path';
import { songKey, primaryArtist } from './library.js';

const BILLBOARD_URL = 'https://raw.githubusercontent.com/utdata/rwd-billboard-data/main/data-out/hot-100-current.csv';
const ITUNES_URL = 'https://itunes.apple.com/us/rss/topsongs/limit=100/json';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const ITUNES_WINDOW_DAYS = 30;

export function chartPaths(root) {
  const dir = path.join(process.env.PP_DATA_DIR || path.join(root, 'data'), 'charts');
  return { dir, billboard: path.join(dir, 'hot-100.csv'), itunes: path.join(dir, 'itunes') };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const normWords = (s) => ` ${String(s || '').toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;

// Index entries ({artist, title, ...}) by exact song key and by title for fuzzy artist matching.
function indexSongs(entries) {
  const songs = new Map();
  const byTitle = new Map();
  for (const s of entries) {
    s.artistWords = normWords(s.artist);
    songs.set(songKey(s.artist, s.title), s);
    const t = songKey('', s.title).slice(1);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(s);
  }
  return { songs, byTitle };
}

// Exact artist+title first; otherwise same title where the lead artist appears in the
// chart's performer credit ("Jay-Z Featuring Mr. Hudson", "Bone Thugs-N-Harmony").
function match(index, track) {
  if (!index) return null;
  const exact = index.songs.get(track.songKey);
  if (exact) return exact;
  const lead = primaryArtist(track.artist);
  if (!lead || lead.length < 2) return null;
  return (index.byTitle.get(track.songKey.split('|')[1]) || []).find((s) => s.artistWords.includes(` ${lead} `)) || null;
}

export function loadBillboard(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const [cWeek, cPos, cTitle, cArtist] = ['chart_week', 'current_week', 'title', 'performer'].map((n) => header.indexOf(n));
  if ([cWeek, cPos, cTitle, cArtist].some((i) => i < 0)) throw new Error('Unexpected Billboard file format');
  const agg = new Map();
  let latest = '';
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = parseCsvLine(lines[i]);
    const week = r[cWeek];
    const pos = Number(r[cPos]);
    if (!week || !pos) continue;
    if (week > latest) latest = week;
    const key = songKey(r[cArtist], r[cTitle]);
    let s = agg.get(key);
    if (!s) agg.set(key, (s = { title: r[cTitle], artist: r[cArtist], peak: 101, weeks: 0, first: week }));
    s.peak = Math.min(s.peak, pos);
    s.weeks += 1;
    if (week < s.first) s.first = week;
  }
  const entries = [...agg.values()];
  for (const s of entries) {
    s.year = Number(s.first.slice(0, 4));
    // 0..1: a long-running #1 is ~1, a one-week #100 is ~0.
    s.score = +(0.6 * ((101 - s.peak) / 100) + 0.4 * Math.min(s.weeks, 20) / 20).toFixed(3);
  }
  return { ...indexSongs(entries), latest, count: entries.length, fetched: fs.statSync(file).mtime.toISOString() };
}

export function loadItunes(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return null; }
  if (!files.length) return null;
  const cutoff = new Date(Date.now() - ITUNES_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const agg = new Map();
  for (const f of files) {
    const date = f.slice(0, 10);
    if (date < cutoff) continue;
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const r of rows) {
      const key = songKey(r.artist, r.title);
      let s = agg.get(key);
      if (!s) agg.set(key, (s = { title: r.title, artist: r.artist, best: 101, days: 0, last: date }));
      s.best = Math.min(s.best, r.rank);
      s.days += 1;
      if (date > s.last) s.last = date;
    }
  }
  const latest = files[files.length - 1].slice(0, 10);
  const entries = [...agg.values()];
  for (const s of entries) {
    // Fresh hits matter most: full weight if on today's chart, fading over the window.
    const ageDays = (Date.parse(latest) - Date.parse(s.last)) / 864e5;
    s.score = +((1 - (s.best - 1) / 100) * Math.max(0.2, 1 - ageDays / ITUNES_WINDOW_DAYS)).toFixed(3);
  }
  return { ...indexSongs(entries), latest, snapshots: files.length, count: entries.length };
}

async function download(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

// Network refresh. Failures are reported, never fatal: the app keeps the last local copy.
export async function refreshCharts(root, { force = false } = {}) {
  const p = chartPaths(root);
  fs.mkdirSync(p.itunes, { recursive: true });
  const result = { billboard: 'up to date', itunes: 'up to date' };

  const stale = !fs.existsSync(p.billboard) || Date.now() - fs.statSync(p.billboard).mtimeMs > WEEK_MS;
  if (force || stale) {
    try {
      const text = await (await download(BILLBOARD_URL, 120000)).text();
      if (!text.startsWith('chart_week,')) throw new Error('unexpected Billboard file contents');
      fs.writeFileSync(`${p.billboard}.tmp`, text);
      fs.renameSync(`${p.billboard}.tmp`, p.billboard);
      result.billboard = 'updated';
    } catch (e) {
      result.billboard = `failed: ${e.message}`;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const snap = path.join(p.itunes, `${today}.json`);
  if (force || !fs.existsSync(snap)) {
    try {
      const feed = (await (await download(ITUNES_URL, 30000)).json()).feed;
      const rows = (feed.entry || []).map((e, i) => ({ rank: i + 1, artist: e['im:artist']?.label || '', title: e['im:name']?.label || '' }));
      if (!rows.length) throw new Error('empty iTunes feed');
      fs.writeFileSync(snap, JSON.stringify(rows));
      result.itunes = 'updated';
    } catch (e) {
      result.itunes = `failed: ${e.message}`;
    }
  }
  return result;
}

// Attaches chart info to tracks and lets Billboard correct years (its first chart week is
// a better release-year signal than artist medians or folder dates).
export function annotateCharts(lib, billboard, itunes) {
  let matched = 0;
  for (const t of lib.tracks) {
    const bb = match(billboard, t);
    const it = match(itunes, t);
    t.billboard = bb ? { peak: bb.peak, weeks: bb.weeks, year: bb.year, score: bb.score } : null;
    t.itunes = it ? { best: it.best, last: it.last, days: it.days, score: it.score } : null;
    if (bb || it) matched++;
    if (t._origYear === undefined) t._origYear = [t.year, t.yearSrc];
    const [year, src] = t._origYear;
    if (bb && (!year || !['tag', 'other version'].includes(src) || bb.year < year)) {
      t.year = bb.year;
      t.yearSrc = 'Billboard';
    } else {
      t.year = year;
      t.yearSrc = src;
    }
  }
  return matched;
}
