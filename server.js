// Local-only web server: reads the Serato library, plans sets, streams audio for preview,
// and writes crates. Binds to 127.0.0.1; nothing leaves this machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLibrary } from './lib/library.js';
import { parsePrompt, plan, sequence, reshuffleBucket, scoreTrack, transitionInfo, chartStrength, GENRE_LIST } from './lib/planner.js';
import { readSeratoTags } from './lib/seratoTags.js';
import { saveCrate, crateFile, sanitizeCrateName, SERATO_DIR } from './lib/serato.js';
import { GENRES, keyDistance } from './lib/genres.js';
import { chartPaths, loadBillboard, loadItunes, refreshCharts, annotateCharts } from './lib/charts.js';
import { nowPlaying, suggestNext } from './lib/nowplaying.js';
import { DIALS, PRESETS as DIAL_PRESETS } from './lib/dials.js';
import { pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Saved recipes, crate backups and charts. The packaged app points this at
// ~/Library/Application Support/Party Planner; from the project folder it's ./data.
const DATA_DIR = process.env.PP_DATA_DIR || path.join(ROOT, 'data');
const BACKUPS = path.join(DATA_DIR, 'crate-backups');
const PRESETS = path.join(DATA_DIR, 'presets.json');
const PORT = Number(process.env.PORT) || 4321;
const HOST = '127.0.0.1';
const DEFAULT_PARENT = 'Party Planner';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.ogg': 'audio/ogg',
};

let lib = null;
const charts = { billboard: null, itunes: null, matched: 0, refreshing: false, lastRefresh: null };

// The Popularity number shown in the UI: your plays/play count/crates blended with chart
// performance (Billboard peak + weeks, current iTunes rank), plus its percentile in the library.
function computeHits() {
  for (const t of lib.tracks) {
    const chart = chartStrength(t, { eras: [] });
    t.pop.chart = Math.round(chart * 100);
    t.pop.hit = Math.round(100 * (0.6 * t.popularity + 0.4 * chart)); // 100 = your staple AND a big chart hit
  }
  const sorted = lib.tracks.map((t) => t.pop.hit).sort((a, b) => b - a);
  const first = new Map();
  sorted.forEach((v, i) => { if (!first.has(v)) first.set(v, i); });
  for (const t of lib.tracks) t.pop.hitTop = Math.max(1, Math.ceil((100 * (first.get(t.pop.hit) + 1)) / lib.tracks.length));
}

function loadChartData() {
  const p = chartPaths(ROOT);
  try { charts.billboard = loadBillboard(p.billboard); } catch (e) { console.error('Billboard load failed:', e.message); }
  charts.itunes = loadItunes(p.itunes);
  if (lib) {
    charts.matched = annotateCharts(lib, charts.billboard, charts.itunes);
    computeHits();
  }
}

function reload() {
  lib = loadLibrary();
  console.log(`Loaded ${lib.stats.tracks} tracks, ${lib.stats.crates} crates, ${lib.stats.sessions} history sessions in ${lib.stats.loadMs}ms`);
  if (charts.billboard || charts.itunes) charts.matched = annotateCharts(lib, charts.billboard, charts.itunes);
  computeHits();
}

// Background refresh: Billboard if older than a week, iTunes once a day. Never blocks startup.
async function refreshChartData(force) {
  if (charts.refreshing) return charts.lastRefresh;
  charts.refreshing = true;
  try {
    charts.lastRefresh = { ...(await refreshCharts(ROOT, { force })), at: new Date().toISOString() };
    loadChartData();
    console.log('Charts:', charts.lastRefresh, `${charts.matched} library tracks on a chart`);
  } finally {
    charts.refreshing = false;
  }
  return charts.lastRefresh;
}

function chartStatus() {
  return {
    billboardLatest: charts.billboard?.latest || null,
    billboardSongs: charts.billboard?.count || 0,
    itunesLatest: charts.itunes?.latest || null,
    itunesSnapshots: charts.itunes?.snapshots || 0,
    matched: charts.matched,
    refreshing: charts.refreshing,
    lastRefresh: charts.lastRefresh,
  };
}

