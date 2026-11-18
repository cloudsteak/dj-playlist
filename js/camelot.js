// Hangnem-kezelés: Rekordbox "Tonality" érték (pl. "8A", "Am", "F#m", "Bbm") -> Camelot kód.

const MAJOR = { B: 1, 'F#': 2, Gb: 2, Db: 3, 'C#': 3, Ab: 4, 'G#': 4, Eb: 5, 'D#': 5, Bb: 6, 'A#': 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 };
const MINOR = { Ab: 1, 'G#': 1, Eb: 2, 'D#': 2, Bb: 3, 'A#': 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12 };

export const ALL_KEYS = [];
for (let n = 1; n <= 12; n++) ALL_KEYS.push(`${n}A`, `${n}B`);

/** Bármilyen jelölésből Camelot kód ("8A"), vagy '' ha ismeretlen. */
export function toCamelot(input) {
  if (!input) return '';
  const s = String(input).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  let m = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (m) {
    const n = +m[1];
    return n >= 1 && n <= 12 ? `${n}${m[2].toUpperCase()}` : '';
  }
  m = /^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?$/.exec(s);
  if (!m) return '';
  const note = m[1].toUpperCase() + m[2];
  const minor = /^m(in|inor)?$/.test(m[3] || '') && m[3] !== 'maj' && m[3] !== 'major';
  const n = (minor ? MINOR : MAJOR)[note];
  return n ? `${n}${minor ? 'A' : 'B'}` : '';
}

export function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/.exec(c || '');
  return m ? { n: +m[1], l: m[2] } : null;
}

/** Rendezési érték: 1A, 1B, 2A, ... ismeretlen a végén. */
export function keyOrder(c) {
  const p = parseCamelot(c);
  return p ? p.n * 2 + (p.l === 'B' ? 1 : 0) : 99;
}

/** 0 = azonos, 1 = harmonikus (±1 / relatív), 2 = energia-ugrás (±2), nagyobb = disszonáns, null = ismeretlen. */
export function keyDistance(a, b) {
  const pa = parseCamelot(a), pb = parseCamelot(b);
  if (!pa || !pb) return null;
  let d = Math.abs(pa.n - pb.n);
  d = Math.min(d, 12 - d);
  if (pa.l === pb.l) return d;
  return d === 0 ? 1 : d + 2;
}

/** A megadott kulccsal harmonikus kulcsok halmaza. energy=true: ±2 is. */
export function compatibleKeys(c, energy = false) {
  const set = new Set();
  for (const k of ALL_KEYS) {
    const d = keyDistance(c, k);
    if (d !== null && (d <= 1 || (energy && d === 2))) set.add(k);
  }
  return set;
}
