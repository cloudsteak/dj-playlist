// Szűrés, rendezés, statisztika és az offline automatikus szett-építő.

import { keyDistance, keyOrder, compatibleKeys } from './camelot.js';

export function keySet(key, mode) {
  if (!key) return null;
  if (mode === 'exact') return new Set([key]);
  return compatibleKeys(key, mode === 'energy');
}

const hayOf = (t) => t.hay || `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.comments}`.toLowerCase();

export function filterTracks(tracks, f = {}) {
  const words = (f.text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const genre = (f.genre || '').toLowerCase();
  const bmin = +f.bpmMin || 0;
  const bmax = +f.bpmMax || Infinity;
  const ks = f.keys || null;
  return tracks.filter((t) => {
    if (bmin && t.bpm < bmin) return false;
    if (t.bpm > bmax) return false;
    if (ks && !ks.has(t.camelot)) return false;
    if (genre && t.genre.toLowerCase() !== genre) return false;
    if (f.ratingMin && t.rating < f.ratingMin) return false;
    if (words.length) {
      const h = hayOf(t);
      for (const w of words) if (!h.includes(w)) return false;
    }
    return true;
  });
}

const SORTERS = {
  title: (t) => t.title.toLowerCase(),
  artist: (t) => t.artist.toLowerCase(),
  bpm: (t) => t.bpm,
  key: (t) => keyOrder(t.camelot),
  year: (t) => t.year,
  added: (t) => t.added,
  rating: (t) => t.rating,
  duration: (t) => t.duration,
};

export function sortTracks(list, by = 'title', dir = 1) {
  const f = SORTERS[by] || SORTERS.title;
  return [...list].sort((a, b) => {
    const x = f(a), y = f(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

export function median(nums) {
  const a = nums.filter((n) => n > 0).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

export function setStats(tracks) {
  const bpms = tracks.map((t) => t.bpm).filter((b) => b > 0);
  return {
    count: tracks.length,
    duration: tracks.reduce((s, t) => s + t.duration, 0),
    bpmMin: bpms.length ? Math.min(...bpms) : 0,
    bpmMax: bpms.length ? Math.max(...bpms) : 0,
  };
}

/** Átmenet minősége két egymást követő track között. */
export function transition(prev, cur) {
  const d = keyDistance(prev.camelot, cur.camelot);
  const bpmDiff = prev.bpm && cur.bpm ? cur.bpm - prev.bpm : null;
  let level = 'warn';
  if (d !== null && d <= 1) level = 'ok';
  else if (d === null || d > 2) level = 'bad';
  if (bpmDiff !== null && Math.abs(bpmDiff) > 8 && level === 'ok') level = 'warn';
  return { level, keyDistance: d, bpmDiff };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mohó szett-építő: BPM-ív (startBpm -> endBpm) mentén, harmonikus kulcsváltásokkal.
 * @returns {object[]} a kiválasztott trackek sorrendben
 */
export function buildSet(pool, { count = 20, startBpm, endBpm, startId, rng = Math.random, avoidArtistRepeat = true } = {}) {
  const cands = pool.filter((t) => t.bpm > 0);
  if (!cands.length) return [];
  const n = Math.min(count, cands.length);
  const sb = startBpm || median(cands.map((t) => t.bpm));
  const eb = endBpm || sb;
  const target = (i) => (n === 1 ? sb : sb + ((eb - sb) * i) / (n - 1));

  let cur = startId ? cands.find((t) => t.id === startId) : null;
  if (!cur) {
    const near = [...cands].sort((a, b) => Math.abs(a.bpm - sb) - Math.abs(b.bpm - sb)).slice(0, 5);
    cur = near[Math.floor(rng() * near.length)];
  }
  const out = [cur];
  const used = new Set([cur.id]);
  while (out.length < n) {
    const prev = out[out.length - 1];
    const tg = target(out.length);
    let best = null, bestScore = Infinity;
    for (const t of cands) {
      if (used.has(t.id)) continue;
      const d = keyDistance(prev.camelot, t.camelot);
      const keyPenalty = d === null ? 3 : d <= 1 ? 0 : d === 2 ? 1.5 : 5 + d;
      let s = Math.abs(t.bpm - prev.bpm) * 0.8 + Math.abs(t.bpm - tg) * 0.6 + keyPenalty + rng() * 1.5;
      if (avoidArtistRepeat && t.artist && t.artist === prev.artist) s += 3;
      if (s < bestScore) { bestScore = s; best = t; }
    }
    out.push(best);
    used.add(best.id);
  }
  return out;
}
