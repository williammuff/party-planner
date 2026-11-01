const $ = (id) => document.getElementById(id);
const BUCKET_COLORS = ['#7c3aed', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#ec4899'];
const EXAMPLES = [
  "house vibe w/ hip hop 90's 2000's",
  "90s hip hop and r&b, some reggaeton, 3 hours, crowd pleasers",
  'wedding dinner chill funk & soul then hits',
  'peak time house and tech house 124-128 bpm 30 tracks',
  'throwback party crowd pleasers, no country',
];
const STORE_KEY = 'party-planner:v1';

const state = {
  status: null,
  prompt: '',
  intent: null,
  set: [],
  flow: [],
  crateName: '',
  view: 'pillar', // 'pillar' | 'order'
  sort: { key: 'hit', dir: -1 }, // pillar view: most popular first
  presets: [],
  presetId: null, // saved search currently loaded, if any
  collapsedBuckets: [], // bucket indexes collapsed everywhere (legend toggles)
  collapsedBlocks: [], // individual blocks, keyed by their first track id
  drawer: null, // { mode: 'swap' | 'add', index }
  playing: null, // { track, index | null }
  skimming: false,
  tags: new Map(),
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function save() {
  try {
    const { prompt, intent, set, flow, crateName, collapsedBuckets, collapsedBlocks, view, presetId, sort } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ prompt, intent, set, flow, crateName, collapsedBuckets, collapsedBlocks, view, presetId, sort }));
  } catch { /* storage unavailable; the session still works */ }
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) Object.assign(state, s);
  } catch { /* ignore */ }
}

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    // draggable is enumerated ("true"/"false"); a bare attribute ("") means "auto" = not draggable.
    else if (k === 'draggable') e.setAttribute(k, v ? 'true' : 'false');
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
};

const fmtTime = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const genreLabel = (id) => state.status?.genres.find((g) => g.id === id)?.label || id;

// ---------- status ----------

async function loadStatus() {
  state.status = await api('/api/status');
  const s = state.status.stats;
  const pct = (n) => `${Math.round((100 * n) / s.tracks)}%`;
  $('libStats').replaceChildren(...[
    `${s.tracks.toLocaleString()} tracks · ${s.crates} crates · ${s.sessions.toLocaleString()} history sessions`,
    `Genre known for ${pct(s.withGenre)} · year for ${pct(s.withYear)} · energy for ${pct(s.withEnergy)}`,
    `Serato play count on ${s.withPlayCount?.toLocaleString() ?? 0} tracks · ${s.djTools ?? 0} DJ tools filtered out`,
    `Loaded in ${(s.loadMs / 1000).toFixed(1)}s from ${state.status.seratoDir}`,
  ].map((line) => el('div', {}, line)));
  const st = $('seratoStatus');
  st.className = `serato-status${state.status.seratoRunning ? ' on' : ''}`;
  st.replaceChildren(el('span', { class: 'dot' }), state.status.seratoRunning ? 'Serato is open: saved crates appear after you restart it' : 'Serato is closed');
  setSeratoPill();

  const parent = $('crateParent');
  const current = parent.value || state.status.defaultParent;
  const names = [...new Set([state.status.defaultParent, ...state.status.crates])];
  parent.replaceChildren(el('option', { value: '' }, '(top level)'), ...names.map((n) => el('option', { value: n }, n.split('%%').join(' ▸ '))));
  parent.value = current;

  renderChartStatus(state.status.charts);
  $('exclude').replaceChildren(...state.status.genres.map((g) => el('option', { value: g.id }, g.label)));
}

function renderChartStatus(c) {
  if (!c) return;
  const failed = c.lastRefresh && Object.entries(c.lastRefresh).filter(([k, v]) => k !== 'at' && String(v).startsWith('failed'));
  $('chartStatus').replaceChildren(...[
    c.billboardLatest ? `Billboard Hot 100: every week from 1958 through ${c.billboardLatest} (${c.billboardSongs.toLocaleString()} songs)` : 'Billboard Hot 100: not downloaded yet',
    c.itunesLatest ? `iTunes Top Songs: latest snapshot ${c.itunesLatest} (${c.itunesSnapshots} day${c.itunesSnapshots === 1 ? '' : 's'} saved)` : 'iTunes Top Songs: no snapshot yet',
    c.matched ? `${c.matched.toLocaleString()} of your tracks charted` : null,
    c.refreshing ? 'Updating…' : null,
    failed?.length ? `Last update failed (offline?): ${failed.map(([k, v]) => `${k} ${v}`).join('; ')}` : null,
  ].filter(Boolean).map((line) => el('div', {}, line)));
}

// Compact status in the top bar: green = Serato playing, amber = open, grey = closed.
let seratoLive = false;
function setSeratoPill() {
  const open = !!state.status?.seratoRunning;
  $('seratoPill').className = `serato-pill${seratoLive ? ' live' : open ? ' open' : ''}`;
  $('seratoPillText').textContent = seratoLive ? 'Serato live' : open ? 'Serato open' : 'Serato closed';
}

// ---------- self-update (desktop app only; the shell checks GitHub Releases) ----------

const UPDATE_BUSY = { checking: 'Checking for updates…', downloading: 'Downloading the update…', verifying: 'Verifying the download…', installing: 'Installing…', restarting: 'Restarting into the new version…' };

function renderUpdate(u) {
  if (!u) return;
  const busy = UPDATE_BUSY[u.state];
  const when = u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : '';
  const line = busy
    || (u.state === 'available' ? `Version ${u.latestVersion} is available. You have ${u.currentVersion}.`
      : u.state === 'current' ? `Version ${u.currentVersion} · up to date${when}${u.message ? ` · ${u.message}` : ''}`
        : u.state === 'error' ? `Version ${u.currentVersion} · ${u.message}`
          : u.message ? `Version ${u.currentVersion} · ${u.message}` : `Version ${u.currentVersion}`);
  $('updateInfo').replaceChildren(el('div', {}, line), u.repo ? el('div', { class: 'hint' }, `Updates come from github.com/${u.repo}`) : null);
  $('updateNotes').hidden = u.state !== 'available' || !u.notes;
  $('updateNotes').textContent = u.notes || '';
  $('updateCheckBtn').hidden = ['dev', 'unconfigured'].includes(u.state);
  $('updateCheckBtn').disabled = !!busy;
  $('updateInstallBtn').hidden = u.state !== 'available';
  const pill = $('updatePill');
  pill.hidden = !(u.state === 'available' || (busy && u.state !== 'checking'));
  pill.textContent = u.state === 'available' ? `⬆ Update to ${u.latestVersion}` : busy || '';
}

if (window.desktop?.updates) {
  window.desktop.updates.onStatus(renderUpdate);
  window.desktop.updates.status().then(renderUpdate).catch(() => {});
  $('updateCheckBtn').onclick = () => window.desktop.updates.check();
  $('updateInstallBtn').onclick = () => window.desktop.updates.install();
  $('updatePill').onclick = () => openInfo(true);
}

function openInfo(show) {
  $('infoModal').hidden = !show;
  if (show) loadStatus().catch(() => {});
}

// ---------- intent editor ----------

// Global recipe (track count, energy, crowd...) sits at the top of the results; each pillar's
// own settings live in its header in the "By pillar" view (pillarEditor below).
function renderIntent() {
  const intent = state.intent;
  if (!intent) return;
  $('count').value = intent.count;
  $('energy').value = intent.energy;
  $('popularity').value = intent.popularity;
  $('clean').checked = !!intent.clean;
  $('bpmLo').value = intent.bpm?.[0] ?? '';
  $('bpmHi').value = intent.bpm?.[1] ?? '';
  for (const o of $('exclude').options) o.selected = intent.exclude.includes(o.value);
  save();
}

// Any edit to the recipe or a pillar flags the set as stale until rebuilt.
function markDirty() {
  state.dirty = true;
  $('rebuildBtn').textContent = 'Rebuild with changes';
  $('rebuildBtn').classList.add('pulse');
  save();
}

function clearDirty() {
  state.dirty = false;
  $('rebuildBtn').textContent = 'Rebuild set';
  $('rebuildBtn').classList.remove('pulse');
}

