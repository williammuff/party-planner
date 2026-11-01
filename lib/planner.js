// Turns a free-text party brief into an editable intent, then picks and orders tracks.
// Everything is rule-based and local: prompt keywords -> buckets of (genres, eras, share).
import { GENRES, matchGenres, matchEras, keyDistance } from './genres.js';
import { keywordText, primaryArtist } from './library.js';

const CLEAN_EVENT_RE = /\b(wedding|kids?|school|corporate|family|church|bar mitzvah|bat mitzvah|graduation|clean|radio|no (explicit|cursing|swearing))\b/;
const CHILL_RE = /\b(chill|lounge|dinner|cocktail|mellow|low ?key|background|laid ?back|brunch|sunset|smooth)\b/;
const WARMUP_RE = /\b(warm ?up|opening|opener|early)\b/;
const PEAK_RE = /\b(peak|hype|turn ?up|turnt|rager|banger|bangers|hard|high energy|club)\b/;
const HITS_RE = /\b(hits|crowd ?pleasers?|bangers|anthems|sing ?alongs?|popular|bops|recogni[sz]able|everyone knows)\b/;
const DEEP_RE = /\b(deep cuts?|underground|obscure|rare|b-?sides)\b/;
const HEAVY_RE = /\b(mostly|mainly|primarily|heavy|lots of|vibe|base|foundation|focus)\b/;
const LIGHT_RE = /\b(some|bit of|sprinkle|touch of|few|little|splash|occasional)\b/;
const EXCLUDE_RE = /\b(?:no|without|not|except|avoid|skip|nothing)\s+(.+?)(?=$|[,;.]|\bbut\b|\bwith\b|\bw\/)/g;
const YEAR_CONFIDENCE = { tag: 1, 'other version': 1, artist: 0.75, 'genre/crate text': 0.6, 'folder date': 0.5 };
const MIN_PER_TRACK = 3.5; // open-format DJs rarely play tracks out
const CHART_ONLY_RE = /\b(only|just|strictly)\s+(chart(ed|ing)?|billboard|hot 100|top 40)\b/;
const CHART_RE = /\b(billboard|charts?|chart(ed|ing)|hot 100|top 40 hits|number ones?|#1s?)\b/;

export function parsePrompt(prompt) {
  let s = ` ${String(prompt || '').toLowerCase().replace(/[’`]/g, "'")} `;
  // Protect multi-word genres containing separator words before splitting into clauses.
  s = s
    .replace(/\bw\//g, ' with ')
    .replace(/\bdrum\s*(?:&|and|n'?)\s*bass\b/g, 'dnb')
    .replace(/\br\s*(?:&|and|n)\s*b\b/g, 'rnb')
    .replace(/\brock\s*(?:&|and|n'?)\s*roll\b/g, 'oldies')
    .replace(/\bfunk\s*(?:&|and)\s*soul\b/g, 'funk soul');

  const intent = {
    prompt,
    buckets: [],
    count: 40,
    bpm: null,
    energy: 'build',
    clean: CLEAN_EVENT_RE.test(s),
    popularity: HITS_RE.test(s) ? 'hits' : DEEP_RE.test(s) ? 'deep' : 'balanced',
    exclude: [],
    includeAcapellas: /\b(acapellas?|accas?)\b/.test(s),
    includeInstrumentals: /\binstrumentals?\b/.test(s),
    includeTools: /\b(dj tools?|scratch(es)?|drops|sfx|battle breaks?)\b/.test(s),
    charts: CHART_ONLY_RE.test(s) ? 'only' : CHART_RE.test(s) ? 'boost' : 'off',
    seed: 1,
  };

  // Chart wording is a setting, not a genre: keep "billboard hits" from becoming a Pop pillar.
  s = s.replace(/\b(?:(?:only|just|strictly)\s+)?(?:billboard|charts?|chart(?:ed|ing)|hot 100|number ones?|#1s?)(?:\s+(?:hits|songs|records|tracks))?\b/g, ' ');

  for (const m of s.matchAll(EXCLUDE_RE)) intent.exclude.push(...matchGenres(m[1]));
  s = s.replace(EXCLUDE_RE, ' ');

  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/))) intent.count = Math.round((Number(m[1]) * 60) / MIN_PER_TRACK);
  else if ((m = s.match(/(\d+)\s*(?:m|min|mins|minutes)\b/))) intent.count = Math.round(Number(m[1]) / MIN_PER_TRACK);
  if ((m = s.match(/(\d+)\s*(?:tracks|songs|records)\b/))) intent.count = Number(m[1]);
  intent.count = Math.max(5, Math.min(200, intent.count));

  if ((m = s.match(/(\d{2,3})\s*(?:-|to)\s*(\d{2,3})\s*bpm/))) intent.bpm = [Number(m[1]), Number(m[2])];
  else if ((m = s.match(/(\d{2,3})\s*bpm/))) intent.bpm = [Number(m[1]) - 4, Number(m[1]) + 4];

  if (CHILL_RE.test(s)) intent.energy = 'chill';
  else if (WARMUP_RE.test(s)) intent.energy = 'warmup';
  else if (PEAK_RE.test(s)) intent.energy = 'peak';

  // Clauses keep their separator so we know whether eras carry over ("90s hip hop and r&b")
  // or not ("house with 90s hip hop").
  const parts = s.split(/(\s*,\s*|\s*;\s*|\s+and\s+|\s+&\s+|\s+\+\s+|\s+with\s+|\s+plus\s+|\s+then\s+|\s+into\s+|\s+mixed with\s+)/);
  const clauses = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim();
    if (!text) continue;
    clauses.push({ text, joiner: (parts[i - 1] || '').trim() });
  }

  let pendingEras = [];
  for (const c of clauses) {
    const genres = matchGenres(c.text).filter((g) => !intent.exclude.includes(g));
    const eras = matchEras(c.text);
    const prev = intent.buckets[intent.buckets.length - 1];
    if (!genres.length) {
      if (eras.length && prev) prev.eras.push(...eras);
      else pendingEras.push(...eras);
      continue;
    }
    const weight = (HEAVY_RE.test(c.text) ? 3 : LIGHT_RE.test(c.text) ? 1 : 2) + (intent.buckets.length === 0 ? 0.5 : 0);
    const inherit = !eras.length && prev && prev.ownEras && ['and', '&', ',', '+'].includes(c.joiner) ? prev.eras : [];
    intent.buckets.push({ genres, eras: [...pendingEras, ...eras, ...inherit], weight, ownEras: eras.length > 0 });
    pendingEras = [];
  }
  if (!intent.buckets.length) {
    // No genre words: one open bucket constrained only by era (or nothing).
    intent.buckets.push({ genres: [], eras: pendingEras, weight: 1 });
  } else if (pendingEras.length) {
    intent.buckets.forEach((b) => b.eras.push(...pendingEras));
  }

  // "house and tech house" both resolve to House: merge identical buckets.
  const merged = new Map();
  for (const b of intent.buckets) {
    const key = JSON.stringify([[...b.genres].sort(), mergeRanges(b.eras)]);
    if (merged.has(key)) merged.get(key).weight += b.weight;
    else merged.set(key, b);
  }
  intent.buckets = [...merged.values()];

  const total = intent.buckets.reduce((a, b) => a + b.weight, 0);
  intent.buckets = intent.buckets.map((b) => ({
    genres: b.genres,
    eras: mergeRanges(b.eras),
    share: Math.round((100 * b.weight) / total),
    require: [],
    prefer: [],
    charts: intent.charts, // per pillar; chart words in the brief turn it on everywhere to start
  }));
  return intent;
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

function rng(seed) {
  let x = seed * 2654435761 >>> 0 || 1;
  return () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5) >>> 0) / 4294967296;
}

function bpmFits(bpm, [lo, hi]) {
  return [bpm, bpm * 2, bpm / 2].some((b) => b >= lo && b <= hi);
}

// 0..1 chart signal: Billboard hit strength (era-aware: charting in the pillar's years counts
// fully, outside them only partly) or current iTunes chart position, whichever is stronger.
export function chartStrength(t, bucket) {
  let bb = t.billboard?.score || 0;
  if (bb && bucket.eras?.length && !bucket.eras.some(([a, b]) => t.billboard.year >= a - 1 && t.billboard.year <= b + 1)) bb *= 0.3;
  return Math.max(bb, t.itunes?.score || 0);
}

export function scoreTrack(t, bucket, intent) {
  if (t.acapella && !intent.includeAcapellas) return 0;
  if (t.instrumental && !intent.includeInstrumentals) return 0;
  if (t.djTool && !intent.includeTools) return 0;
  if (intent.exclude.some((g) => (t.genres[g] || 0) >= 0.5)) return 0;
  // Pillar keywords: "must include" = at least one must appear; "priority" = boost per match.
  const has = (k) => { const w = keywordText(k); return w.trim() && t.hay.includes(w); };
  if (bucket.require?.length && !bucket.require.some(has)) return 0;
  const preferHits = (bucket.prefer || []).filter(has).length;
  if (intent.bpm && (!t.bpm || !bpmFits(t.bpm, intent.bpm))) return 0;

  let genre = 1;
  if (bucket.genres.length) {
    // Genre match, softened when the BPM is atypical for that genre (a 110 BPM "house" remix).
    genre = Math.max(0, ...bucket.genres.map((g) => {
      const fit = t.genres[g] || 0;
      const ranges = GENRES[g].bpm;
      return ranges && t.bpm && !ranges.some(([lo, hi]) => t.bpm >= lo && t.bpm <= hi) ? fit * 0.3 : fit;
    }));
  }
  if (!genre) return 0;

  let era = 1;
  if (bucket.eras.length) {
    if (!t.year) era = 0.1;
    else {
      const d = Math.min(...bucket.eras.map(([a, b]) => (t.year < a ? a - t.year : t.year > b ? t.year - b : 0)));
      const fit = d === 0 ? 1 : d === 1 ? 0.45 : d === 2 ? 0.15 : 0;
      const conf = YEAR_CONFIDENCE[t.yearSrc] ?? 0.5;
      era = fit * conf + (fit > 0 ? (1 - conf) * 0.3 : 0);
    }
    if (!era) return 0;
  }

  const pop = t.popularity;
  const popFactor = intent.popularity === 'hits' ? 0.2 + 0.8 * pop : intent.popularity === 'deep' ? 1 - 0.6 * pop : 0.5 + 0.5 * pop;
  let score = genre * era * popFactor * (t.bpm ? 1 : 0.6) * (1 + 0.6 * Math.min(preferHits, 3));
  const chartMode = bucket.charts ?? intent.charts; // older saved searches only have the global setting
  if (chartMode === 'boost' || chartMode === 'only') {
    const c = chartStrength(t, bucket);
    if (chartMode === 'only' && !c) return 0;
    score *= 1 + 2.5 * c;
  }
  if (intent.clean) score *= t.dirty ? 0.05 : t.clean ? 1.3 : 0.8;
  return score;
}

// Energy target (1-10) at a position 0..1 through the set.
function energyTarget(mode, p) {
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  if (mode === 'chill') return 4;
  if (mode === 'peak') return 7 + 1.5 * smooth(0, 0.4, p);
  if (mode === 'warmup') return 3.5 + 2.5 * smooth(0, 1, p);
  return 4.5 + 4 * smooth(0, 0.7, p) - 1.5 * smooth(0.85, 1, p); // build: warm, peak, land
}

function bpmCost(a, b) {
  if (!a || !b) return 1.5;
  const pct = Math.min(...[b, b * 2, b / 2].map((x) => Math.abs(a - x) / a)) * 100;
  return pct / 2;
}

export function transitionInfo(lib, a, b) {
  const proven = lib.transitions.get(a.path)?.get(b.path) || 0;
  const reverse = lib.transitions.get(b.path)?.get(a.path) || 0;
  return {
    bpmDelta: a.bpm && b.bpm ? +(b.bpm - a.bpm).toFixed(1) : null,
    keyDistance: a.key && b.key ? keyDistance(a.key, b.key) : null,
    proven,
    reverse,
  };
}

function cost(lib, prev, t, mode, pos, newBlock) {
  if (!prev) return 0;
  const proven = lib.transitions.get(prev.path)?.get(t.path) || 0;
  const target = energyTarget(mode, pos);
  const energy = t.energy != null ? Math.abs(t.energy - target) * 0.4 : 0.6;
  return bpmCost(prev.bpm, t.bpm) * (newBlock ? 0.3 : 1) + keyDistance(prev.key, t.key) * 0.15 + energy - 2 * Math.log1p(proven);
}

// Orders tracks into genre blocks (DJs mix house into hip hop in runs, not track-by-track),
// interleaving blocks by share and greedily choosing the smoothest next track inside a block.
export function sequence(lib, items, intent) {
  const byBucket = new Map();
  for (const it of items) {
    if (!byBucket.has(it.bucket)) byBucket.set(it.bucket, []);
    byBucket.get(it.bucket).push(it);
  }
  const total = items.length;
  const blockSize = Math.max(3, Math.min(8, Math.round(total / 8)));
  const placed = new Map([...byBucket.keys()].map((k) => [k, 0]));
  const out = [];
  let prev = null;
  let lastBucket = null;

  while (out.length < total) {
    const open = [...byBucket.entries()].filter(([, list]) => list.length);
    // Pick the bucket furthest behind its share; avoid repeating the last block if possible.
    open.sort(([a, la], [b, lb]) => {
      const behind = (k, list) => list.length / (placed.get(k) + list.length) - (k === lastBucket && open.length > 1 ? 1 : 0);
      return behind(b, lb) - behind(a, la);
    });
    const [bucket, list] = open[0];
    const size = Math.min(list.length, open.length === 1 ? list.length : blockSize);
    for (let i = 0; i < size; i++) {
      const pos = out.length / Math.max(1, total - 1);
      let best = 0;
      let bestCost = Infinity;
      for (let j = 0; j < list.length; j++) {
        const t = list[j].track;
        let c = cost(lib, prev, t, intent.energy, pos, i === 0);
        if (!prev) c = Math.abs((t.energy ?? 5) - energyTarget(intent.energy, 0)) + (t.bpm ? t.bpm / 200 : 1);
        if (c < bestCost) { bestCost = c; best = j; }
      }
      const [it] = list.splice(best, 1);
      out.push(it);
      placed.set(bucket, placed.get(bucket) + 1);
      prev = it.track;
    }
    lastBucket = bucket;
  }
  return out;
}

// Picks `want` songs for one pillar. ctx carries what the rest of the set already uses
// (songs, per-artist counts) and `avoid` = songs to skip unless there's nothing else.
function pickForBucket(lib, intent, bucket, bi, want, ctx) {
  const { rand, usedSongs, artistCount, artistCap, avoid = new Set() } = ctx;
  // Best-scoring version of each song (dedupes clean/dirty/intro/remix copies).
  const bestBySong = new Map();
  for (const t of lib.tracks) {
    const s = scoreTrack(t, bucket, intent);
    if (!s) continue;
    const jittered = s * (0.85 + 0.3 * rand());
    const cur = bestBySong.get(t.songKey);
    if (!cur || jittered > cur.score) bestBySong.set(t.songKey, { track: t, score: jittered, bucket: bi });
  }
  let ranked = [...bestBySong.values()].sort((a, b) => b.score - a.score);
  // Boost songs you've actually mixed with other strong candidates, so the set can
  // chain your proven transitions instead of only individually good tracks.
  const shortlist = ranked.slice(0, want * 4);
  const shortPaths = new Set(shortlist.map((c) => c.track.path));
  for (const c of shortlist) {
    let links = 0;
    for (const [to, n] of lib.transitions.get(c.track.path) || []) if (shortPaths.has(to)) links += n;
    for (const o of shortlist) if (lib.transitions.get(o.track.path)?.has(c.track.path)) links += 1;
    if (links) c.score *= 1 + 0.25 * Math.min(links, 4);
  }
  ranked = ranked.sort((a, b) => b.score - a.score);
  const picked = [];
  const pool = [];
  for (const pass of [false, true]) {
    for (const c of ranked) {
      if (picked.length >= want && (pass || pool.length >= 80)) break;
      if (usedSongs.has(c.track.songKey) || avoid.has(c.track.songKey) !== pass) continue;
      const artist = primaryArtist(c.track.artist) || c.track.artist.toLowerCase(); // "Too Short ft E-40" counts as Too Short
      if (picked.length < want && (artistCount.get(artist) || 0) < artistCap) {
        picked.push(c);
        usedSongs.add(c.track.songKey);
        artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
      } else if (!pass && pool.length < 80) {
        pool.push(c);
      }
    }
    if (picked.length >= want || !avoid.size) break; // second pass only re-admits avoided songs
  }
  return { picked, candidates: ranked.length, pool };
}

const artistCapFor = (intent) => Math.max(2, Math.ceil(intent.count / 15));

export function plan(lib, intent) {
  const ctx = { rand: rng(intent.seed || 1), usedSongs: new Set(), artistCount: new Map(), artistCap: artistCapFor(intent) };
  const totalShare = intent.buckets.reduce((a, b) => a + (b.share || 0), 0) || 1;
  const items = [];
  const pools = [];
  intent.buckets.forEach((bucket, bi) => {
    const want = Math.max(1, Math.round((intent.count * (bucket.share || 0)) / totalShare));
    const { picked, candidates, pool } = pickForBucket(lib, intent, bucket, bi, want, ctx);
    items.push(...picked);
    pools.push({ bucket: bi, candidates, ids: pool.map((c) => c.track.id) });
  });
  return { items: sequence(lib, items, intent), pools };
}

// Re-picks one pillar with a new seed, leaving every other track where it is. New picks fill
// the pillar's existing slots, each slot taking the smoothest remaining pick after its neighbour.
export function reshuffleBucket(lib, intent, items, bi, seed) {
  const usedSongs = new Set();
  const artistCount = new Map();
  const avoid = new Set();
  const slots = [];
  items.forEach((it, i) => {
    if (it.bucket === bi) {
      slots.push(i);
      avoid.add(it.track.songKey);
      return;
    }
    usedSongs.add(it.track.songKey);
    const a = primaryArtist(it.track.artist) || it.track.artist.toLowerCase();
    artistCount.set(a, (artistCount.get(a) || 0) + 1);
  });
  const totalShare = intent.buckets.reduce((a, b) => a + (b.share || 0), 0) || 1;
  const want = slots.length || Math.max(1, Math.round((intent.count * (intent.buckets[bi].share || 0)) / totalShare));
  const ctx = { rand: rng(seed), usedSongs, artistCount, artistCap: artistCapFor(intent), avoid };
  const { picked, candidates } = pickForBucket(lib, intent, intent.buckets[bi], bi, want, ctx);

  if (!slots.length) return { items: sequence(lib, [...items, ...picked], intent), candidates };
  const out = [...items];
  const remaining = [...picked];
  for (const slot of slots) {
    if (!remaining.length) {
      out[slot] = null; // fewer matches than slots: the slot is dropped
      continue;
    }
    const prev = out[slot - 1]?.track;
    let best = 0;
    let bestCost = Infinity;
    remaining.forEach((c, j) => {
      const k = cost(lib, prev, c.track, intent.energy, slot / Math.max(1, out.length - 1), out[slot - 1]?.bucket !== bi);
      if (k < bestCost) { bestCost = k; best = j; }
    });
    out[slot] = remaining.splice(best, 1)[0];
  }
  return { items: out.filter(Boolean), candidates };
}

export const GENRE_LIST = Object.entries(GENRES).map(([id, g]) => ({ id, label: g.label }));
