// Canonical genre buckets and the messy strings that map to them (tags, comment codes,
// folder names, crate names, and words in a party prompt all go through the same matcher).
export const GENRES = {
  hiphop: { label: 'Hip Hop', bpm: [[68, 115], [130, 170]], words: ['hip hop', 'hiphop', 'rap', 'hh', 'trap', 'west coast', 'east coast', 'boom bap', 'crunk', 'dirty south', 'gangsta', 'drill', 'hip hop classics', 'old school rap'] },
  rnb: { label: 'R&B', bpm: [[60, 115]], words: ['r&b', 'rnb', 'r and b', 'r n b', 'rb', 'slow jam', 'slow jams', 'neo soul', 'new jack swing', 'urban', 'urban contemporary'] },
  house: { label: 'House', bpm: [[114, 132]], words: ['house', 'tech house', 'deep house', 'afro house', 'progressive house', 'bass house', 'garage', 'uk garage', 'jackin house', 'chicago house', 'disco house', 'funky house'] },
  techno: { label: 'Techno', bpm: [[120, 150]], words: ['techno', 'minimal', 'melodic techno'] },
  edm: { label: 'EDM / Dance', bpm: [[118, 135], [140, 155]], words: ['edm', 'electro', 'big room', 'dance', 'electronic', 'trance', 'festival', 'future bass', 'electro house', 'dance pop'] },
  dubstep: { label: 'Dubstep / Bass', bpm: [[135, 155], [68, 78]], words: ['dubstep', 'riddim', 'brostep', 'bass music', 'trap edm', 'moombah'] },
  dnb: { label: 'Drum & Bass', bpm: [[160, 180], [80, 90]], words: ['drum & bass', 'drum and bass', 'drum n bass', 'dnb', 'd&b', 'jungle', 'liquid'] },
  pop: { label: 'Pop / Top 40', words: ['pop', 'top 40', 'top40', 'chr', 'billboard', 'hits', 'mainstream', 'pop club anthems'] },
  rock: { label: 'Rock', words: ['rock', 'classic rock', 'alternative', 'alt rock', 'grunge', 'punk', 'metal', 'indie', 'indie rock', 'pop punk', 'emo'] },
  country: { label: 'Country', words: ['country', 'bro country', 'country pop', 'americana', 'bluegrass'] },
  latin: { label: 'Latin', bpm: [[85, 110], [120, 130]], words: ['latin', 'reggaeton', 'bachata', 'salsa', 'merengue', 'cumbia', 'dembow', 'moombahton', 'latin pop', 'latin trap'] },
  reggae: { label: 'Reggae / Dancehall', words: ['reggae', 'dancehall', 'soca', 'ska', 'roots reggae'] },
  funk: { label: 'Funk / Soul / Disco', words: ['funk', 'soul', 'disco', 'motown', 'boogie', 'nu disco', 'funk soul'] },
  afro: { label: 'Afrobeats', bpm: [[95, 125]], words: ['afrobeats', 'afrobeat', 'amapiano', 'afropop', 'afro'] },
  club: { label: 'Jersey / Bmore Club', bpm: [[125, 145]], words: ['jersey club', 'baltimore club', 'bmore', 'philly club'] },
  oldies: { label: 'Oldies', words: ['oldies', 'doo wop', 'rock and roll', 'rock n roll', 'classic oldies'] },
  jazz: { label: 'Jazz', words: ['jazz', 'swing', 'big band', 'bossa nova'] },
  blues: { label: 'Blues', words: ['blues'] },
  classical: { label: 'Classical', words: ['classical', 'orchestral', 'soundtrack', 'score'] },
};

// Longest phrases first so "tech house" wins over "house" and "drum & bass" over "bass".
const PHRASES = Object.entries(GENRES)
  .flatMap(([id, g]) => g.words.map((w) => [w, id]))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([w, id]) => [new RegExp(`(^|[^a-z0-9&])${w.replace(/[&]/g, '\\&').replace(/ /g, '[\\s_-]*')}(?=$|[^a-z0-9&])`, 'g'), id]);

export function normText(s) {
  return ` ${String(s || '').toLowerCase().replace(/[()[\]{}|/+.,:;!?"'`]/g, ' ').replace(/\s+/g, ' ')} `;
}

export function matchGenres(text) {
  let s = normText(text);
  const found = new Set();
  for (const [re, id] of PHRASES) {
    if (re.test(s)) {
      found.add(id);
      s = s.replace(re, '$1 ');
    }
    re.lastIndex = 0;
  }
  return [...found];
}

const CURRENT_YEAR = new Date().getFullYear();

// Decade words -> [from, to]. Used for both track metadata and prompts.
const DECADES = [
  [/\b(19)?50'?s\b|\bfifties\b/, 1950],
  [/\b(19)?60'?s\b|\bsixties\b/, 1960],
  [/\b(19)?70'?s\b|\bseventies\b/, 1970],
  [/\b(19)?80'?s\b|\beighties\b/, 1980],
  [/\b(19)?90'?s\b|\bnineties\b/, 1990],
  [/\b2000'?s\b|\b00'?s\b|\baughts\b|\by2k\b/, 2000],
  [/\b2010'?s\b|\b(20)?10'?s\b|\btwenty ?tens\b/, 2010],
  [/\b2020'?s\b/, 2020],
];

export function matchEras(text) {
  const s = String(text || '').toLowerCase().replace(/’/g, "'");
  const eras = [];
  for (const [re, start] of DECADES) if (re.test(s)) eras.push([start, start + 9]);
  if (/\b(new|newest|current|latest|recent|fresh|this year|right now|today'?s)\b/.test(s)) eras.push([CURRENT_YEAR - 2, CURRENT_YEAR + 1]);
  if (/\b(throwbacks?|old school|oldschool|classics?|nostalgi\w*)\b/.test(s)) eras.push([1970, CURRENT_YEAR - 12]);
  return eras;
}

export function yearOf(s) {
  const m = String(s || '').match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  const y = m ? Number(m[1]) : null;
  return y && y <= CURRENT_YEAR + 1 ? y : null;
}

// Musical key -> Camelot (e.g. "Am" -> "8A"). Accepts Camelot, "F#m", "Abmin", "C#maj".
const CAMELOT_MINOR = { 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12 };
const CAMELOT_MAJOR = { B: 1, Cb: 1, 'F#': 2, Gb: 2, Db: 3, 'C#': 3, Ab: 4, 'G#': 4, Eb: 5, 'D#': 5, Bb: 6, 'A#': 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 };

export function toCamelot(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{1,2})\s*([ABab])\b/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${+m[1]}${m[2].toUpperCase()}`;
  m = s.match(/^([A-Ga-g])\s*([#b♯♭]?)\s*(m|min|minor|maj|major)?$/);
  if (!m) return null;
  const note = m[1].toUpperCase() + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]);
  const minor = m[3] && /^m(in|inor)?$/.test(m[3]);
  const n = (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[note];
  return n ? `${n}${minor ? 'A' : 'B'}` : null;
}

// 0 = same key, 1 = adjacent/relative (a clean harmonic mix), higher = clash.
export function keyDistance(a, b) {
  if (!a || !b) return 1.5;
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  const ring = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
  return ring + (a.slice(-1) === b.slice(-1) ? 0 : 1);
}