const parseWords = (v) => v.split(',').map((w) => w.trim()).filter(Boolean);

// New picks for one pillar (using its current settings, edited or not); other pillars untouched.
async function reshufflePillar(bi, btn) {
  const b = state.intent.buckets[bi];
  b.seed = (b.seed || 1) + 1;
  await busy(btn, async () => {
    const res = await api('/api/reshuffle', {
      intent: state.intent, bucket: bi, seed: b.seed * 7919 + bi,
      items: state.set.map((t) => ({ id: t.id, bucket: t.bucket })),
    });
    state.set = res.set;
    state.flow = res.flow;
    renderSet();
    if (!res.candidates) flash(`No matches for ${bucketLabel(bi)}: loosen its genre, era or keywords.`, 'err');
  });
}

function pillarEditor(b, i) {
  const rerender = () => { markDirty(); renderSet(); };
  const addSel = el('select', { class: 'chip-add', onchange: (e) => { b.genres.push(e.target.value); rerender(); } },
    el('option', { value: '' }, '+ genre'),
    ...state.status.genres.filter((g) => !b.genres.includes(g.id)).map((g) => el('option', { value: g.id }, g.label)));
  const era = b.eras[0] || [];
  const eraInput = (idx, ph) => el('input', {
    type: 'number', placeholder: ph, value: era[idx] ?? '', title: idx ? 'Latest year' : 'Earliest year',
    onchange: (e) => {
      const [fromEl, toEl] = e.target.parentElement.querySelectorAll('input');
      const from = Number(fromEl.value) || null;
      const to = Number(toEl.value) || null;
      b.eras = from || to ? [[from || 1950, to || new Date().getFullYear() + 1]] : [];
      markDirty();
    },
  });
  const words = (field, label, ph, tip) => el('label', { class: 'kw', title: tip }, label,
    el('input', { type: 'text', placeholder: ph, value: (b[field] || []).join(', '), onchange: (e) => { b[field] = parseWords(e.target.value); markDirty(); } }));
  return {
    main: [
      el('span', { class: 'chips' },
        b.genres.length ? b.genres.map((g, gi) => el('span', { class: 'chip' }, genreLabel(g),
          el('button', { title: 'Remove genre', onclick: () => { b.genres.splice(gi, 1); rerender(); } }, '×'))) : el('span', { class: 'hint' }, 'Any genre'),
        addSel),
      el('span', { class: 'era' }, eraInput(0, 'from'), '–', eraInput(1, 'to'), b.eras.length > 1 ? el('span', { title: b.eras.map((r) => r.join('–')).join(', ') }, `+${b.eras.length - 1}`) : null),
      el('label', { class: 'pillar-charts', title: 'Billboard Hot 100 history (counts fully when the song charted in this pillar\'s years) + daily iTunes Top Songs' }, 'Charts',
        el('select', { onchange: (e) => { b.charts = e.target.value; markDirty(); } },
          ...[['off', 'Off'], ['boost', 'Prioritize hits'], ['only', 'Only charted']].map(([v, label]) =>
            el('option', { value: v, selected: (b.charts ?? state.intent.charts ?? 'off') === v }, label)))),
      el('label', { class: 'share', title: 'Share of the set' }, el('input', {
        type: 'range', min: 5, max: 100, value: b.share,
        oninput: (e) => { b.share = Number(e.target.value); e.target.nextSibling.textContent = `${b.share}%`; },
        onchange: markDirty,
      }), `${b.share}%`),
      el('button', {
        class: 'ghost small', title: 'New picks for this pillar only; everything else stays put',
        onclick: (e) => reshufflePillar(i, e.currentTarget),
      }, '⟳ Shuffle'),
      el('button', {
        class: 'ghost small', title: 'Remove this pillar',
        onclick: () => {
          state.intent.buckets.splice(i, 1);
          if (state.intent.buckets.length) rebuild(false); else renderSet();
        },
      }, '✕'),
    ],
    keywords: [
      words('require', 'Must include', 'e.g. remix, edit', 'Only tracks matching at least one of these (artist, title, album, genre, comment, crate or folder name). Comma-separated.'),
      words('prefer', 'Priority', 'e.g. too short, bay area', 'Tracks matching these get boosted. Comma-separated.'),
    ],
  };
}

function readGlobals() {
  const i = state.intent;
  i.count = Number($('count').value) || 40;
  i.energy = $('energy').value;
  i.popularity = $('popularity').value;
  i.clean = $('clean').checked;
  const lo = Number($('bpmLo').value);
  const hi = Number($('bpmHi').value);
  i.bpm = lo || hi ? [lo || 40, hi || 220] : null;
  i.exclude = [...$('exclude').selectedOptions].map((o) => o.value);
}

// ---------- planning ----------