function reasons(t) {
  const out = [];
  for (const [g, src] of Object.entries(t.genreSrc || {})) if (t.genres[g]) out.push(`${GENRES[g].label} (${src.join(', ')})`);
  if (t.year) out.push(`${t.year} (${t.yearSrc})`);
  if (t.billboard) out.push(`Billboard Hot 100 peak #${t.billboard.peak}, ${t.billboard.weeks} wk${t.billboard.weeks === 1 ? '' : 's'} (${t.billboard.year})`);
  if (t.itunes) out.push(`iTunes top 100 #${t.itunes.best} (${t.itunes.last})`);
  if (t.plays) out.push(`played in ${t.plays} session${t.plays === 1 ? '' : 's'}`);
  if (t.playCount) out.push(`Serato play count ${t.playCount}`);
  if (t.energy) out.push(`energy ${t.energy}`);
  return out;
}

function trackJSON(t, extra = {}) {
  return {
    id: t.id, artist: t.artist, title: t.title, album: t.album, bpm: t.bpm ? +t.bpm.toFixed(1) : null, key: t.key,
    year: t.year, yearSrc: t.yearSrc, genres: t.genres, energy: t.energy, plays: t.plays, playCount: t.playCount, popularity: t.popularity, pop: t.pop, billboard: t.billboard, itunes: t.itunes,
    length: t.length, ext: t.ext, clean: t.clean, dirty: t.dirty, crates: t.crates.length, reasons: reasons(t),
    location: t.file, fileUrl: pathToFileURL(t.file).href, ...extra,
  };
}

function flow(ids) {
  const out = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const a = lib.byId.get(ids[i]);
    const b = lib.byId.get(ids[i + 1]);
    out.push(a && b ? transitionInfo(lib, a, b) : null);
  }
  return out;
}

function planResponse(intent, items, pools) {
  const set = items.map((it) => trackJSON(it.track, { bucket: it.bucket }));
  return { intent, set, flow: flow(set.map((t) => t.id)), pools: pools?.map(({ bucket, candidates }) => ({ bucket, candidates })) };
}

function seratoRunning() {
  return new Promise((resolve) => execFile('pgrep', ['-x', 'Serato DJ Pro'], (err) => resolve(!err)));
}

