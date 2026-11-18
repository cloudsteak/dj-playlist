import * as db from './db.js';
import { parseRekordboxXml, buildRekordboxXml, buildM3u, buildTracklistText } from './rbxml.js';
import { filterTracks, keySet, sortTracks, setStats, transition, buildSet, median } from './planner.js';
import { ALL_KEYS, parseCamelot } from './camelot.js';
import { buildPrompt, parseAiResponse, askClaude } from './ai.js';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'dj.apiKey', LS_MODEL = 'dj.model', LS_VIEW = 'dj.view', LS_CUR = 'dj.cur';

const S = {
  tracks: [], byId: new Map(), playlists: [], currentId: null,
  f: { text: '', bpmMin: '', bpmMax: '', key: '', keyMode: 'harmonic', genre: '', ratingMin: 0, sort: 'title', dir: 1 },
  list: [], shown: 0,
};

/* ---------- segédek ---------- */
// Minden megjelenített szöveg textContent-ként kerül be (az XML-ből jövő adat sosem HTML).
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* privát mód */ } };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtDur = (s) => `${Math.floor(s / 3600)}ó ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}p`;
const tick = () => new Promise((r) => setTimeout(r, 30));

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function guarded(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(`Hiba: ${e.message || e}`, 6000); }
}

/* ---------- nézetek ---------- */
function setView(v) {
  document.body.dataset.view = v;
  for (const b of $('nav').children) b.classList.toggle('active', b.dataset.view === v);
  lsSet(LS_VIEW, v);
  window.scrollTo(0, 0);
}

