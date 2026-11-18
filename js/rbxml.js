// Rekordbox XML (DJ_PLAYLISTS) beolvasás és írás + M3U8 / szöveges export.
// Szándékosan nem használ DOMParser-t: kis, gyors tokenizáló, böngészőben és Node-ban is fut.

import { toCamelot } from './camelot.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENT[e];
  });
}

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
}

function walk(text, { open, close }) {
  const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = TAG.exec(text))) {
    const [, closing, name, attrStr, selfClose] = m;
    if (closing) { close(name); continue; }
    const attrs = {};
    if (attrStr) {
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(attrStr))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
    }
    open(name, attrs, !!selfClose);
    if (selfClose) close(name);
  }
}

export function normalizeTrack(a) {
  const bpm = parseFloat(a.AverageBpm) || 0;
  return {
    id: String(a.TrackID),
    title: a.Name || '',
    artist: a.Artist || '',
    album: a.Album || '',
    genre: a.Genre || '',
    bpm,
    key: a.Tonality || '',
    camelot: toCamelot(a.Tonality),
    duration: parseInt(a.TotalTime, 10) || 0,
    rating: Math.round((parseInt(a.Rating, 10) || 0) / 51),
    year: parseInt(a.Year, 10) || 0,
    comments: a.Comments || '',
    kind: a.Kind || '',
    added: a.DateAdded || '',
    location: a.Location || '',
    raw: a, // az eredeti attribútumok, hogy az export visszaolvasható legyen a Rekordboxban
  };
}

/** @returns {{tracks: object[], playlists: {name:string, path:string[], trackIds:string[]}[]}} */
export function parseRekordboxXml(text) {
  const tracks = [];
  const playlists = [];
  let inColl = false, inPl = false, inTrack = false;
  const nodes = []; // { kind:'folder'|'playlist', name, pl? }
  let curPl = null;

  walk(text, {
    open(name, attrs) {
      if (name === 'COLLECTION') inColl = true;
      else if (name === 'PLAYLISTS') inPl = true;
      else if (inColl && name === 'TRACK' && !inTrack) {
        if (attrs.TrackID != null) tracks.push(normalizeTrack(attrs));
        inTrack = true;
      } else if (inPl && name === 'NODE') {
        if (attrs.Type === '1') {
          const path = nodes.filter((n) => n.kind === 'folder' && n.name !== 'ROOT').map((n) => n.name);
          curPl = { name: attrs.Name || 'Playlist', path, keyType: attrs.KeyType || '0', keys: [] };
          nodes.push({ kind: 'playlist', pl: curPl });
        } else {
          nodes.push({ kind: 'folder', name: attrs.Name || '' });
        }
      } else if (inPl && curPl && name === 'TRACK' && attrs.Key != null) {
        curPl.keys.push(attrs.Key);
      }
    },
    close(name) {
      if (name === 'COLLECTION') inColl = false;
      else if (name === 'PLAYLISTS') inPl = false;
      else if (name === 'TRACK') inTrack = false;
      else if (name === 'NODE' && inPl) {
        const n = nodes.pop();
        if (n && n.kind === 'playlist') { playlists.push(n.pl); curPl = null; }
      }
    },
  });

  const byLoc = new Map(tracks.map((t) => [t.location, t.id]));
  const out = playlists.map((p) => ({
    name: p.name,
    path: p.path,
    trackIds: p.keys.map((k) => (p.keyType === '1' ? byLoc.get(k) : String(k))).filter(Boolean),
  }));
  return { tracks, playlists: out };
}

/** Rekordbox-kompatibilis XML a megadott listákból. A rendszer csak a használt trackeket írja ki. */
export function buildRekordboxXml(playlists, trackById) {
  const used = new Map();
  for (const p of playlists) for (const id of p.trackIds) if (trackById.has(id)) used.set(id, trackById.get(id));
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
    '  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>',
    `  <COLLECTION Entries="${used.size}">`];
  for (const t of used.values()) {
    const raw = { ...(t.raw || {}), TrackID: t.id };
    const attrs = Object.entries(raw).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ');
    lines.push(`    <TRACK ${attrs}/>`);
  }
  lines.push('  </COLLECTION>', '  <PLAYLISTS>', `    <NODE Type="0" Name="ROOT" Count="${playlists.length}">`);
  for (const p of playlists) {
    const ids = p.trackIds.filter((id) => used.has(id));
    lines.push(`      <NODE Name="${escapeXml(p.name)}" Type="1" KeyType="0" Entries="${ids.length}">`);
    for (const id of ids) lines.push(`        <TRACK Key="${escapeXml(id)}"/>`);
    lines.push('      </NODE>');
  }
  lines.push('    </NODE>', '  </PLAYLISTS>', '</DJ_PLAYLISTS>', '');
  return lines.join('\n');
}

export function locationToPath(loc) {
  let p = (loc || '').replace(/^file:\/\/(localhost)?/, '');
  try { p = decodeURIComponent(p); } catch { /* marad az eredeti */ }
  return p;
}

export function buildM3u(trackIds, trackById) {
  const out = ['#EXTM3U'];
  for (const id of trackIds) {
    const t = trackById.get(id);
    if (!t) continue;
    out.push(`#EXTINF:${t.duration},${[t.artist, t.title].filter(Boolean).join(' - ')}`, locationToPath(t.location));
  }
  return out.join('\n') + '\n';
}

export function buildTracklistText(name, trackIds, trackById) {
  const lines = [name];
  let i = 1;
  for (const id of trackIds) {
    const t = trackById.get(id);
    if (!t) continue;
    const meta = [t.camelot || t.key, t.bpm ? Math.round(t.bpm) + ' BPM' : ''].filter(Boolean).join(', ');
    lines.push(`${i++}. ${[t.artist, t.title].filter(Boolean).join(' – ')}${meta ? ` [${meta}]` : ''}`);
  }
  return lines.join('\n');
}