function defaultCrateName(prompt) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const words = prompt.replace(/[^\w\s'&-]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  return `${date} ${words || 'Set'}`;
}

// New plans start with every pillar folded: headers (settings + stats) first, tracks on demand.
function collapseAllFor(intent) {
  state.collapsedBuckets = (intent?.buckets || []).map((_, i) => i);
  state.collapsedBlocks = [];
}

function applyPlan(res) {
  clearDirty();
  state.intent = res.intent;
  state.set = res.set;
  state.flow = res.flow;
  renderIntent();
  renderSet();
  if (res.pools) {
    const thin = res.pools.filter((p) => p.candidates < 5);
    if (thin.length) flash(`Only ${thin.map((p) => p.candidates).join('/')} matching songs for some buckets. Try widening the era or genre.`, 'err');
    else $('saveMsg').hidden = true;
  }
}

async function planFromPrompt() {
  const prompt = $('prompt').value.trim();
  if (!prompt) return $('prompt').focus();
  state.prompt = prompt;
  state.crateName = defaultCrateName(prompt);
  state.presetId = null; // a fresh brief isn't the loaded saved search anymore
  $('presetName').value = '';
  $('crateName').value = state.crateName;
  await busy($('planBtn'), async () => {
    const res = await api('/api/plan', { prompt });
    collapseAllFor(res.intent);
    applyPlan(res);
  });
}

async function rebuild(shuffle) {
  readGlobals();
  if (shuffle) state.intent.seed = (state.intent.seed || 1) + 1;
  await busy($(shuffle ? 'shuffleBtn' : 'rebuildBtn'), async () => applyPlan(await api('/api/plan', { intent: state.intent })));
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    await fn();
  } catch (e) {
    flash(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function refreshFlow() {
  state.flow = (await api('/api/flow', { ids: state.set.map((t) => t.id) })).flow;
  renderSet();
}

// ---------- set list ----------

// Between-track notes: only what matters for an open-format set (key is deliberately left out).
function flowRow(f, a, b) {
  if (!f) return null;
  const parts = [];
  if (f.proven) parts.push(el('span', { class: 'proven' }, `★ you've played this transition ${f.proven}×`));
  else if (f.reverse) parts.push(el('span', { class: 'proven' }, `☆ played in reverse ${f.reverse}×`));
  if (a.bucket === b.bucket && f.bpmDelta != null) {
    const ratio = b.bpm / a.bpm;
    const half = Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.04;
    if (!half && Math.abs(f.bpmDelta) > 8) parts.push(el('span', { class: 'meh' }, `${f.bpmDelta > 0 ? '+' : ''}${f.bpmDelta} BPM jump`));
  }
  return parts.length ? el('div', { class: 'flow' }, parts) : null;
}

let dragFrom = null;

// Consecutive runs of the same bucket, e.g. 5 House → 5 Hip Hop → 5 House.
function blocksOf(set) {
  const blocks = [];
  set.forEach((t, i) => {
    const last = blocks[blocks.length - 1];
    if (last && last.bucket === t.bucket) last.items.push([t, i]);
    else blocks.push({ bucket: t.bucket, items: [[t, i]] });
  });
  return blocks;
}

const bucketLabel = (b) => state.intent?.buckets[b]?.genres.map(genreLabel).join(' / ') || 'Any genre';
const bucketColor = (b) => BUCKET_COLORS[b % BUCKET_COLORS.length];
const setMinutes = (tracks) => tracks.reduce((a, t) => a + Math.min(t.length || 210, 240) * 0.85, 0) / 60;

function toggle(setName, key) {
  const s = new Set(state[setName]);
  s.has(key) ? s.delete(key) : s.add(key);
  state[setName] = [...s];
  renderSet();
}

// Two views of the same set: grouped by pillar (one section per bucket from the brief) or in
// play order (consecutive same-genre runs). Both collapse; play order is what the crate saves.
const isPillarView = () => state.view !== 'order';

function pillarGroups() {
  // Every pillar gets a section, even one with no matches, so it can be edited.
  const groups = (state.intent?.buckets || []).map((_, bucket) => ({ bucket, items: [] }));
  state.set.forEach((t, i) => (groups[t.bucket] ||= { bucket: t.bucket, items: [] }).items.push([t, i]));
  return groups.filter(Boolean).map((g) => ({ ...g, items: sortItems(g.items) }));
}

function groupEl(group, pillar) {
  const key = pillar ? group.bucket : group.items[0][0].id;
  const collapsed = state.collapsedBuckets.includes(group.bucket) || (!pillar && state.collapsedBlocks.includes(key));
  const tracks = group.items.map(([t]) => t);
  const meta = [`${tracks.length} tracks`, `~${Math.round(setMinutes(tracks))} min`];
  if (pillar) {
    const eras = state.intent?.buckets[group.bucket]?.eras || [];
    if (eras.length) meta.unshift(eras.map(([a, b]) => `${a}–${b}`).join(', '));
    const pops = tracks.map((t) => t.pop?.score).filter((x) => x != null);
    if (pops.length) meta.push(`avg popularity ${Math.round(pops.reduce((a, b) => a + b, 0) / pops.length)}`);
    const runs = blocksOf(state.set).filter((b) => b.bucket === group.bucket).length;
    meta.push(`${runs} run${runs === 1 ? '' : 's'} in the set`);
  } else {
    const first = group.items[0][1] + 1;
    meta.unshift(`#${first}–${first + tracks.length - 1}`);
  }
  const peek = collapsed && tracks.length ? el('span', { class: 'block-peek' }, tracks.slice(0, 3).map((t) => t.artist.split(/\s+(?:ft\.?|feat\.?|&)\s+/i)[0]).join(', ') + (tracks.length > 3 ? '…' : '')) : null;
  if (pillar && state.intent?.buckets[group.bucket]) {
    const ed = pillarEditor(state.intent.buckets[group.bucket], group.bucket);
    const head = el('div', { class: 'block-head pillar-head' },
      el('div', { class: 'pillar-row' },
        el('button', { class: 'chev-btn', 'aria-expanded': String(!collapsed), title: collapsed ? 'Expand' : 'Collapse', onclick: () => toggle('collapsedBuckets', key) },
          el('span', { class: 'chev' }, collapsed ? '▸' : '▾'),
          el('span', { class: 'swatch', style: `background:${bucketColor(group.bucket)}` })),
        isDesktop && tracks.length ? el('span', { class: 'drag-all small', draggable: true, title: 'Drag this pillar\'s tracks into Serato', ondragstart: (e) => dragFiles(e, tracks) }, `⇱ ${tracks.length}`) : null,
        ...ed.main),
      el('div', { class: 'pillar-row sub' },
        el('span', { class: 'block-meta' }, tracks.length ? meta.join(' · ') : 'No matches yet: pick a genre, widen the era or loosen keywords, then rebuild'),
        ...ed.keywords, peek));
    return el('li', { class: 'block', style: `--c:${bucketColor(group.bucket)}` }, head,
      collapsed || !tracks.length ? null : el('ol', { class: 'block-tracks' }, colHeader(pillar), group.items.map(([t, i]) => trackRow(t, i, { pillar }))));
  }
  const head = el('button', {
    class: 'block-head', 'aria-expanded': String(!collapsed),
    onclick: () => toggle(pillar ? 'collapsedBuckets' : 'collapsedBlocks', key),
  },
    el('span', { class: 'chev' }, collapsed ? '▸' : '▾'),
    el('span', { class: 'swatch', style: `background:${bucketColor(group.bucket)}` }),
    el('strong', {}, bucketLabel(group.bucket)),
    el('span', { class: 'block-meta' }, meta.join(' · ')),
    peek);
  return el('li', { class: 'block', style: `--c:${bucketColor(group.bucket)}` }, head,
    collapsed ? null : el('ol', { class: 'block-tracks' }, colHeader(pillar), group.items.map(([t, i]) => trackRow(t, i, { pillar }))));
}

function renderSet() {
  $('setCard').hidden = !state.intent;
  $('addBucket').hidden = !isPillarView();
  state.collapsedBuckets ||= [];
  state.collapsedBlocks ||= [];
  const pillar = isPillarView();
  $('setlist').replaceChildren(...(pillar ? pillarGroups() : blocksOf(state.set)).map((g) => groupEl(g, pillar)));
  for (const b of document.querySelectorAll('#viewToggle button')) b.classList.toggle('on', (b.dataset.view === 'pillar') === pillar);
  renderSummary();
  if (!$('crateName').value) $('crateName').value = state.crateName || defaultCrateName(state.prompt);
  save();
}

function renderSummary() {
  const proven = state.flow.filter((f) => f?.proven).length;
  const legend = (state.intent?.buckets || []).map((b, i) => {
    const n = state.set.filter((t) => t.bucket === i).length;
    if (!n) return null;
    const off = (state.collapsedBuckets || []).includes(i);
    return el('button', {
      class: `legend${off ? ' off' : ''}`, title: off ? 'Expand all blocks of this genre' : 'Collapse all blocks of this genre',
      onclick: () => {
        // Expanding a genre also clears per-block collapses for it, so it fully opens.
        if (off) state.collapsedBlocks = (state.collapsedBlocks || []).filter((id) => state.set.find((t) => t.id === id)?.bucket !== i);
        toggle('collapsedBuckets', i);
      },
    }, el('span', { class: 'swatch', style: `background:${bucketColor(i)}` }), `${bucketLabel(i)} ${n}`);
  });
  $('setSummary').replaceChildren(
    `${state.set.length} tracks · ~${Math.round(setMinutes(state.set))} min${proven ? ` · ${proven} proven transitions` : ''}`,
    el('span', { class: 'legends' }, legend),
    collapseToggle());
}

// One button: "Collapse all" while anything is open, "Expand all" once everything is closed.
function collapseToggle() {
  const pillar = isPillarView();
  const groups = pillar ? pillarGroups().filter((g) => g.items.length) : blocksOf(state.set);
  const isCollapsed = (g) => state.collapsedBuckets.includes(g.bucket) || (!pillar && state.collapsedBlocks.includes(g.items[0][0].id));
  const anyOpen = groups.some((g) => !isCollapsed(g));
  return el('button', {
    class: 'ghost small',
    onclick: () => {
      if (anyOpen) {
        if (pillar) state.collapsedBuckets = [...new Set(state.set.map((t) => t.bucket))];
        else { state.collapsedBlocks = blocksOf(state.set).map((g) => g.items[0][0].id); state.collapsedBuckets = []; }
      } else {
        state.collapsedBlocks = [];
        state.collapsedBuckets = [];
      }
      renderSet();
    },
  }, anyOpen ? 'Collapse all' : 'Expand all');
}

function chartBadge(t) {
  if (t.billboard && t.billboard.peak <= 40) return el('span', { class: `badge${t.billboard.peak <= 10 ? ' top' : ''}`, title: `Billboard Hot 100: peaked #${t.billboard.peak}, ${t.billboard.weeks} weeks, ${t.billboard.year}` }, `Hot 100 #${t.billboard.peak}`);
  if (t.itunes) return el('span', { class: 'badge fresh', title: `iTunes Top Songs: best #${t.itunes.best}, last seen ${t.itunes.last}` }, `iTunes #${t.itunes.best}`);
  if (t.billboard) return el('span', { class: 'badge', title: `Billboard Hot 100: peaked #${t.billboard.peak}, ${t.billboard.weeks} weeks, ${t.billboard.year}` }, `Hot 100 #${t.billboard.peak}`);
  return null;
}

// Popularity 0-100: the "crowd pleaser" signal used for picking, independent of genre fit.
function popMeter(t) {
  const p = t.pop;
  if (!p) return el('span', { class: 'pop' });
  const score = p.hit ?? p.score;
  const top = p.hitTop ?? p.top;
  const chartLine = t.billboard
    ? `Billboard peak #${t.billboard.peak}, ${t.billboard.weeks} wks (${t.billboard.year})${t.itunes ? ` · iTunes #${t.itunes.best}` : ''}`
    : t.itunes ? `iTunes #${t.itunes.best} (${t.itunes.last})` : 'never charted';
  const tip = [
    `Popularity ${score}/100 · top ${top}% of your library`,
    `• Your plays: ${t.plays} session${t.plays === 1 ? '' : 's'} → ${p.history}`,
    `• Serato play count: ${t.playCount || 0} → ${p.playCount}`,
    `• In ${t.crates} crate${t.crates === 1 ? '' : 's'} → ${p.crates}`,
    `• Charts: ${chartLine} → ${p.chart ?? 0}`,
    'Score = 60% your plays/crates + 40% chart performance',
  ].join('\n');
  const tier = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cool';
  return el('span', { class: `pop ${tier}`, title: tip },
    el('span', { class: 'pop-bar' }, el('span', { style: `width:${score}%` })),
    el('span', { class: 'pop-num' }, score),
    el('small', {}, `top ${top}%`));
}

// Column headers; in the pillar view they sort that pillar (play order is the sequence, so no sort).
const SORTS = {
  hit: { label: 'Popularity', dir: -1, val: (t) => t.pop?.hit ?? t.pop?.score ?? 0 },
  title: { label: 'Track', dir: 1, val: (t) => `${t.title}`.toLowerCase() },
  bpm: { label: 'BPM', dir: 1, val: (t) => t.bpm ?? 999 },
  key: { label: 'Key', dir: 1, val: (t) => (t.key ? parseInt(t.key, 10) * 2 + (t.key.endsWith('B') ? 1 : 0) : 99) },
  year: { label: 'Year', dir: 1, val: (t) => t.year ?? 9999 },
  energy: { label: 'E', title: 'energy (Mixed In Key)', dir: -1, val: (t) => t.energy ?? -1 },
};

function sortItems(items) {
  const { key, dir } = state.sort || { key: 'hit', dir: -1 };
  const f = SORTS[key]?.val;
  if (!f) return items;
  return [...items].sort(([a], [b]) => {
    const x = f(a), y = f(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.pop?.hit ?? 0) - (a.pop?.hit ?? 0);
  });
}

function colHeader(pillar) {
  const cell = (key, cls = '') => {
    if (!pillar || !key) return el('span', { class: cls }, key ? SORTS[key].label : '');
    const on = (state.sort?.key || 'hit') === key;
    const dir = on ? state.sort?.dir ?? SORTS[key].dir : SORTS[key].dir;
    return el('button', {
      class: `col-sort ${cls}${on ? ' on' : ''}`, title: `Sort by ${SORTS[key].title || SORTS[key].label.toLowerCase()}`,
      onclick: () => { state.sort = { key, dir: on ? -dir : SORTS[key].dir }; renderSet(); },
    }, SORTS[key].label, on ? (dir < 0 ? ' ↓' : ' ↑') : '');
  };
  return el('li', { class: 'trk trk-head', 'aria-hidden': 'false' },
    el('span', { class: 'num' }, '#'), el('span'), el('span'),
    cell('title'), cell('bpm', 'num-col'), cell('key', 'key'), cell('year', 'num-col yr'), cell('energy', 'num-col en'), cell('hit'), el('span'));
}

function trackRow(t, i, { pillar = false } = {}) {
    const playing = state.playing?.track.id === t.id;
    // Drag-to-reorder only makes sense in play order; the pillar view isn't sequential.
    const li = el('li', {
      'data-index': i,
      draggable: true,
      ondragstart: (e) => {
        const reorder = !pillar && (!isDesktop || pointerOnHandle);
        if (!reorder) return fileDrag(e, t); // drop into Serato/Finder
        if (!isDesktop) fileDrag(e, t); // browser: carry the link too, harmless
        dragFrom = i;
        li.querySelector('.trk').classList.add('dragging');
      },
      ondragend: () => { dragFrom = null; renderSet(); },
      ondragover: (e) => { if (dragFrom == null) return; e.preventDefault(); li.querySelector('.trk').classList.add('drop-above'); },
      ondragleave: () => li.querySelector('.trk').classList.remove('drop-above'),
      ondrop: (e) => {
        e.preventDefault();
        if (dragFrom == null || dragFrom === i) return;
        const [moved] = state.set.splice(dragFrom, 1);
        state.set.splice(dragFrom < i ? i - 1 : i, 0, moved);
        dragFrom = null;
        refreshFlow();
      },
    },
    el('div', { class: `trk drag-row${playing ? ' playing' : ''}` },
      el('span', { class: 'num', title: pillar ? `Position ${i + 1} in the set` : isDesktop ? 'Drag this number to reorder · drag anywhere else on the row into Serato' : 'Drag to reorder' }, i + 1),
      el('span', { class: 'bar', style: `background:${bucketColor(t.bucket)}` }),
      el('button', { class: 'play', title: 'Preview', onclick: () => playIndex(i) }, playing && !$('audio').paused ? '❚❚' : '▶'),
      el('div', { class: 'meta' },
        el('div', { class: 't', title: t.title }, chartBadge(t), t.title),
        el('div', { class: 'a' }, t.artist),
        el('div', { class: 'why', title: t.reasons.join('\n') }, t.reasons.join(' · '))),
      el('span', { class: 'num-col dim', title: 'BPM' }, t.bpm ? Math.round(t.bpm) : '—'),
      el('span', { class: 'key dim', title: 'Key (Camelot)' }, t.key || '—'),
      el('span', { class: 'num-col yr', title: t.yearSrc ? `year from ${t.yearSrc}` : 'year unknown' }, t.year ?? '—', t.yearSrc && t.yearSrc !== 'tag' ? el('small', {}, t.yearSrc) : null),
      el('span', { class: 'num-col en', title: 'Energy (Mixed In Key)' }, t.energy ? `E${t.energy}` : ''),
      popMeter(t),
      el('div', { class: 'acts' },
        el('button', { class: 'ghost', title: 'Remove from set', onclick: () => { state.set.splice(i, 1); refreshFlow(); } }, '✕'))),
    !pillar && i < state.set.length - 1 ? flowRow(state.flow[i], t, state.set[i + 1]) : null);
    return li;
}

// ---------- getting files into Serato ----------

// Dragging a row out of the page carries the real file (file:// URL + path), so it can be
// dropped on Serato's library/decks or into Finder. No copy is made.
// In the desktop app, drags become native macOS file drags (what Serato accepts). In a browser
// tab we can only attach a file:// link, which Serato ignores.
const isDesktop = !!window.desktop;
let pointerOnHandle = false; // desktop: row drags go to Serato unless started on the # handle
document.addEventListener('pointerdown', (e) => { pointerOnHandle = !!e.target.closest?.('.num'); }, true);

function dragFiles(e, tracks) {
  const files = tracks.map((t) => t.location).filter(Boolean);
  if (isDesktop) console.log(`[drag-start] ${files.length} file(s) from ${e.currentTarget?.className || e.target?.className}`);
  if (!isDesktop || !files.length) return false;
  e.preventDefault();
  window.desktop.startDrag(files);
  return true;
}

function fileDrag(e, t) {
  if (dragFiles(e, [t])) return;
  if (!t.fileUrl) return;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/uri-list', t.fileUrl);
  e.dataTransfer.setData('text/plain', t.location);
}


// ---------- next up (live from Serato's history, or a track you pick) ----------

// deck: null = follow whichever deck was loaded last; 1/2 = match off that deck (follows its loads).
const np = { deck: null, decks: [], target: null, lastTargetId: null, timer: null, results: [], sort: 'match', dials: null };
try { np.sort = localStorage.getItem('party-planner:np-sort') || 'match'; } catch { /* ignore */ }

// Two tabs: build a set, or follow Serato and get next-track ideas.
function setTab(tab) {
  document.body.classList.toggle('tab-next', tab === 'next');
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  try { localStorage.setItem('party-planner:tab', tab); } catch { /* ignore */ }
  if (tab === 'next') {
    pollNowPlaying();
    if (!$('npList').children.length) suggest();
  }
}

function ago(sec) {
  const d = Math.max(0, Math.round(Date.now() / 1000 - sec));
  return d < 60 ? `${d}s ago` : d < 3600 ? `${Math.round(d / 60)} min ago` : `${Math.round(d / 3600)} h ago`;
}

// Polled every 2s (and on focus / the Refresh button). `force` re-suggests even if the deck didn't change.
async function pollNowPlaying(force = false) {
  let res;
  try { res = await api('/api/nowplaying'); } catch { $('npStatus').textContent = 'Lost connection to the app server'; return; }
  $('liveDot').hidden = !res.live;
  seratoLive = !!res.live;
  setSeratoPill();
  $('npStatus').textContent = res.live
    ? `Live from Serato · ${res.playedCount} loaded this session · checked ${new Date().toLocaleTimeString()}`
    : `Serato isn't playing right now (last session ${res.sessionUpdated ? new Date(res.sessionUpdated).toLocaleDateString() : 'unknown'}). Load a track (or drag one in from here) and suggestions follow it automatically.`;
  np.decks = res.decks;
  renderDecks(res);
  const target = np.deck ? res.decks.find((d) => d.deck === np.deck) : res.live ? res.current : null;
  np.target = target?.track || null;
  const targetId = np.target?.id || null;
  if (targetId !== np.lastTargetId) {
    np.lastTargetId = targetId; // a new track on the deck we're matching off: refresh ideas
    suggest();
  } else if (force) {
    suggest();
  }
}

function renderDecks(res) {
  const latest = res.live ? res.current?.deck : null;
  $('npDecks').replaceChildren(
    ...(res.decks.length && !res.live ? [el('div', { class: 'hint' }, 'Last loaded in Serato:')] : []),
    ...res.decks.map((d) => {
      const matching = np.deck ? np.deck === d.deck : latest === d.deck;
      return el('div', {
        class: `np-deck drag-row${matching ? ' matching' : ''}${latest === d.deck ? ' on' : ''}`,
        draggable: !!d.track,
        ondragstart: (e) => d.track && fileDrag(e, d.track),
        title: !d.track ? 'Not in your library' : np.deck === d.deck ? 'Click to go back to following the latest deck' : `Click to match suggestions off Deck ${d.deck}`,
        onclick: () => {
          if (!d.track) return;
          np.deck = np.deck === d.deck ? null : d.deck;
          pollNowPlaying(true);
        },
      },
        el('span', { class: 'np-deck-n' }, `Deck ${d.deck}`),
        el('span', { class: 'np-deck-t' }, `${d.artist || d.track?.artist || ''} – ${d.title || d.track?.title || ''}`),
        d.track?.bpm ? el('span', { class: 'bpm-pill' }, `${Math.round(d.track.bpm)} BPM`) : null,
        el('span', { class: 'hint' }, d.start ? `loaded ${ago(d.start)}` : ''),
        matching ? el('span', { class: 'np-match' }, np.deck ? 'matching (picked)' : 'matching (latest)') : null,
        d.track ? null : el('span', { class: 'hint' }, '(not in library)'));
    }));
}


// shuffle=true draws a varied list from the top candidates instead of the strict top 25.
async function suggest(shuffle = false) {
  const text = $('npText').value.trim();
  const shownIds = shuffle ? [...$('npList').querySelectorAll('li[data-id]')].map((li) => li.dataset.id) : [];
  $('npList').replaceChildren(el('li', { class: 'hint' }, 'Thinking…'));
  let res;
  try {
    res = await api('/api/suggest', { seedId: np.target?.id, text, limit: 40, shuffle: shuffle ? Math.floor(Math.random() * 1e9) + 1 : 0, avoidIds: shownIds, dials: np.dials });
  } catch (e) {
    $('npList').replaceChildren(el('li', { class: 'hint' }, e.message));
    return;
  }
  $('npSeed').replaceChildren(...(res.seed ? [
    el('span', { class: 'hint' }, np.deck ? `Matching Deck ${np.deck}: ` : 'Matching the latest deck: '),
    el('strong', {}, `${res.seed.artist} – ${res.seed.title}`),
    res.seed.bpm ? el('span', { class: 'bpm-pill' }, `${Math.round(res.seed.bpm)} BPM`) : null,
    el('span', { class: 'hint' }, ` (${[res.seed.year, Object.keys(res.seed.genres).map(genreLabel).join('/'), res.seed.energy && `E${res.seed.energy}`].filter(Boolean).join(' · ')})`),
    np.deck ? el('button', { class: 'ghost small', onclick: () => { np.deck = null; pollNowPlaying(true); } }, 'Follow latest deck') : null,
  ].filter(Boolean) : [el('span', { class: 'hint' }, 'No starting track: showing your best matches for the text alone.')]));
  const p = res.parsed;
  const bits = [p.genres.length && `genre: ${p.genres.map(genreLabel).join(', ')}`, p.eras.length && `era: ${p.eras.map(([a, b]) => `${a}–${b}`).join(', ')}`, p.energy && `energy ${p.energy}`, p.keywords.length && `keywords: ${p.keywords.join(', ')}`].filter(Boolean);
  $('npParsed').textContent = bits.length ? `Reading that as ${bits.join(' · ')}` : '';
  np.results = res.tracks;
  np.seedBpm = res.seed?.bpm || null;
  renderSuggestions();
}

// ---------- dials: how much each signal matters when picking the next track ----------

const DIALS_KEY = 'party-planner:dials';
let dialTimer;

function defaultDials() {
  return Object.fromEntries((state.status?.dials || []).map((d) => [d.id, d.def]));
}

function loadDials() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DIALS_KEY) || 'null'); } catch { /* ignore */ }
  np.dials = { ...defaultDials(), ...(saved || {}) };
}