/* ---------- könyvtár ---------- */
function prepare(tracks) {
  for (const t of tracks) t.hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.comments}`.toLowerCase();
  return tracks;
}

function keyBadge(t) {
  const p = parseCamelot(t.camelot);
  return h('div', { class: `kb${p ? ` k${p.n}` : ' none'}`, title: t.key ? `Kulcs: ${t.key}` : 'Ismeretlen kulcs' }, t.camelot || '?');
}

function subline(t) {
  return [t.artist, t.genre, fmtTime(t.duration), t.year || '', t.rating ? '★'.repeat(t.rating) : ''].filter(Boolean).join(' · ');
}

function bpmCell(t) {
  return h('div', { class: 'bpm' }, h('b', {}, t.bpm ? t.bpm.toFixed(1) : '–'), h('small', {}, 'BPM'));
}

function metaCell(t) {
  return h('div', { class: 'meta' }, h('div', { class: 'title' }, t.title || '(cím nélkül)'), h('div', { class: 'sub' }, subline(t)));
}

function currentFilters() {
  const f = S.f;
  return { ...f, keys: keySet(f.key, f.keyMode) };
}

function refreshLibrary() {
  const f = S.f;
  const active = [f.bpmMin, f.bpmMax, f.key, f.genre, f.ratingMin].filter(Boolean).length;
  $('f-active-n').textContent = String(active); $('f-active-n').hidden = !active;
  const filtered = filterTracks(S.tracks, currentFilters());
  S.list = sortTracks(filtered, S.f.sort, S.f.dir);
  S.shown = 0;
  $('lib-list').replaceChildren();
  $('lib-empty').hidden = S.tracks.length > 0;
  $('lib-count').textContent = S.tracks.length ? `${S.list.length} / ${S.tracks.length} track` : '';
  renderMore();
}

function renderMore() {
  if (S.shown >= S.list.length) return;
  const frag = document.createDocumentFragment();
  for (const t of S.list.slice(S.shown, S.shown + 60)) {
    const inSet = cur().trackIds.includes(t.id);
    const btn = h('button', { class: `add${inSet ? ' done' : ''}`, 'aria-label': 'Hozzáadás a szetthez', onclick: () => { addToSet(t.id); btn.textContent = '✓'; btn.classList.add('done'); } }, inSet ? '✓' : '+');
    frag.append(h('li', { class: 'track' }, keyBadge(t), metaCell(t), bpmCell(t), btn));
  }
  S.shown += 60;
  $('lib-list').append(frag);
}

function fillSelects() {
  const keySel = $('f-key');
  keySel.replaceChildren(h('option', { value: '' }, 'Bármely'), ...ALL_KEYS.map((k) => h('option', { value: k }, k)));
  const counts = new Map();
  for (const t of S.tracks) if (t.genre) counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
  const genres = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => h('option', { value: g }, `${g} (${n})`));
  for (const id of ['f-genre', 'a-genre']) $(id).replaceChildren(h('option', { value: '' }, 'Mind'), ...genres.map((o) => o.cloneNode(true)));
  $('f-key').value = S.f.key;
  $('f-genre').value = S.f.genre;
}

function bindFilters() {
  let timer;
  $('f-text').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { S.f.text = e.target.value; refreshLibrary(); }, 150);
  });
  const map = { 'f-bpmmin': 'bpmMin', 'f-bpmmax': 'bpmMax', 'f-key': 'key', 'f-keymode': 'keyMode', 'f-genre': 'genre', 'f-sort': 'sort' };
  for (const [id, k] of Object.entries(map)) $(id).addEventListener('input', (e) => { S.f[k] = e.target.value; refreshLibrary(); });
  $('f-rating').addEventListener('input', (e) => { S.f.ratingMin = +e.target.value; refreshLibrary(); });
  $('f-dir').addEventListener('click', () => {
    S.f.dir = -S.f.dir;
    $('f-dir').textContent = S.f.dir > 0 ? '↑ Növekvő' : '↓ Csökkenő';
    refreshLibrary();
  });
  $('f-toggle').addEventListener('click', () => { $('filters').hidden = !$('filters').hidden; });
  $('f-reset').addEventListener('click', () => {
    Object.assign(S.f, { text: '', bpmMin: '', bpmMax: '', key: '', genre: '', ratingMin: 0 });
    $('f-text').value = ''; $('f-bpmmin').value = ''; $('f-bpmmax').value = '';
    $('f-key').value = ''; $('f-genre').value = ''; $('f-rating').value = '0';
    refreshLibrary();
  });
  new IntersectionObserver((en) => { if (en.some((x) => x.isIntersecting)) renderMore(); }, { rootMargin: '600px' })
    .observe($('lib-more'));
}

/* ---------- lejátszási listák / szett ---------- */
const cur = () => S.playlists.find((p) => p.id === S.currentId);

// Késleltetett (összevont) mentés; az oldal háttérbe kerülésekor / bezárásakor azonnal kiíródik.
const pending = new Set();
let saveTimer;
function flushSaves() {
  clearTimeout(saveTimer);
  if (!pending.size) return Promise.resolve();
  const batch = [...pending];
  pending.clear();
  return db.putPlaylists(batch).catch((e) => toast(`Mentési hiba: ${e.message}`));
}
function persist(pl = cur(), now = false) {
  if (!pl) return;
  pl.updated = Date.now();
  pending.add(pl);
  clearTimeout(saveTimer);
  if (now) flushSaves(); else saveTimer = setTimeout(flushSaves, 80);
}
addEventListener('pagehide', flushSaves);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });

function newPlaylist(name, trackIds = [], extra = {}) {
  const pl = { id: crypto.randomUUID(), name, trackIds, created: Date.now(), updated: Date.now(), ...extra };
  S.playlists.push(pl);
  return pl;
}

function addToSet(id) {
  const pl = cur();
  if (pl.trackIds.includes(id)) { toast('Már a szettben van.'); return; }
  pl.trackIds.push(id);
  persist(); renderSet();
  toast(`+ ${S.byId.get(id)?.title || id}`, 1200);
}

function moveInSet(i, d) {
  const a = cur().trackIds, j = i + d;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  persist(); renderSet();
}

function findNext(t) {
  Object.assign(S.f, { key: t.camelot || '', keyMode: 'harmonic', bpmMin: t.bpm ? Math.floor(t.bpm * 0.94) : '', bpmMax: t.bpm ? Math.ceil(t.bpm * 1.06) : '', text: '' });
  $('f-key').value = S.f.key; $('f-keymode').value = 'harmonic';
  $('f-bpmmin').value = S.f.bpmMin; $('f-bpmmax').value = S.f.bpmMax; $('f-text').value = '';
  $('filters').hidden = false;
  refreshLibrary(); setView('library');
  toast(`Illeszkedő számok: ${t.camelot || '?'} ±1, BPM ±6%`);
}

function renderPlaylistSelect() {
  const sel = $('pl-select');
  sel.replaceChildren(...S.playlists.map((p) => h('option', { value: p.id }, `${p.name} (${p.trackIds.length})`)));
  sel.value = S.currentId;
}

function renderSet() {
  const pl = cur();
  lsSet(LS_CUR, pl.id);
  const tracks = pl.trackIds.map((id) => S.byId.get(id)).filter(Boolean);
  $('set-badge').textContent = String(pl.trackIds.length);
  renderPlaylistSelect();
  const st = setStats(tracks);
  $('set-stats').textContent = st.count
    ? `${st.count} track · ${fmtDur(st.duration)}${st.bpmMin ? ` · ${Math.round(st.bpmMin)}–${Math.round(st.bpmMax)} BPM` : ''}`
    : '';
  $('set-empty').hidden = pl.trackIds.length > 0;
  const list = $('set-list');
  list.replaceChildren();
  let prev = null;
  pl.trackIds.forEach((id, i) => {
    const t = S.byId.get(id);
    const remove = h('button', { class: 'danger', onclick: (e) => { e.stopPropagation(); pl.trackIds.splice(i, 1); persist(); renderSet(); } }, 'Eltávolít');
    if (!t) {
      list.append(h('li', { class: 'track missing' }, h('div', { class: 'num' }, i + 1), h('div', { class: 'kb none' }, '?'),
        h('div', { class: 'meta' }, h('div', { class: 'title' }, `Hiányzó track #${id}`), h('div', { class: 'sub' }, 'Nincs az importált könyvtárban')), remove));
      return;
    }
    let tr = null;
    if (prev) {
      const x = transition(prev, t);
      const parts = [];
      if (x.bpmDiff !== null) parts.push(`${x.bpmDiff >= 0 ? '+' : ''}${x.bpmDiff.toFixed(1)} BPM`);
      parts.push(x.keyDistance === null ? 'kulcs ismeretlen' : x.keyDistance <= 1 ? 'harmonikus' : x.keyDistance === 2 ? 'energia-ugrás' : 'kulcsütközés');
      tr = h('div', { class: `tr ${x.level}` }, parts.join(' · '));
    }
    const bar = h('div', { class: 'bar' },
      h('button', { onclick: (e) => { e.stopPropagation(); findNext(t); } }, 'Illeszkedő következő'),
      h('button', { 'aria-label': 'Feljebb', onclick: (e) => { e.stopPropagation(); moveInSet(i, -1); } }, '↑'),
      h('button', { 'aria-label': 'Lejjebb', onclick: (e) => { e.stopPropagation(); moveInSet(i, 1); } }, '↓'),
      remove);
    const row = h('li', { class: 'track', onclick: () => {
      const was = row.classList.contains('open');
      for (const o of list.querySelectorAll('.open')) o.classList.remove('open');
      if (!was) row.classList.add('open');
    } }, tr, h('div', { class: 'num' }, i + 1), keyBadge(t), metaCell(t), bpmCell(t), bar);
    list.append(row);
    prev = t;
  });
}

