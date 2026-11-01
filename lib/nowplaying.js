// "Now playing" from Serato's own log. Serato only writes History/Sessions files when a session
// ends, but its running log (Logs/DJ.INFO -> current .log) records every track load instantly:
//   ... Creating audio cache store resource for 'cache:///Users/.../Song.mp3:deck_0_instrumental?...'
// deck_0 is Deck 1. The last session file is still used to show what was loaded last time.
// Plus next-track suggestions seeded from that track (or any track you pick).
import fs from 'node:fs';
import path from 'node:path';
import { chunks, utf16, normPath, SERATO_DIR } from './serato.js';
import { parsePrompt, chartStrength } from './planner.js';
import { keywordText, songKey } from './library.js';
import { combine, normalizeDials } from './dials.js';
import { GENRES, keyDistance, matchGenres, matchEras } from './genres.js';

const SESSIONS = path.join(SERATO_DIR, 'History', 'Sessions');
const F = { path: 2, title: 6, artist: 7, start: 28, end: 29, deck: 31, played: 50 };
const LIVE_WINDOW_MS = 6 * 3600 * 1000; // a log untouched for 6h isn't "live"
const LOGS = path.join(SERATO_DIR, 'Logs');
const LOG_TAIL_BYTES = 16 * 1024 * 1024; // first read of a long-running log: only the recent part
const TIME_RE = /^I(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
// First load of a file this session: has the deck.
const CACHE_RE = /Creating audio cache store resource for 'cache:\/\/(\/.+?):deck_(\d+)_/;
// Every load (including re-loads of cached files): no deck.
const LOADED_RE = /SetSongAsRecentlyPlayed\(\), Writing metadata for file:\/\/(\/.+)$/;

let logState = { file: null, offset: 0, partial: '', decks: new Map(), loads: [], seen: new Map(), pending: [] };

function currentLog() {
  try { return fs.realpathSync(path.join(LOGS, 'DJ.INFO')); } catch { /* fall through */ }
  let best = null;
  for (const name of fs.readdirSync(LOGS)) {
    if (!name.endsWith('.log')) continue;
    const mtime = fs.statSync(path.join(LOGS, name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { file: path.join(LOGS, name), mtime };
  }
  return best?.file || null;
}

const decodeLogPath = (p) => { try { return decodeURI(p); } catch { return p; } };

function setDeck(deck, p, time) {
  if (logState.decks.get(deck)?.path === p) return;
  const entry = { deck, path: p, start: time };
  logState.decks.set(deck, entry);
  logState.loads.push(entry);
}

// Resolve loads that had no deck: if a cache line for the same file showed up within 3s it's
// already placed; otherwise (a re-load of a cached file) put it on the deck loaded longest ago.
function settlePending(now) {
  logState.pending = logState.pending.filter((ev) => {
    const cached = logState.seen.get(ev.path);
    if (cached !== undefined && Math.abs(cached - ev.time) <= 3) return false;
    if (now - ev.time < 3) return true; // wait briefly for a late cache line
    const onDeck = [...logState.decks.values()].find((d) => d.path === ev.path);
    if (onDeck) { onDeck.start = ev.time; return false; }
    const decks = [...logState.decks.values()].sort((a, b) => a.start - b.start);
    const target = decks.length >= 2 ? decks[0].deck : decks.length === 1 ? (decks[0].deck === 1 ? 2 : 1) : 1;
    setDeck(target, ev.path, ev.time);
    return false;
  });
}

// Incrementally reads new log lines since the last call.
function readLog() {
  const file = currentLog();
  if (!file) return logState;
  const { size, mtimeMs } = fs.statSync(file);
  if (file !== logState.file || size < logState.offset) {
    logState = { file, offset: Math.max(0, size - LOG_TAIL_BYTES), partial: '', decks: new Map(), loads: [], seen: new Map(), pending: [] };
  }
  logState.mtime = mtimeMs;
  if (size <= logState.offset) {
    settlePending(Date.now() / 1000);
    return logState;
  }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - logState.offset);
  fs.readSync(fd, buf, 0, buf.length, logState.offset);
  fs.closeSync(fd);
  logState.offset = size;
  const lines = (logState.partial + buf.toString('utf8')).split('\n');
  logState.partial = lines.pop();
  for (const line of lines) {
    const cache = line.includes('Creating audio cache store resource') && line.match(CACHE_RE);
    const loaded = !cache && line.includes('SetSongAsRecentlyPlayed') && line.match(LOADED_RE);
    if (!cache && !loaded) continue;
    const t = line.match(TIME_RE);
    const time = t ? new Date(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]).getTime() / 1000 : Date.now() / 1000;
    settlePending(time); // place earlier deck-less loads in log order, before this line
    if (cache) {
      const p = normPath(decodeLogPath(cache[1]));
      setDeck(Number(cache[2]) + 1, p, time);
      logState.seen.set(p, time);
    } else {
      // Deck unknown yet: the matching cache line (if any) may come just before or after.
      logState.pending.push({ path: normPath(decodeLogPath(loaded[1])), time });
    }
  }
  settlePending(Date.now() / 1000);
  return logState;
}

let cache = { file: null, mtime: 0, entries: [] };

function newestSession() {
  let best = null;
  for (const name of fs.readdirSync(SESSIONS)) {
    if (!name.endsWith('.session')) continue;
    const mtime = fs.statSync(path.join(SESSIONS, name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { name, mtime };
  }
  return best;
}

function readSession(file) {
  const entries = [];
  for (const [tag, data] of chunks(fs.readFileSync(file))) {
    if (tag !== 'oent') continue;
    for (const [k, adat] of chunks(data)) {
      if (k !== 'adat') continue;
      const e = {};
      for (const [, v, id] of chunks(adat)) {
        if (id === F.path) e.path = normPath(utf16(v));
        else if (id === F.title) e.title = utf16(v);
        else if (id === F.artist) e.artist = utf16(v);
        else if ((id === F.start || id === F.end || id === F.deck) && v.length >= 4) e[id === F.start ? 'start' : id === F.end ? 'end' : 'deck'] = v.readUInt32BE(0);
        else if (id === F.played) e.played = v[0] === 1;
      }
      if (e.path) entries.push(e);
    }
  }
  return entries.sort((a, b) => (a.start || 0) - (b.start || 0));
}

export function nowPlaying(lib, resolvePath) {
  const toTrack = (p) => lib.byPath.get(resolvePath(p)) || null;
  let log = null;
  try { log = readLog(); } catch { /* no logs readable */ }
  if (log?.decks.size && Date.now() - log.mtime < LIVE_WINDOW_MS) {
    const decks = [...log.decks.values()].sort((a, b) => a.deck - b.deck).map((e) => {
      const t = toTrack(e.path);
      return { deck: e.deck, title: t?.title || path.basename(e.path), artist: t?.artist || '', start: e.start, track: t };
    });
    const current = [...decks].sort((a, b) => b.start - a.start)[0];
    const played = new Set(log.loads.map((e) => toTrack(e.path)?.songKey).filter(Boolean));
    return { live: true, source: 'log', sessionUpdated: new Date(log.mtime).toISOString(), decks, current, played, count: log.loads.length };
  }

  // Not playing: show what was loaded at the end of the last saved session.
  let newest;
  try { newest = newestSession(); } catch (e) { return { live: false, decks: [], error: e.code || e.message }; }
  if (!newest) return { live: false, decks: [] };
  const file = path.join(SESSIONS, newest.name);
  if (cache.file !== file || cache.mtime !== newest.mtime) cache = { file, mtime: newest.mtime, entries: readSession(file) };
  const decks = new Map();
  for (const e of cache.entries) if (e.deck) decks.set(e.deck, e);
  const deckList = [...decks.entries()].sort(([a], [b]) => a - b).map(([deck, e]) => ({
    deck, title: e.title, artist: e.artist, start: e.start, track: toTrack(e.path),
  }));
  return { live: false, source: 'session', sessionUpdated: new Date(newest.mtime).toISOString(), decks: deckList, current: null, played: new Set(), count: cache.entries.length };
}

const UP_RE = /\b(harder|hype|up|bang\w*|turn (it )?up|faster|energy|heat|crank|go off)\b/;
const DOWN_RE = /\b(chill|slow|down|mellow|smooth|calm|easy|cool (it )?off|wind down)\b/;
const STOP = new Set('a an the and or of to for with into some more less go keep it this that same vibe something next song track play me like want switch change bring back get chart charts charted charting billboard hits hit only just'.split(' '));

// Ranks next-track candidates for `seed`. `text` is optional: genre/era words steer the target
// ("switch to house", "throwbacks"), energy words nudge up/down, other words become priority keywords.
// Badly tagged loads ("Instrumentals - Kanye West - Cant Tell Me Nothing", no artist/genre/year)
// borrow genre/year/energy from the proper version of the same song in the library.
function seedProfile(lib, seed) {
  if (!seed || (Object.keys(seed.genres).length && seed.year)) return seed;
  let key = seed.songKey;
  if (!seed.artist) {
    const parts = seed.title.replace(/^(instrumentals?|acapellas?|accapellas?)\s*-\s*/i, '').split(/\s+-\s+/);
    if (parts.length >= 2) key = songKey(parts[0], parts.slice(1).join(' - '));
  }
  const versions = lib.tracks.filter((t) => t.songKey === key && t.id !== seed.id);
  const donor = versions.sort((a, b) => Object.keys(b.genres).length - Object.keys(a.genres).length || b.popularity - a.popularity)[0];
  if (!donor) return seed;
  return { ...seed, songKey: key, genres: Object.keys(seed.genres).length ? seed.genres : donor.genres, year: seed.year || donor.year, energy: seed.energy ?? donor.energy, bpm: seed.bpm || donor.bpm, key: seed.key || donor.key, path: seed.path };
}

function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5) >>> 0) / 4294967296;
}