function setDials(dials, { refresh = true } = {}) {
  np.dials = { ...np.dials, ...dials };
  try { localStorage.setItem(DIALS_KEY, JSON.stringify(np.dials)); } catch { /* ignore */ }
  renderDials();
  if (refresh) {
    clearTimeout(dialTimer);
    dialTimer = setTimeout(() => suggest(), 250); // re-rank shortly after you stop dragging
  }
}

function renderDials() {
  const defs = state.status?.dials || [];
  const presets = state.status?.dialPresets || {};
  const active = Object.entries(presets).find(([, p]) => defs.every((d) => p.dials[d.id] === np.dials[d.id]))?.[0];
  $('npPresets').replaceChildren(...Object.entries(presets).map(([id, p]) => el('button', {
    class: `ghost small${active === id ? ' on' : ''}`, title: defs.map((d) => `${d.label} ${p.dials[d.id]}`).join(' · '),
    onclick: () => setDials(p.dials),
  }, p.label)));
  $('npDialGrid').replaceChildren(...defs.map((d) => {
    const v = np.dials[d.id] ?? d.def;
    const out = el('span', { class: 'dial-val' }, v === 0 ? 'off' : v);
    return el('label', { class: `dial${v === 0 ? ' off' : ''}`, title: `${d.hint}. 0 = ignore, 50 = normal, 100 = lean on it hard.` },
      el('span', { class: 'dial-name' }, d.label, out),
      el('input', {
        type: 'range', min: 0, max: 100, step: 5, value: v,
        oninput: (e) => {
          const n = Number(e.target.value);
          out.textContent = n === 0 ? 'off' : n;
          e.target.closest('.dial').classList.toggle('off', n === 0);
          setDials({ [d.id]: n });
        },
      }));
  }));
}