function bindSet() {
  $('pl-menu').addEventListener('click', (e) => { if (e.target.closest('.pop button')) setTimeout(() => ($('pl-menu').open = false), 0); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#pl-menu')) $('pl-menu').open = false; });
  $('pl-select').addEventListener('change', (e) => { S.currentId = e.target.value; renderSet(); });
  $('pl-new').addEventListener('click', () => {
    const name = prompt('Új lista neve:', `Szett ${new Date().toLocaleDateString('hu-HU')}`);
    if (!name) return;
    S.currentId = newPlaylist(name.trim()).id;
    persist(cur(), true); renderSet();
  });
  $('pl-rename').addEventListener('click', () => {
    const name = prompt('Lista neve:', cur().name);
    if (name) { cur().name = name.trim(); persist(); renderSet(); }
  });
  $('pl-dup').addEventListener('click', () => {
    const p = newPlaylist(`${cur().name} (másolat)`, [...cur().trackIds]);
    S.currentId = p.id; persist(p, true); renderSet();
  });
  $('pl-del').addEventListener('click', () => guarded(async () => {
    if (!confirm(`Törlöd a(z) "${cur().name}" listát?`)) return;
    const id = S.currentId;
    S.playlists = S.playlists.filter((p) => p.id !== id);
    await db.deletePlaylist(id);
    if (!S.playlists.length) { newPlaylist('Új szett'); persist(S.playlists[0]); }
    S.currentId = S.playlists[0].id;
    renderSet();
  }));
  $('pl-clear').addEventListener('click', () => {
    if (cur().trackIds.length && confirm('Kiüríted a szettet?')) { cur().trackIds = []; persist(); renderSet(); }
  });
  $('ex-xml').addEventListener('click', () => saveFile(`${safeName(cur().name)}.xml`, 'text/xml', buildRekordboxXml([cur()], S.byId)));
  $('ex-m3u').addEventListener('click', () => saveFile(`${safeName(cur().name)}.m3u8`, 'text/plain', buildM3u(cur().trackIds, S.byId)));
  $('ex-txt').addEventListener('click', () => guarded(async () => {
    await navigator.clipboard.writeText(buildTracklistText(cur().name, cur().trackIds, S.byId));
    toast('Tracklista a vágólapra másolva.');
  }));
}

/* ---------- export / fájlkezelés ---------- */
const safeName = (s) => s.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'lista';

function saveFile(name, mime, text) {
  guarded(async () => {
    const file = new File([text], name, { type: mime });
    const touch = matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = h('a', { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`${name} letöltve.`);
  });
}

/* ---------- import / adatok ---------- */
function updateInfo() {
  $('d-info').textContent = S.tracks.length
    ? `${S.tracks.length} track a helyi könyvtárban (${S.tracks.filter((t) => /wav/i.test(t.kind)).length} WAV).`
    : 'Még nincs importált gyűjtemény.';
}

async function importXml(file) {
  toast('Beolvasás…', 60000); await tick();
  const { tracks, playlists } = parseRekordboxXml(await file.text());
  if (!tracks.length) throw new Error('Nem található track. Rekordboxban: File → Export Collection in xml format.');
  await db.replaceTracks(tracks);
  S.tracks = prepare(tracks);
  S.byId = new Map(tracks.map((t) => [t.id, t]));
  let imported = 0;
  if ($('d-pl').checked) {
    for (const p of playlists) {
      const rbPath = [...p.path, p.name].join('/');
      const ex = S.playlists.find((x) => x.rbPath === rbPath);
      if (ex) { ex.trackIds = p.trackIds; persist(ex); } else { persist(newPlaylist(rbPath, p.trackIds, { rbPath }), true); }
      imported++;
    }
  }
  fillSelects(); refreshLibrary(); renderSet(); updateInfo();
  toast(`${tracks.length} track, ${imported} lista importálva.`);
  setView('library');
}

function bindData() {
  $('d-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) guarded(() => importXml(f)); e.target.value = ''; });
  $('d-xmlall').addEventListener('click', () => saveFile('dj-playlists.xml', 'text/xml', buildRekordboxXml(S.playlists.filter((p) => p.trackIds.length), S.byId)));
  $('d-backup').addEventListener('click', () => saveFile('dj-playlists-backup.json', 'application/json', JSON.stringify({ version: 1, playlists: S.playlists }, null, 1)));
  $('d-restore').addEventListener('change', (e) => guarded(async () => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.playlists)) throw new Error('Érvénytelen mentés.');
    let n = 0;
    for (const p of data.playlists) {
      if (typeof p.name !== 'string' || !Array.isArray(p.trackIds)) continue;
      const clean = { ...p, id: typeof p.id === 'string' ? p.id : crypto.randomUUID(), trackIds: p.trackIds.map(String) };
      const i = S.playlists.findIndex((x) => x.id === clean.id);
      if (i >= 0) S.playlists[i] = clean; else S.playlists.push(clean);
      persist(clean); n++;
    }
    renderSet(); toast(`${n} lista visszaállítva.`);
  }));
  $('s-key').value = lsGet(LS_KEY);
  $('s-model').value = lsGet(LS_MODEL) || 'claude-sonnet-5-5';
  $('s-save').addEventListener('click', () => { lsSet(LS_KEY, $('s-key').value.trim()); lsSet(LS_MODEL, $('s-model').value.trim()); toast('Beállítások mentve.'); });
  $('s-forget').addEventListener('click', () => { lsSet(LS_KEY, ''); $('s-key').value = ''; toast('API-kulcs törölve.'); });
  $('d-wipe').addEventListener('click', () => guarded(async () => {
    if (!confirm('Törlöd az összes helyi adatot (könyvtár és listák)? Előbb érdemes menteni.')) return;
    await db.wipe();
    lsSet(LS_KEY, ''); lsSet(LS_MODEL, '');
    location.reload();
  }));
}

/* ---------- auto / AI ---------- */
function autoPool() {
  const rating = +$('a-rating').value;
  const genre = $('a-genre').value;
  const startBpm = +$('a-start').value || 0, endBpm = +$('a-end').value || 0;
  const lo = startBpm || endBpm ? Math.min(startBpm || endBpm, endBpm || startBpm) * 0.92 : 0;
  const hi = startBpm || endBpm ? Math.max(startBpm, endBpm) * 1.08 : 0;
  const pool = filterTracks(S.tracks, { genre, ratingMin: rating, bpmMin: lo, bpmMax: hi || '' }).filter((t) => t.bpm > 0);
  return { pool, startBpm, endBpm, count: Math.max(3, Math.min(200, +$('a-count').value || 20)) };
}

function commitGenerated(ids, label) {
  const p = newPlaylist(`${label} ${new Date().toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })}`, ids);
  S.currentId = p.id; persist(p, true); renderSet(); setView('set');
}

function bindAuto() {
  $('a-offline').addEventListener('click', () => guarded(async () => {
    if (!S.tracks.length) throw new Error('Előbb importáld a Rekordbox gyűjteményt.');
    const { pool, startBpm, endBpm, count } = autoPool();
    if (pool.length < 3) throw new Error('Túl kevés illeszkedő track a megadott feltételekkel.');
    const startId = $('a-startmode').value === 'first' ? cur().trackIds[0] : undefined;
    const set = buildSet(pool, { count, startBpm, endBpm, startId });
    commitGenerated(set.map((t) => t.id), 'Auto');
    $('a-notes').hidden = true;
    toast(`${set.length} track összeállítva.`);
  }));

  $('a-ai').addEventListener('click', () => guarded(async () => {
    const btn = $('a-ai');
    if (!S.tracks.length) throw new Error('Előbb importáld a Rekordbox gyűjteményt.');
    const apiKey = lsGet(LS_KEY);
    if (!apiKey) throw new Error('Add meg az API-kulcsot az Adatok fülön.');
    const { pool, startBpm, endBpm, count } = autoPool();
    if (pool.length < 3) throw new Error('Túl kevés illeszkedő track a megadott feltételekkel.');
    // az AI-nak max. ~400 jelölt megy: egyenletes véletlen minta, hogy a kontextus és a költség kordában maradjon
    const sample = pool.length > 400 ? [...pool].sort(() => Math.random() - 0.5).slice(0, 400) : pool;
    const { system, user } = buildPrompt({ pool: sample, brief: $('a-brief').value.trim(), count, startBpm, endBpm });
    btn.disabled = true; btn.textContent = 'Az AI dolgozik…';
    try {
      const text = await askClaude({ apiKey, model: lsGet(LS_MODEL) || 'claude-sonnet-5-5', system, user });
      const { ids, notes } = parseAiResponse(text, new Set(sample.map((t) => t.id)));
      if (ids.length < 3) throw new Error('Az AI nem adott használható listát. Próbáld újra.');
      commitGenerated(ids, 'AI');
      $('a-notes').textContent = notes; $('a-notes').hidden = !notes;
      toast(`${ids.length} track összeállítva az AI-val.`);
    } finally {
      btn.disabled = false; btn.textContent = 'Szett építése AI-val';
    }
  }));
}

/* ---------- indulás ---------- */
async function init() {
  for (const b of $('nav').children) b.addEventListener('click', () => setView(b.dataset.view));
  for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => setView(b.dataset.goto));
  bindFilters(); bindSet(); bindData(); bindAuto();
  try {
    S.tracks = prepare(await db.allTracks());
    S.byId = new Map(S.tracks.map((t) => [t.id, t]));
    S.playlists = (await db.allPlaylists()).sort((a, b) => b.updated - a.updated);
  } catch (e) {
    toast(`Az adatbázis nem érhető el: ${e.message}`, 8000);
  }
  if (!S.playlists.length) newPlaylist('Új szett');
  S.currentId = (S.playlists.find((p) => p.id === lsGet(LS_CUR)) || S.playlists[0]).id;
  fillSelects(); refreshLibrary(); renderSet(); updateInfo();
  setView(S.tracks.length ? lsGet(LS_VIEW) || 'library' : 'data');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
