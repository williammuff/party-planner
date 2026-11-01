// Builds an enriched, in-memory view of the Serato library. Serato's own metadata is
// sparse and inconsistent, so every derived field records where it came from (shown in the UI).
import crypto from 'node:crypto';
import path from 'node:path';
import { readDatabase, readCrates, readHistory } from './serato.js';
import { matchGenres, matchEras, yearOf, toCamelot } from './genres.js';

const GENRE_WEIGHT = { tag: 3, grouping: 2, comment: 2, folder: 1.5, crate: 1 };
const ACAPELLA_RE = /\b(acca|acap|acapella|a ?cappella|acappella)\b/i;
const INSTRUMENTAL_RE = /\b(instrumental|instr|inst)\b/i;
// DJ tools: scratch tracks, battle breaks, drops, SFX, skits. Deliberately not bare "scratch"
// (the Chicken Scratch remix series) or "interlude" (real songs like Jay-Z's PSA).
const TOOL_TITLE_RE = /\b(scratch (track|sentence|tool|sample|record|loop)s?|battle (break|tool|record|weapon)s?|dj tools?|sound ?effects?|sfx|air ?horns?|test tone|skits?|beat juggle)\b/i;
const TOOL_META_RE = /\b(dj tools?|scratch (tracks?|samples?|sentences?|records?|tools?)|battle (breaks?|tools?|weapons?)|sound ?effects?|sfx|dj drops?|air ?horns?|one ?shots?)\b/i;
const TOOL_FOLDER_RE = /^(tools|samples|fx|sfx|drops|dj drops|scratch|scratches)$/i;
const VERSION_RE = /[([{][^)\]}]*[)\]}]|\s-\s.*$/g;
const CLEAN_RE = /\b(clean|radio edit|radio version)\b/i;
const DIRTY_RE = /\b(dirty|explicit)\b/i;
// Sessions bigger than this are automation/analysis runs, not DJ sets.
const BIG_SESSION = 400;

const idOf = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);