// Big BPM readout + difference from the deck: green = easy blend (±2%), amber = needs pitching
// (±5%), red = a stretch. Half/double-time matches say so.
function bpmCell(t) {
  if (!t.bpm) return el('span', { class: 'np-bpm none', title: 'No BPM in Serato' }, '—');
  const seedBpm = np.seedBpm;
  const d = t.bpmDelta;
  const pct = seedBpm && d != null ? Math.abs(d) / seedBpm : null;
  const tier = pct == null ? '' : pct <= 0.02 ? 'ok' : pct <= 0.05 ? 'meh' : 'far';
  const deltaText = d == null ? '' : t.half ? (t.bpm > seedBpm ? '½ time' : '2× time') : Math.abs(d) < 0.5 ? 'same' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
  return el('span', { class: `np-bpm ${tier}`, title: seedBpm ? `${t.bpm} BPM vs deck ${seedBpm}` : `${t.bpm} BPM` },
    el('strong', {}, Math.round(t.bpm)), el('small', {}, deltaText));
}

// Suggestions in the chosen order: best match (server ranking) or popularity (plays + charts).
function renderSuggestions() {
  const tracks = np.sort === 'pop'
    ? [...(np.results || [])].sort((a, b) => (b.pop?.hit ?? 0) - (a.pop?.hit ?? 0))
    : np.results || [];
  for (const b of document.querySelectorAll('#npSort button')) b.classList.toggle('on', b.dataset.sort === (np.sort || 'match'));
  const dialLabel = Object.fromEntries((state.status?.dials || []).map((d) => [d.id, d.label]));
  const factorTip = (t) => t.factors ? `\n\nHow it scored (0–100):\n${Object.entries(t.factors).map(([k, v]) => `${dialLabel[k] || k}: ${Math.round(v * 100)}`).join('\n')}` : '';
  $('npList').replaceChildren(...(tracks.length ? tracks.map((t) => el('li', { class: 'cand np-row drag-row', 'data-id': t.id, draggable: true, ondragstart: (e) => fileDrag(e, t), title: `Drag into Serato${factorTip(t)}` },
    el('button', { class: 'play', title: 'Preview', onclick: () => playTrack(t, null) }, '▶'),
    el('div', { class: 'np-meta' },
      el('div', { class: 't' }, chartBadge(t), t.title),
      el('div', { class: 'a' }, `${t.artist} · ${t.year ?? '—'} · ${Object.keys(t.genres).map(genreLabel).join('/') || '—'}`),
      t.why?.length ? el('div', { class: 'why' }, t.why.filter((w) => !/BPM|half\/double/.test(w)).join(' · ')) : null),
    bpmCell(t),
    popMeter(t),
    null))
    : [el('li', { class: 'hint' }, 'Nothing matches. Loosen the text?')]));
}