async function readBody(req) {
  let data = '';
  for await (const c of req) {
    data += c;
    if (data.length > 2e6) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  return data ? JSON.parse(data) : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function streamAudio(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return send(res, 404, { error: 'File not found on disk' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

function serveStatic(res, urlPath) {
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// Saved searches: the brief + editable intent (not the resulting tracks), kept on disk.
function readPresets() {
  try { return JSON.parse(fs.readFileSync(PRESETS, 'utf8')); } catch { return []; }
}

function writePresets(list) {
  fs.mkdirSync(path.dirname(PRESETS), { recursive: true });
  fs.writeFileSync(`${PRESETS}.tmp`, JSON.stringify(list, null, 2));
  fs.renameSync(`${PRESETS}.tmp`, PRESETS);
}

const routes = {
  'GET /api/status': async () => ({
    stats: lib.stats,
    seratoDir: SERATO_DIR,
    seratoRunning: await seratoRunning(),
    genres: GENRE_LIST,
    crates: lib.crates,
    defaultParent: DEFAULT_PARENT,
    charts: chartStatus(),
    dials: DIALS,
    dialPresets: DIAL_PRESETS,
  }),

  'POST /api/charts/refresh': async () => {
    await refreshChartData(true);
    return { charts: chartStatus() };
  },

  'POST /api/parse': async (body) => parsePrompt(body.prompt),

  'POST /api/plan': async (body) => {
    const intent = body.intent || parsePrompt(body.prompt);
    const { items, pools } = plan(lib, intent);
    return planResponse(intent, items, pools);
  },

  // Re-order an edited set (after adds/removes) with the same block/flow logic.
  'POST /api/sequence': async ({ intent, items }) => {
    const resolved = items.map((it) => ({ track: lib.byId.get(it.id), bucket: it.bucket ?? 0 })).filter((it) => it.track);
    return planResponse(intent, sequence(lib, resolved, intent));
  },

  // Re-pick one pillar; every other track keeps its place.
  'POST /api/reshuffle': async ({ intent, items, bucket, seed }) => {
    if (!intent?.buckets?.[bucket]) return [400, { error: 'Unknown pillar' }];
    const resolved = items.map((it) => ({ track: lib.byId.get(it.id), bucket: it.bucket ?? 0 })).filter((it) => it.track);
    const res = reshuffleBucket(lib, intent, resolved, bucket, seed || Date.now() % 100000);
    return { ...planResponse(intent, res.items), candidates: res.candidates };
  },

  'POST /api/flow': async ({ ids }) => ({ flow: flow(ids) }),

  // Restore a saved recipe's exact tracks (fresh metadata; tracks no longer in the library are skipped).
  'POST /api/tracks': async ({ intent, items }) => {
    const found = (items || []).map((it) => ({ track: lib.byId.get(it.id), bucket: it.bucket ?? 0 })).filter((it) => it.track);
    return { ...planResponse(intent, found), missing: (items || []).length - found.length };
  },

  // What's on Serato's decks, read from the live history session file.
  'GET /api/nowplaying': async () => {
    const np = nowPlaying(lib, lib.resolvePath);
    const deck = (d) => ({ ...d, track: d.track ? trackJSON(d.track) : null });
    return { live: np.live, sessionUpdated: np.sessionUpdated, decks: (np.decks || []).map(deck), current: np.current ? deck(np.current) : null, playedCount: np.played?.size || 0, error: np.error };
  },

  // Next-track ideas from a seed (explicit track, or whatever Serato is playing) + optional vibe text.
  'POST /api/suggest': async ({ seedId, text, limit = 25, shuffle = 0, avoidIds = [], dials }) => {
    const np = nowPlaying(lib, lib.resolvePath);
    const seed = seedId ? lib.byId.get(seedId) : np.live ? np.current?.track : null;
    const exclude = np.live ? np.played : new Set();
    const { parsed, results } = suggestNext(lib, seed, text, { exclude, limit, shuffle: Number(shuffle) || 0, avoid: new Set(avoidIds), dials });
    return { seed: seed ? trackJSON(seed) : null, live: !seedId && np.live, parsed, tracks: results.map(({ t, why, bpmDelta, half, factors }) => trackJSON(t, { why, bpmDelta, half, factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, +v.toFixed(2)])) })) };
  },

  // Finder fallback for getting a file into Serato: reveal it, then drag from Finder.
  'POST /api/reveal': async ({ id }) => {
    const t = lib.byId.get(id);
    if (!t) return [404, { error: 'Unknown track' }];
    if (!fs.existsSync(t.file)) return [404, { error: 'File not found on disk' }];
    await new Promise((resolve, reject) => execFile('open', ['-R', t.file], (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  },

  // Swap candidates for one slot: same bucket, not already in the set, ranked by fit + neighbors.
  'POST /api/alternatives': async ({ intent, bucket, setIds, prevId, nextId, limit = 15 }) => {
    const b = intent.buckets[bucket] || intent.buckets[0];
    const inSet = new Set(setIds || []);
    const songsInSet = new Set([...inSet].map((id) => lib.byId.get(id)?.songKey));
    const prev = lib.byId.get(prevId);
    const next = lib.byId.get(nextId);
    const best = new Map();
    for (const t of lib.tracks) {
      if (inSet.has(t.id) || songsInSet.has(t.songKey)) continue;
      let s = scoreTrack(t, b, intent);
      if (!s) continue;
      for (const n of [prev, next]) {
        if (!n) continue;
        const proven = (lib.transitions.get(n.path)?.get(t.path) || 0) + (lib.transitions.get(t.path)?.get(n.path) || 0);
        const bpmGap = n.bpm && t.bpm ? Math.min(...[t.bpm, t.bpm * 2, t.bpm / 2].map((x) => Math.abs(n.bpm - x) / n.bpm)) : 0.1;
        s *= (1 + 0.3 * Math.log1p(proven)) / (1 + 4 * bpmGap + 0.05 * keyDistance(n.key, t.key));
      }
      const cur = best.get(t.songKey);
      if (!cur || s > cur.s) best.set(t.songKey, { t, s });
    }
    const ranked = [...best.values()].sort((x, y) => y.s - x.s).slice(0, limit);
    return { tracks: ranked.map(({ t }) => trackJSON(t, { bucket })) };
  },

  'GET /api/search': async (_, url) => {
    // Punctuation-insensitive so "big" finds "B.I.G." and "jay z" finds "JAY-Z".
    const norm = (s) => s.toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9&]+/g, ' ');
    const words = norm(url.searchParams.get('q') || '').split(' ').filter(Boolean);
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 40);
    if (!words.length) return { tracks: [] };
    const hits = [];
    for (const t of lib.tracks) {
      const hay = norm(`${t.artist} ${t.title} ${t.album} ${t.genreTag}`);
      if (words.every((w) => hay.includes(w))) hits.push(t);
    }
    hits.sort((a, b) => b.popularity - a.popularity);
    return { total: hits.length, tracks: hits.slice(0, limit).map((t) => trackJSON(t)) };
  },

  'POST /api/crate': async ({ name, parent = DEFAULT_PARENT, ids, overwrite }) => {
    const cleanName = sanitizeCrateName(name || '');
    if (!cleanName) return [400, { error: 'Give the crate a name' }];
    const tracks = (ids || []).map((id) => lib.byId.get(id)).filter(Boolean);
    if (!tracks.length) return [400, { error: 'The set is empty' }];
    const fullName = [...(parent ? parent.split('%%') : []), cleanName].map(sanitizeCrateName).filter(Boolean).join('%%');
    if (fs.existsSync(crateFile(fullName)) && !overwrite) return [409, { error: 'exists', fullName }];
    const result = saveCrate({ name: cleanName, parent, paths: tracks.map((t) => t.path), backupDir: BACKUPS });
    if (!lib.crates.includes(result.fullName)) lib.crates = [...lib.crates, result.fullName].sort((a, b) => a.localeCompare(b));
    return { ...result, tracks: tracks.length, seratoRunning: await seratoRunning() };
  },

  'GET /api/presets': async () => ({ presets: readPresets() }),

  // Upsert: pass an id to update that preset, otherwise a new one is created.
  'POST /api/presets': async ({ id, name, prompt, intent, set }) => {
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) return [400, { error: 'Give the search a name' }];
    if (!intent?.buckets) return [400, { error: 'Nothing to save yet' }];
    const list = readPresets();
    const now = new Date().toISOString();
    let preset = id && list.find((p) => p.id === id);
    // A recipe = brief + settings + the exact tracks (ids in play order, with their pillar).
    const tracks = Array.isArray(set) ? set.filter((it) => it && typeof it.id === 'string').map((it) => ({ id: it.id, bucket: Number(it.bucket) || 0 })) : undefined;
    if (preset) Object.assign(preset, { name: cleanName, prompt, intent, set: tracks, updated: now });
    else {
      preset = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: cleanName, prompt, intent, set: tracks, created: now, updated: now };
      list.push(preset);
    }
    writePresets(list);
    return { preset, presets: list };
  },

  'POST /api/presets/rename': async ({ id, name }) => {
    const cleanName = String(name || '').trim().slice(0, 80);
    if (!cleanName) return [400, { error: 'Give the recipe a name' }];
    const list = readPresets();
    const preset = list.find((p) => p.id === id);
    if (!preset) return [404, { error: 'Recipe not found' }];
    Object.assign(preset, { name: cleanName, updated: new Date().toISOString() });
    writePresets(list);
    return { preset, presets: list };
  },

  'POST /api/presets/delete': async ({ id }) => {
    const list = readPresets().filter((p) => p.id !== id);
    writePresets(list);
    return { presets: list };
  },

  'POST /api/reload': async () => {
    reload();
    return { stats: lib.stats };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/audio\/([0-9a-f]{12})$/))) {
      const t = lib.byId.get(m[1]);
      return t ? streamAudio(req, res, t.file) : send(res, 404, { error: 'Unknown track' });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/track\/([0-9a-f]{12})\/serato$/))) {
      const t = lib.byId.get(m[1]);
      return t ? send(res, 200, readSeratoTags(t.file)) : send(res, 404, { error: 'Unknown track' });
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await handler(body, url);
      return Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

reload();
loadChartData();
server.listen(PORT, HOST, () => console.log(`Party Planner running at http://localhost:${PORT}`));
refreshChartData(false).catch((e) => console.error('Chart refresh failed:', e.message));
