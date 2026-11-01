// Dials: how much each signal matters when picking tracks. 0 = ignore it, 50 = normal weight,
// 100 = lean on it hard. Each signal is scored 0..1 per track and the dial sets its exponent,
// so dials scale influence without any one signal being able to zero a track by itself (except at 100).
export const DIALS = [
  { id: 'tempo', label: 'Tempo', hint: 'BPM close to the deck (half/double time counts)', def: 60 },
  { id: 'hits', label: 'Hits', hint: 'Chart history: Billboard peak and weeks, current iTunes rank', def: 50 },
  { id: 'plays', label: 'Your plays', hint: 'Tracks you actually play: sessions, Serato play count, crates', def: 55 },
  { id: 'lane', label: 'Same lane', hint: "Sharing the deck's genre", def: 60 },
  { id: 'era', label: 'Era', hint: "Release year close to the deck's", def: 55 },
  { id: 'transitions', label: 'Your transitions', hint: "Tracks you've played right after this one before", def: 50 },
];

const DEFAULTS = Object.fromEntries(DIALS.map((d) => [d.id, d.def]));

export const PRESETS = {
  balanced: { label: 'Balanced', dials: DEFAULTS },
  hits: { label: 'Hits', dials: { tempo: 50, hits: 95, plays: 35, lane: 40, era: 30, transitions: 25 } },
  mine: { label: 'My staples', dials: { tempo: 50, hits: 25, plays: 95, lane: 60, era: 40, transitions: 75 } },
  tight: { label: 'Tight mix', dials: { tempo: 95, hits: 40, plays: 40, lane: 85, era: 50, transitions: 70 } },
  open: { label: 'Switch it up', dials: { tempo: 40, hits: 60, plays: 40, lane: 10, era: 10, transitions: 20 } },
};

export function normalizeDials(d = {}) {
  const out = {};
  for (const { id, def } of DIALS) {
    const v = Number(d?.[id]);
    out[id] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : def;
  }
  return out;
}

// 50 -> exponent 0.75 (the weight these signals had before dials existed), 100 -> 1.5, 0 -> off.
const exponent = (v) => (v / 100) * 1.5;

export function combine(factors, dials) {
  let s = 1;
  for (const [id, f] of Object.entries(factors)) s *= Math.pow(Math.max(1e-4, f), exponent(dials[id] ?? 50));
  return s;
}