// ---------- drawer: swap / add ----------

async function openDrawer(mode, index) {
  state.drawer = { mode, index };
  $('drawer').hidden = false;
  $('drawerTitle').textContent = mode === 'swap' ? `Swap #${index + 1}: ${state.set[index].title}` : 'Add tracks';
  $('search').value = '';
  if (mode === 'swap') {
    $('drawerSub').textContent = 'Best fits for this slot (genre/era match, BPM & key vs. neighbours, your history):';
    $('cands').replaceChildren(el('li', { class: 'hint' }, 'Finding options…'));
    const t = state.set[index];
    const res = await api('/api/alternatives', {
      intent: state.intent, bucket: t.bucket, setIds: state.set.map((x) => x.id),
      prevId: state.set[index - 1]?.id, nextId: state.set[index + 1]?.id,
    });
    renderCands(res.tracks);
  } else {
    $('drawerSub').textContent = 'Search by artist, title, album or genre tag.';
    $('cands').replaceChildren();
    $('search').focus();
  }
}

function guessBucket(t) {
  const buckets = state.intent?.buckets || [];
  let best = 0;
  let bestScore = -1;
  buckets.forEach((b, i) => {
    const s = b.genres.length ? Math.max(0, ...b.genres.map((g) => t.genres[g] || 0)) : 0.1;
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

function renderCands(tracks) {
  const { mode, index } = state.drawer;
  $('cands').replaceChildren(...(tracks.length ? tracks.map((t) => el('li', { class: 'cand drag-row', draggable: true, ondragstart: (e) => fileDrag(e, t), title: 'Drag into Serato' },
    el('button', { class: 'play', title: 'Preview', onclick: () => playTrack(t, null) }, '▶'),
    el('div', {},
      el('div', { class: 't', title: t.reasons.join('\n') }, t.title),
      el('div', { class: 'a' }, `${t.artist} · ${t.year ?? '—'}${t.pop ? ` · popularity ${t.pop.score} (top ${t.pop.top}%)` : ''} · ${t.bpm ? Math.round(t.bpm) : '—'} BPM`)),
    el('button', {
      class: 'use primary',
      onclick: () => {
        if (mode === 'swap') {
          state.set[index] = { ...t, bucket: state.set[index].bucket };
          closeDrawer();
        } else {
          const at = state.drawer.index ?? state.set.length;
          state.set.splice(at, 0, { ...t, bucket: guessBucket(t) });
          state.drawer.index = at + 1;
        }
        refreshFlow();
      },
    }, mode === 'swap' ? 'Use' : 'Add'))) : [el('li', { class: 'hint' }, 'No matches.')]));
}

function closeDrawer() {
  state.drawer = null;
  $('drawer').hidden = true;
}

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  searchTimer = setTimeout(async () => {
    if (!q) return;
    if (state.drawer?.mode === 'swap') {
      // Typing in swap mode switches to "replace with anything from the library".
      $('drawerSub').textContent = 'Library search: pick a replacement.';
    }
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    $('drawerSub').textContent = `${res.total} matches${res.total > res.tracks.length ? ` (showing ${res.tracks.length})` : ''}`;
    renderCands(res.tracks);
  }, 200);
}

// ---------- player ----------

const audio = $('audio');
const canvas = $('overview');
let skimTimer = null;

async function getTags(id) {
  if (!state.tags.has(id)) state.tags.set(id, api(`/api/track/${id}/serato`).catch(() => ({ cues: [], loops: [], overview: null })));
  return state.tags.get(id);
}

function playIndex(i) {
  const t = state.set[i];
  if (state.playing?.track.id === t.id && state.playing.index === i) {
    audio.paused ? audio.play() : audio.pause();
    return;
  }
  playTrack(t, i);
}

async function playTrack(t, index, { startAt } = {}) {
  state.playing = { track: t, index };
  $('player').classList.add('has-track');
  $('nowTitle').textContent = `${t.artist} – ${t.title}`;
  $('nowMeta').textContent = [t.bpm && `${t.bpm} BPM`, t.key, t.year, t.ext?.toUpperCase()].filter(Boolean).join(' · ');
  audio.src = `/api/audio/${t.id}`;
  const tags = await getTags(t.id);
  if (state.playing?.track.id !== t.id) return; // user moved on while tags loaded
  state.playing.tags = tags;
  renderCues(tags);
  const seekTo = startAt === 'skim' ? skimPoint(tags, t) : 0;
  const start = () => {
    if (seekTo) audio.currentTime = seekTo;
    audio.play().catch((e) => { $('nowMeta').textContent = `Can't play this file in the browser (${t.ext}): ${e.message}`; });
  };
  if (audio.readyState >= 1) start();
  else audio.addEventListener('loadedmetadata', start, { once: true });
  renderSet();
  drawOverview();
}

function skimPoint(tags, t) {
  // Second hot cue is usually the first drop/hook; fall back to the first cue, then ~30% in.
  const cues = tags.cues || [];
  const cue = cues.find((c) => c.index === 1) || cues[0];
  if (cue && cue.ms > 5000) return cue.ms / 1000;
  return (t.length || 200) * 0.3;
}

function renderCues(tags) {
  const byIndex = new Map((tags.cues || []).map((c) => [c.index, c]));
  $('cues').replaceChildren(...Array.from({ length: 8 }, (_, i) => {
    const c = byIndex.get(i);
    return el('button', {
      class: `cue${c ? '' : ' empty'}`,
      style: c ? `background:${c.color}` : '',
      title: c ? `${c.name || `Cue ${i + 1}`} @ ${fmtTime(c.ms / 1000)} (key ${i + 1})` : 'No cue',
      onclick: () => c && jumpToCue(c),
    }, i + 1);
  }));
}

function jumpToCue(c) {
  audio.currentTime = c.ms / 1000;
  audio.play();
}

function drawOverview() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const tags = state.playing?.tags;
  const dur = audio.duration || state.playing?.track.length || 0;
  const progress = dur ? audio.currentTime / dur : 0;
  const cols = tags?.overview;
  if (cols?.length) {
    const cw = w / cols.length;
    const rh = h / 16;
    cols.forEach((col, x) => {
      const played = x / cols.length < progress;
      col.forEach((v, y) => {
        if (v <= 1) return;
        const a = Math.min(1, Math.sqrt((v - 1) / 200));
        ctx.fillStyle = played ? `rgba(107,114,128,${a})` : `rgba(29,95,224,${a})`;
        ctx.fillRect(x * cw, y * rh, cw + 0.6, rh + 0.6);
      });
    });
  } else {
    ctx.fillStyle = '#e2e5ec';
    ctx.fillRect(0, h / 2 - 2, w, 4);
    ctx.fillStyle = '#1d5fe0';
    ctx.fillRect(0, h / 2 - 2, w * progress, 4);
  }
  if (dur) {
    for (const c of tags?.cues || []) {
      const x = (c.ms / 1000 / dur) * w;
      ctx.fillStyle = c.color;
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillRect(x - 1, 0, 12, 10);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText(String(c.index + 1), x + 2, 8);
    }
    ctx.fillStyle = '#14161b';
    ctx.fillRect(progress * w - 1, 0, 2, h);
  }
  $('time').textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(dur)}`;
}

// Bring a set track into view: open its block if collapsed (other blocks stay as they are).
function focusTrack(index) {
  const t = state.set[index];
  if (!t) return;
  const blocks = blocksOf(state.set);
  const block = blocks.find((b) => b.items.some(([, i]) => i === index));
  const key = block.items[0][0].id;
  if (isPillarView()) {
    state.collapsedBuckets = state.collapsedBuckets.filter((b) => b !== t.bucket);
  } else if ((state.collapsedBuckets || []).includes(t.bucket)) {
    // Un-collapse the genre, but keep its other blocks folded.
    state.collapsedBuckets = state.collapsedBuckets.filter((b) => b !== t.bucket);
    const others = blocks.filter((b) => b.bucket === t.bucket && b !== block).map((b) => b.items[0][0].id);
    state.collapsedBlocks = [...new Set([...(state.collapsedBlocks || []), ...others])];
  }
  if (!isPillarView()) state.collapsedBlocks = (state.collapsedBlocks || []).filter((id) => id !== key);
  renderSet();
  document.querySelector(`#setlist li[data-index="${index}"] .trk`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// playTrack marks the track as playing synchronously, so focus after it to render the highlight.
function step(dir) {
  const i = state.playing?.index;
  if (i == null) {
    if (!state.set.length) return;
    playIndex(0);
    return focusTrack(0);
  }
  const next = i + dir;
  if (next < 0 || next >= state.set.length) return stopSkim();
  playTrack(state.set[next], next, { startAt: state.skimming ? 'skim' : undefined });
  focusTrack(next);
}

function startSkim() {
  if (!state.set.length) return;
  state.skimming = true;
  $('skimBtn').textContent = '■ Stop skimming';
  const i = state.playing?.index ?? 0;
  playTrack(state.set[i], i, { startAt: 'skim' });
}

function stopSkim() {
  state.skimming = false;
  clearTimeout(skimTimer);
  $('skimBtn').textContent = '▶ Skim the set';
}

audio.addEventListener('timeupdate', drawOverview);
audio.addEventListener('play', () => {
  $('playBtn').textContent = '❚❚';
  renderSet();
  if (state.skimming) {
    clearTimeout(skimTimer);
    skimTimer = setTimeout(() => step(1), Number($('skimLen').value) * 1000);
  }
});
audio.addEventListener('pause', () => { $('playBtn').textContent = '▶'; clearTimeout(skimTimer); renderSet(); });
audio.addEventListener('ended', () => state.playing?.index != null && step(1));
audio.addEventListener('error', () => {
  if (state.playing) $('nowMeta').textContent = `Can't play this file in the browser (${state.playing.track.ext}). Safari handles AIFF.`;
});
// The whole player bar drags the track being previewed into Serato (clicks/seek still work).
$('player').setAttribute('draggable', 'true');
$('player').addEventListener('dragstart', (e) => {
  if (!state.playing?.track) return e.preventDefault();
  fileDrag(e, state.playing.track);
});

canvas.addEventListener('click', (e) => {
  const dur = audio.duration;
  if (!dur) return;
  const r = canvas.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * dur;
});
window.addEventListener('resize', drawOverview);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey) return;
  if (e.code === 'Space') { e.preventDefault(); if (audio.src) audio.paused ? audio.play() : audio.pause(); }
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (/^[1-8]$/.test(e.key)) {
    const c = state.playing?.tags?.cues.find((x) => x.index === Number(e.key) - 1);
    if (c) jumpToCue(c);
  }
});