export function primaryArtist(a) {
  return String(a || '')
    .toLowerCase()
    .split(/\s+(?:feat\.?|ft\.?|featuring|x|vs\.?|&|and|with)\s+|,/)[0]
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function keywordText(s) {
  return ` ${String(s || '').toLowerCase().replace(/[.']/g, '').replace(/[^a-z0-9&]+/g, ' ').trim()} `;
}

export function songKey(artist, title) {
  const t = String(title || '').toLowerCase().replace(VERSION_RE, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${primaryArtist(artist)}|${t}`;
}

function lengthSeconds(s) {
  const m = String(s || '').match(/^(\d+):(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function folderText(p) {
  // Drop "Users/<name>/Music" and the filename; what's left is the user's folder taxonomy.
  return p.split('/').slice(3, -1).join(' / ');
}

function folderYear(p) {
  // Record-pool download folders ("Franchise/June2012", "2022_04_28") approximate release year.
  for (const seg of p.split('/').slice(3, -1).reverse()) {
    const m = seg.match(/(?:^|[^0-9])(19[89]\d|20[0-3]\d)(?:[^0-9]|$)/);
    if (m) return Number(m[1]);
  }
  return null;
}

export function loadLibrary() {
  const started = Date.now();
  const raw = readDatabase();
  const crates = readCrates();
  const sessions = readHistory();

  const cratesByPath = new Map();
  for (const c of crates) {
    for (const p of c.paths) {
      if (!cratesByPath.has(p)) cratesByPath.set(p, []);
      cratesByPath.get(p).push(c.name);
    }
  }

  // History paths go stale when folders get reorganised, so fall back to a unique filename match.
  const livePaths = new Set(raw.map((r) => r.pfil.replace(/^\/+/, '')));
  const byBasename = new Map();
  for (const p of livePaths) {
    const b = path.basename(p).toLowerCase();
    byBasename.set(b, byBasename.has(b) ? null : p);
  }
  const resolved = new Map();
  const resolve = (p) => {
    if (livePaths.has(p)) return p;
    if (!resolved.has(p)) resolved.set(p, byBasename.get(path.basename(p).toLowerCase()) || p);
    return resolved.get(p);
  };
  for (const s of sessions) for (const e of s) e.path = resolve(e.path);

  // Play stats: distinct sessions a track appeared in (weighted down for giant sessions),
  // plus back-to-back transitions from real-length sets.
  const plays = new Map();
  const transitions = new Map();
  for (const s of sessions) {
    const w = s.length > BIG_SESSION ? BIG_SESSION / s.length : 1;
    const seen = new Set();
    for (let i = 0; i < s.length; i++) {
      const { path: p, start } = s[i];
      if (!seen.has(p)) {
        seen.add(p);
        const st = plays.get(p) || { score: 0, sessions: 0, last: 0 };
        st.score += w;
        st.sessions += 1;
        st.last = Math.max(st.last, start || 0);
        plays.set(p, st);
      }
      const next = s[i + 1];
      if (s.length <= BIG_SESSION && next && next.path !== p && start && next.start) {
        const gap = next.start - start;
        if (gap >= 60 && gap <= 900) {
          if (!transitions.has(p)) transitions.set(p, new Map());
          const m = transitions.get(p);
          m.set(next.path, (m.get(next.path) || 0) + 1);
        }
      }
    }
  }

  const tracks = [];
  for (const r of raw) {
    if (r.bmis) continue; // Serato already knows the file is missing
    const p = r.pfil.replace(/^\/+/, '');
    const crateNames = cratesByPath.get(p) || [];
    const t = {
      id: idOf(p),
      path: p,
      file: `/${p}`,
      ext: path.extname(p).slice(1).toLowerCase(),
      title: r.tsng || path.basename(p, path.extname(p)),
      artist: r.tart || '',
      album: r.talb || '',
      genreTag: r.tgen || '',
      comment: r.tcom || '',
      grouping: r.tgrp || '',
      label: r.tlbl || '',
      bpm: Number(r.tbpm) || null,
      key: toCamelot(r.tkey) || toCamelot((r.tcom || '').split(/\s*-\s*/)[0]),
      length: lengthSeconds(r.tlen),
      added: r.uadd || Number(r.tadd) || 0,
      crates: crateNames,
      // Serato's Play Count column. Values over 999 are junk some taggers write (they look like years).
      playCount: r.utpc > 0 && r.utpc < 1000 ? r.utpc : 0,
      plays: plays.get(p)?.sessions || 0,
      playScore: plays.get(p)?.score || 0,
      lastPlayed: plays.get(p)?.last || 0,
    };
    const energy = t.comment.match(/energy\s*(\d{1,2})/i);
    t.energy = energy ? Math.min(10, Number(energy[1])) : null;

    const allText = `${t.title} ${t.genreTag} ${t.comment} ${p}`;
    t.acapella = ACAPELLA_RE.test(allText) || /\/acapellas?\//i.test(p);
    t.instrumental = !t.acapella && INSTRUMENTAL_RE.test(`${t.title} ${t.genreTag} ${t.comment}`);
    t.djTool = TOOL_TITLE_RE.test(t.title)
      || TOOL_META_RE.test(`${t.genreTag} ${t.comment} ${t.grouping} ${t.album}`)
      || p.split('/').slice(3, -1).some((seg) => TOOL_META_RE.test(seg) || TOOL_FOLDER_RE.test(seg.trim()));
    t.clean = CLEAN_RE.test(t.title) || /\bclean\b/i.test(path.basename(p));
    t.dirty = DIRTY_RE.test(t.title) || /\b(dirty|explicit)\b/i.test(path.basename(p));
    t.songKey = songKey(t.artist, t.title);
    // Searchable text for pillar keywords (punctuation-insensitive, includes crates and folders).
    t.hay = keywordText([t.artist, t.title, t.album, t.genreTag, t.comment, t.grouping, t.label, ...crateNames.map((c) => c.split('%%').pop()), p.split('/').slice(3, -1).join(' ')].join(' '));

    // Genre votes from every place a genre hint can hide.
    const votes = {};
    const sources = {};
    const vote = (text, src) => {
      for (const g of matchGenres(text)) {
        votes[g] = (votes[g] || 0) + GENRE_WEIGHT[src];
        (sources[g] ||= new Set()).add(src);
      }
    };
    vote(t.genreTag, 'tag');
    vote(t.grouping, 'grouping');
    vote(t.comment, 'comment');
    vote(folderText(p), 'folder');
    for (const c of crateNames) vote(c.split('%%').pop(), 'crate');
    t._votes = votes;
    t._genreSources = sources;

    // Era hints from text (genre "60's classic oldies", crate "90s Hip Hop", ...)
    const eraText = [t.genreTag, t.grouping, ...crateNames.map((c) => c.split('%%').pop())].join(' | ');
    t._textEra = matchEras(eraText)[0] || null;
    t._yearTag = yearOf(r.ttyr);
    t._folderYear = folderYear(p);
    tracks.push(t);
  }

  // Cross-track inference: earliest tagged year per song (pools re-tag old songs with the
  // pool date), artist median year, artist's dominant genres.
  const songYear = new Map();
  const artistYears = new Map();
  const artistGenres = new Map();
  for (const t of tracks) {
    if (t._yearTag) {
      songYear.set(t.songKey, Math.min(songYear.get(t.songKey) ?? 9999, t._yearTag));
      const a = primaryArtist(t.artist);
      if (a) (artistYears.get(a) || artistYears.set(a, []).get(a)).push(t._yearTag);
    }
    const a = primaryArtist(t.artist);
    if (a && Object.keys(t._votes).length) {
      const m = artistGenres.get(a) || artistGenres.set(a, {}).get(a);
      for (const [g, v] of Object.entries(t._votes)) m[g] = (m[g] || 0) + v;
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

  for (const t of tracks) {
    const a = primaryArtist(t.artist);
    const sy = songYear.get(t.songKey);
    if (sy && sy !== 9999) {
      t.year = sy;
      t.yearSrc = sy === t._yearTag ? 'tag' : 'other version';
    } else if (artistYears.get(a)?.length) {
      t.year = median(artistYears.get(a));
      t.yearSrc = 'artist';
    } else if (t._textEra) {
      t.year = Math.round((t._textEra[0] + t._textEra[1]) / 2);
      t.yearSrc = 'genre/crate text';
    } else if (t._folderYear) {
      t.year = t._folderYear;
      t.yearSrc = 'folder date';
    } else {
      t.year = null;
      t.yearSrc = null;
    }

    let votes = t._votes;
    let genreSrc = Object.fromEntries(Object.entries(t._genreSources).map(([g, s]) => [g, [...s]]));
    if (!Object.keys(votes).length && artistGenres.get(a)) {
      votes = artistGenres.get(a);
      genreSrc = Object.fromEntries(Object.keys(votes).map((g) => [g, ['artist']]));
    }
    const max = Math.max(0, ...Object.values(votes));
    t.genres = {};
    for (const [g, v] of Object.entries(votes)) if (v / max >= 0.34) t.genres[g] = +(v / max).toFixed(2);
    t.genreSrc = genreSrc;
    delete t._votes;
    delete t._genreSources;
    delete t._textEra;
    delete t._yearTag;
    delete t._folderYear;
  }

  const byId = new Map(tracks.map((t) => [t.id, t]));
  const byPath = new Map(tracks.map((t) => [t.path, t]));
  // Normalise against the 99th percentile so a few outliers don't flatten everyone else.
  const p99 = (xs) => {
    const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
    return Math.max(1, s[Math.floor(s.length * 0.99)] || 1);
  };
  const norm = (x, top) => Math.min(1, Math.log1p(x) / Math.log1p(top));
  const topHistory = p99(tracks.map((t) => t.playScore));
  const topCount = p99(tracks.map((t) => t.playCount));
  const maxCrates = Math.max(1, ...tracks.map((t) => t.crates.length));
  for (const t of tracks) {
    // Local "crowd pleaser" proxy. Serato's play count gets cleared and history paths go stale,
    // so take whichever play signal is stronger (a cleared count doesn't penalise), plus a bonus
    // when both agree, plus how many crates the track lives in.
    const h = norm(t.playScore, topHistory);
    const c = norm(t.playCount, topCount);
    const played = Math.min(1, Math.max(h, c) + 0.25 * Math.min(h, c));
    const k = norm(t.crates.length, maxCrates);
    t.popularity = +(0.75 * played + 0.25 * k).toFixed(3);
    // Component scores (0-100) so the UI can explain the number.
    t.pop = { score: Math.round(t.popularity * 100), history: Math.round(h * 100), playCount: Math.round(c * 100), crates: Math.round(k * 100) };
  }
  // Percentile within the library ("top 4%"), ties share the better rank.
  const sortedPop = tracks.map((t) => t.popularity).sort((a, b) => b - a);
  const firstIndex = new Map();
  sortedPop.forEach((p, i) => { if (!firstIndex.has(p)) firstIndex.set(p, i); });
  for (const t of tracks) t.pop.top = Math.max(1, Math.ceil((100 * (firstIndex.get(t.popularity) + 1)) / tracks.length));

  return {
    tracks,
    byId,
    byPath,
    resolvePath: resolve, // history path -> current library path (handles moved folders)
    transitions,
    crates: crates.map((c) => c.name).sort((a, b) => a.localeCompare(b)),
    stats: {
      tracks: tracks.length,
      sessions: sessions.length,
      crates: crates.length,
      withGenre: tracks.filter((t) => Object.keys(t.genres).length).length,
      withYear: tracks.filter((t) => t.year).length,
      withEnergy: tracks.filter((t) => t.energy).length,
      withPlayCount: tracks.filter((t) => t.playCount).length,
      djTools: tracks.filter((t) => t.djTool).length,
      loadMs: Date.now() - started,
    },
  };
}