// Shuffle: draw `limit` from the top POOL candidates, weighted toward stronger fits (no replacement),
// so each press varies the list without dropping into weak matches. `avoid` = ids shown last time.
const SHUFFLE_POOL = 75;
function weightedDraw(ranked, limit, seed, avoid) {
  const rand = rng(seed);
  // Only the best-matching candidates are eligible, so shuffles never leave the lane; within them
  // the draw is weighted by score, which already reflects the dials (hits, plays, tempo...).
  const top = ranked.slice(0, SHUFFLE_POOL);
  const floor = (top[0]?.s || 0) * 0.2;
  const pool = top.filter((c) => c.s >= floor)
    .map((c) => ({ c, w: Math.pow(c.s, 1.5) * (avoid.has(c.t.id) ? 0.15 : 1) }));
  const out = [];
  while (out.length < limit && pool.length) {
    let r = rand() * pool.reduce((a, p) => a + p.w, 0);
    let i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    out.push(pool.splice(i, 1)[0].c);
  }
  return out.sort((a, b) => b.s - a.s);
}

export function suggestNext(lib, rawSeed, text = '', { exclude = new Set(), limit = 25, shuffle = 0, avoid = new Set(), dials: rawDials } = {}) {
  const seed = seedProfile(lib, rawSeed);
  const dials = normalizeDials(rawDials);
  const t0 = String(text || '').toLowerCase();
  const intent = t0.trim() ? parsePrompt(t0) : null;
  const hasGenres = intent?.buckets.some((b) => b.genres.length);
  const target = intent?.buckets[0] || { genres: [], eras: [] };
  const eras = intent ? intent.buckets.flatMap((b) => b.eras) : [];
  const dir = UP_RE.test(t0) ? 1.5 : DOWN_RE.test(t0) ? -1.5 : 0;
  const genreWords = new Set((intent?.buckets || []).flatMap((b) => b.genres));
  // Leftover runs of words (not genre, decade, energy or filler) become priority keyword phrases:
  // "bay area throwbacks" -> "bay area".
  const keywords = [];
  let run = [];
  for (const w of t0.replace(/[^a-z0-9&' -]+/g, ' ').split(/\s+/)) {
    const keep = w.length > 1 && !STOP.has(w) && !UP_RE.test(w) && !DOWN_RE.test(w) && !matchGenres(w).length && !matchEras(w).length && !/^(hip|hop)$/.test(w);
    if (keep) run.push(w);
    else if (run.length) { keywords.push(run.join(' ')); run = []; }
  }
  if (run.length) keywords.push(run.join(' '));
  const seedEnergy = seed?.energy ?? null;
  const seedTitle = seed ? keywordText(seed.songKey.split('|')[1] || '') : '';
  // Asking for a genre the current track isn't in = a deliberate switch, so tempo can jump.
  const switching = hasGenres && seed && ![...genreWords].some((g) => (seed.genres[g] || 0) >= 0.5);
  const seedYear = seed?.year ?? null;
  const out = [];

  for (const t of lib.tracks) {
    if (t.acapella || t.instrumental || t.djTool) continue;
    if (seed && (t.id === seed.id || t.songKey === seed.songKey)) continue;
    // Other versions of the deck's song filed under another artist ("VA - Juvenile - Back That Thang Up").
    if (seedTitle.length >= 6 && keywordText(t.title).includes(seedTitle)) continue;
    if (exclude.has(t.songKey)) continue;
    const why = [];
    // Hard constraints from typed text ("switch to house", "90s") multiply in directly; everything
    // else is a 0..1 signal whose influence is set by its dial (lib/dials.js).
    let s = 1;
    const chart = chartStrength(t, { eras: [] });
    if (t.billboard && t.billboard.peak <= 20) why.push(`Hot 100 #${t.billboard.peak}`);
    else if (t.itunes) why.push(`iTunes #${t.itunes.best}`);
    if (t.popularity >= 0.7) why.push(`your plays ${Math.round(t.popularity * 100)}`);

    const factors = {
      hits: 0.1 + 0.9 * chart,
      plays: 0.1 + 0.9 * t.popularity,
      tempo: 1,
      lane: 1,
      era: 1,
      transitions: 1,
    };

    if (seed) {
      const proven = lib.transitions.get(seed.path)?.get(t.path) || 0;
      factors.transitions = proven ? Math.min(1, 0.6 + 0.2 * Math.log1p(proven)) : 0.35;
      if (proven) why.push(`★ you've played this next ${proven}×`);
    }

    if (hasGenres) {
      // Genre fit, discounted when the tempo is atypical for that genre (a 95 BPM "house" crate tag).
      const fit = Math.max(0, ...intent.buckets.flatMap((b) => b.genres).map((g) => {
        const f = t.genres[g] || 0;
        const ranges = GENRES[g]?.bpm;
        return ranges && t.bpm && !ranges.some(([lo, hi]) => t.bpm >= lo && t.bpm <= hi) ? f * 0.15 : f;
      }));
      if (!fit) continue;
      s *= fit;
    } else if (seed) {
      const shared = Object.keys(seed.genres).reduce((a, g) => a + Math.min(seed.genres[g], t.genres[g] || 0), 0);
      factors.lane = 0.2 + 0.8 * Math.min(1, shared);
      if (shared >= 0.5) why.push('same lane');
    }

    if (eras.length) {
      if (!t.year) s *= 0.15;
      else {
        const d = Math.min(...eras.map(([a, b]) => (t.year < a ? a - t.year : t.year > b ? t.year - b : 0)));
        if (d > 2) continue;
        s *= d === 0 ? 1 : 0.4;
      }
    } else if (seedYear) {
      factors.era = t.year ? Math.max(0.05, Math.exp(-Math.abs(t.year - seedYear) / 8)) : 0.5;
    }

    if (seedEnergy != null && t.energy != null) s *= 1 / (1 + 0.25 * Math.abs(t.energy - (seedEnergy + dir)));
    else if (dir && seed?.bpm && t.bpm) s *= (t.bpm - seed.bpm) * dir > 0 ? 1.2 : 0.85; // no energy tags: BPM direction as a hint

    // Tempo: closer is better; half/double time counts as a full match. "go harder"/"slow it down"
    // shifts the target a few percent; an explicit genre switch relaxes it.
    let bpmDelta = null;
    let half = false;
    if (seed?.bpm && t.bpm) {
      const targetBpm = seed.bpm * (dir > 0 ? 1.03 : dir < 0 ? 0.97 : 1);
      const options = [t.bpm, t.bpm * 2, t.bpm / 2];
      const closest = options.reduce((a, x) => (Math.abs(x - targetBpm) < Math.abs(a - targetBpm) ? x : a));
      const gap = Math.abs(closest - targetBpm) / targetBpm;
      factors.tempo = switching ? Math.exp(-Math.max(0, gap - 0.02) / 0.15) : Math.exp(-gap / 0.05) * (gap > 0.08 ? 0.5 : 1);
      half = closest !== t.bpm;
      const delta = closest - seed.bpm;
      bpmDelta = +delta.toFixed(1);
      why.unshift(closest !== t.bpm ? `${Math.round(t.bpm)} BPM (half/double)` : Math.abs(delta) < 0.5 ? 'same BPM' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} BPM`);
    } else if (seed?.bpm) {
      factors.tempo = 0.25; // unknown tempo is a risk mid-set
    }
    if (seed?.key && t.key) s *= 1 / (1 + 0.05 * keyDistance(seed.key, t.key));
    s *= combine(factors, dials);

    const hits = keywords.filter((w) => t.hay.includes(keywordText(w))).length;
    if (keywords.length && hits) { s *= 1 + 0.8 * hits; why.push(`matches "${keywords.filter((w) => t.hay.includes(keywordText(w))).join('", "')}"`); }
    if (intent?.charts && intent.charts !== 'off') {
      const c = chartStrength(t, { eras });
      if (intent.charts === 'only' && !c) continue;
      s *= 1 + 2 * c;
    }
    out.push({ t, s, why, bpmDelta, half, factors });
  }

  // One version per song.
  const best = new Map();
  for (const c of out) {
    const cur = best.get(c.t.songKey);
    if (!cur || c.s > cur.s) best.set(c.t.songKey, c);
  }
  return {
    parsed: { genres: [...genreWords], eras, energy: dir > 0 ? 'up' : dir < 0 ? 'down' : null, keywords },
    results: shuffle
      ? weightedDraw([...best.values()].sort((a, b) => b.s - a.s), limit, shuffle, avoid)
      : [...best.values()].sort((a, b) => b.s - a.s).slice(0, limit),
  };
}