// ---------- saving ----------

function flash(msg, kind = 'ok') {
  const m = $('saveMsg');
  m.hidden = false;
  m.className = `save-msg ${kind}`;
  m.textContent = msg;
}

function confirmModal(text, okLabel = 'Overwrite') {
  return new Promise((resolve) => {
    $('modalText').textContent = text;
    $('modalOk').textContent = okLabel;
    $('modal').hidden = false;
    const done = (v) => { $('modal').hidden = true; resolve(v); };
    $('modalOk').onclick = () => done(true);
    $('modalCancel').onclick = () => done(false);
  });
}

async function saveCrate(overwrite = false) {
  const name = $('crateName').value.trim();
  const parent = $('crateParent').value;
  state.crateName = name;
  try {
    const res = await api('/api/crate', { name, parent, ids: state.set.map((t) => t.id), overwrite });
    flash(`Saved "${res.fullName.split('%%').join(' ▸ ')}" with ${res.tracks} tracks.${res.backup ? ' The previous version was backed up.' : ''} ${res.seratoRunning ? 'Serato is open: restart it to see the new crate.' : 'Open Serato to see it.'}`);
    loadStatus();
  } catch (e) {
    if (e.status === 409 && (await confirmModal(`A crate called "${e.data.fullName.split('%%').join(' ▸ ')}" already exists. Overwrite it? (The old one is backed up first.)`))) {
      return saveCrate(true);
    }
    if (e.status !== 409) flash(e.message, 'err');
  }
}

// ---------- saved searches (brief + settings, not results) ----------

function describeIntent(intent) {
  const pillars = intent.buckets.map((b) => {
    const g = b.genres.map(genreLabel).join('/') || 'Any genre';
    const era = b.eras.length ? ` ${b.eras.map(([a, c]) => `${a}–${c}`).join(', ')}` : '';
    const chartMode = b.charts ?? intent.charts;
    const kw = [b.require?.length && `must: ${b.require.join(', ')}`, b.prefer?.length && `priority: ${b.prefer.join(', ')}`, chartMode === 'boost' && 'chart hits first', chartMode === 'only' && 'only charted'].filter(Boolean);
    return `${g}${era} ${b.share}%${kw.length ? ` (${kw.join('; ')})` : ''}`;
  });
  const extras = [`${intent.count} tracks`, intent.energy, intent.popularity];
  if (intent.clean) extras.push('clean');
  if (intent.bpm) extras.push(`${intent.bpm[0]}–${intent.bpm[1]} BPM`);
  if (intent.exclude?.length) extras.push(`no ${intent.exclude.map(genreLabel).join('/')}`);
  return `${pillars.join(' + ')} · ${extras.join(' · ')}`;
}

function renderPresets() {
  const box = $('presets');
  box.hidden = !state.presets.length;
  box.replaceChildren(el('span', { class: 'label-inline' }, 'Saved recipes'),
    ...state.presets.map((p) => el('span', { class: `preset${p.id === state.presetId ? ' on' : ''}` },
      el('button', { class: 'preset-load', title: `${p.prompt || ''}\n${describeIntent(p.intent)}\n${p.set?.length ? `${p.set.length} tracks saved` : 'settings only (re-plans when loaded)'}`, onclick: () => loadPreset(p) }, p.name, p.set?.length ? el('small', { class: 'preset-count' }, ` ${p.set.length}`) : null),
      el('button', { class: 'preset-edit', title: 'Rename this recipe', onclick: (e) => renamePreset(p, e.currentTarget.closest('.preset')) }, '✎'),
      el('button', {
        class: 'preset-del', title: 'Delete this recipe',
        onclick: async () => {
          if (!(await confirmModal(`Delete the recipe "${p.name}"? (Crates you saved from it are not affected.)`, 'Delete'))) return;
          state.presets = (await api('/api/presets/delete', { id: p.id })).presets;
          if (state.presetId === p.id) state.presetId = null;
          renderPresets();
          renderPresetControls();
        },
      }, '×'))));
}

// Inline rename: the chip becomes a text field. Enter or clicking away saves, Esc cancels.
function renamePreset(p, chip) {
  const input = el('input', { type: 'text', class: 'preset-rename', value: p.name, 'aria-label': 'Recipe name' });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== p.name) {
      try {
        state.presets = (await api('/api/presets/rename', { id: p.id, name })).presets;
        if (state.presetId === p.id) $('presetName').value = name;
      } catch (e) {
        flash(e.message, 'err');
      }
    }
    renderPresets();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  chip.replaceChildren(input);
  input.focus();
  input.select();
}

function renderPresetControls() {
  const loaded = state.presets.find((p) => p.id === state.presetId);
  $('savePresetBtn').textContent = loaded ? 'Update recipe' : 'Save recipe';
  $('savePresetBtn').title = loaded ? `Overwrite "${loaded.name}" with the current brief, settings and tracks` : 'Save the brief, all settings and the exact tracks in this set';
  $('saveAsNewBtn').hidden = !loaded;
}

async function loadPresets() {
  try {
    state.presets = (await api('/api/presets')).presets;
  } catch {
    state.presets = [];
  }
  renderPresets();
  renderPresetControls();
}

async function loadPreset(p) {
  state.presetId = p.id;
  state.prompt = p.prompt || '';
  state.intent = structuredClone(p.intent);
  state.crateName = defaultCrateName(p.name);
  collapseAllFor(state.intent);
  $('prompt').value = state.prompt;
  $('presetName').value = p.name;
  $('crateName').value = state.crateName;
  renderPresets();
  renderPresetControls();
  renderIntent();
  await busy($('rebuildBtn'), async () => {
    if (p.set?.length) {
      // Recipe: bring back the exact tracks that were saved.
      const res = await api('/api/tracks', { intent: state.intent, items: p.set });
      applyPlan(res);
      if (res.missing) flash(`${res.missing} saved track${res.missing === 1 ? ' is' : 's are'} no longer in your library and were skipped.`, 'err');
    } else {
      applyPlan(await api('/api/plan', { intent: state.intent })); // older saved searches: re-plan
    }
  });
}

async function savePreset(asNew) {
  if (!state.intent) return;
  readGlobals();
  const name = $('presetName').value.trim() || state.prompt.slice(0, 40);
  if (!name) return $('presetName').focus();
  const btn = $(asNew ? 'saveAsNewBtn' : 'savePresetBtn');
  try {
    const res = await api('/api/presets', {
      id: asNew ? undefined : state.presetId, name, prompt: state.prompt, intent: state.intent,
      set: state.set.map((t) => ({ id: t.id, bucket: t.bucket })),
    });
    state.presets = res.presets;
    state.presetId = res.preset.id;
    $('presetName').value = res.preset.name;
    renderPresets();
    renderPresetControls();
    save();
    btn.textContent = 'Saved ✓';
    setTimeout(renderPresetControls, 1500);
  } catch (e) {
    flash(e.message, 'err');
  }
}

// ---------- wiring ----------

$('examples').replaceChildren(...EXAMPLES.map((x) => el('button', { onclick: () => { $('prompt').value = x; planFromPrompt(); } }, x)));
$('planBtn').onclick = planFromPrompt;
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) planFromPrompt(); });
$('rebuildBtn').onclick = () => rebuild(false);
$('shuffleBtn').onclick = () => rebuild(true);
$('addBucket').onclick = () => {
  state.intent.buckets.push({ genres: [], eras: [], share: 25, require: [], prefer: [], charts: 'off' });
  markDirty();
  renderSet();
};
for (const id of ['count', 'energy', 'popularity', 'clean', 'bpmLo', 'bpmHi', 'exclude']) $(id).addEventListener('change', markDirty);
$('resequenceBtn').onclick = () => busy($('resequenceBtn'), async () => {
  readGlobals();
  applyPlan(await api('/api/sequence', { intent: state.intent, items: state.set.map((t) => ({ id: t.id, bucket: t.bucket })) }));
});
$('skimBtn').onclick = () => (state.skimming ? stopSkim() : startSkim());
$('playBtn').onclick = () => (audio.src ? (audio.paused ? audio.play() : audio.pause()) : step(1));
$('prevBtn').onclick = () => step(-1);
$('nextBtn').onclick = () => step(1);
$('drawerClose').onclick = closeDrawer;
$('npBtn').onclick = () => suggest();
$('npShuffle').onclick = () => suggest(true);
for (const b of document.querySelectorAll('#npSort button')) {
  b.onclick = () => {
    np.sort = b.dataset.sort;
    try { localStorage.setItem('party-planner:np-sort', np.sort); } catch { /* ignore */ }
    renderSuggestions();
  };
}
$('npText').addEventListener('keydown', (e) => { if (e.key === 'Enter') suggest(); });
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setTab(b.dataset.tab);
let savedTab = 'build';
try { savedTab = localStorage.getItem('party-planner:tab') || 'build'; } catch { /* ignore */ }
savedTab = new URLSearchParams(location.search).get('tab') || savedTab;
setTab(savedTab);
pollNowPlaying();
np.timer = setInterval(() => pollNowPlaying(), 2000);
$('npRefresh').onclick = () => pollNowPlaying(true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNowPlaying(); });
window.addEventListener('focus', () => pollNowPlaying());
$('search').addEventListener('input', onSearch);
$('saveBtn').onclick = () => saveCrate(false);
$('savePresetBtn').onclick = () => savePreset(false);
$('saveAsNewBtn').onclick = () => savePreset(true);
$('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(false); });
$('crateName').addEventListener('change', (e) => { state.crateName = e.target.value; save(); });
$('infoBtn').onclick = () => openInfo(true);
$('infoClose').onclick = () => openInfo(false);
$('infoModal').addEventListener('click', (e) => { if (e.target === $('infoModal')) openInfo(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('infoModal').hidden) openInfo(false); });
$('chartsBtn').onclick = () => busy($('chartsBtn'), async () => {
  renderChartStatus({ ...state.status.charts, refreshing: true });
  const res = await api('/api/charts/refresh', {});
  state.status.charts = res.charts;
  renderChartStatus(res.charts);
});
$('reloadBtn').onclick = () => busy($('reloadBtn'), async () => { await api('/api/reload', {}); await loadStatus(); });
$('setCard').addEventListener('dblclick', (e) => { if (e.target === $('setlist')) openDrawer('add'); });

const addBtn = el('button', { class: 'ghost small', onclick: () => openDrawer('add') }, '+ Add tracks');
if (isDesktop) {
  document.body.classList.add('desktop');
  $('resequenceBtn').before(el('span', {
    class: 'drag-all', draggable: true, title: 'Drag the whole set (in play order) onto a Serato crate or the library',
    ondragstart: (e) => dragFiles(e, state.set),
  }, '⇱ Drag set into Serato'));
}
const viewToggle = el('span', { class: 'seg', id: 'viewToggle' },
  el('button', { 'data-view': 'pillar', onclick: () => { state.view = 'pillar'; renderSet(); } }, 'By pillar'),
  el('button', { 'data-view': 'order', onclick: () => { state.view = 'order'; renderSet(); } }, 'Play order'));
$('resequenceBtn').before(viewToggle, addBtn);

restore();
loadStatus().then(() => {
  loadDials();
  renderDials();
  $('prompt').value = state.prompt || '';
  $('crateName').value = state.crateName || '';
  renderIntent();
  renderSet();
  drawOverview();
  loadPresets().then(() => {
    const loaded = state.presets.find((p) => p.id === state.presetId);
    if (loaded) $('presetName').value = loaded.name;
  });
  if (new URLSearchParams(location.search).has('info')) openInfo(true);
  // ?q=... plans straight from a bookmarked brief.
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    $('prompt').value = q;
    planFromPrompt();
  }
}).catch((e) => { $('libStats').textContent = `Couldn't load library: ${e.message}`; });
