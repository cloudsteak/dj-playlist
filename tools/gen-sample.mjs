// Szintetikus Rekordbox-XML generátor kipróbáláshoz: node tools/gen-sample.mjs [darab] [kimenet]
import { writeFileSync } from 'node:fs';
import { mulberry32 } from '../js/planner.js';
import { escapeXml } from '../js/rbxml.js';

export function generateSampleXml(n = 5000, seed = 1) {
  const rng = mulberry32(seed);
  const genres = ['House', 'Deep House', 'Tech House', 'Techno', 'Disco', 'Funk', 'Hip-Hop', 'Drum & Bass'];
  const keys = [];
  for (let i = 1; i <= 12; i++) keys.push(`${i}A`, `${i}B`);
  const musical = ['Am', 'C', 'F#m', 'Bbm', 'Eb', 'D', 'Gm', 'A'];
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
    '<PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>', `<COLLECTION Entries="${n}">`];
  for (let i = 1; i <= n; i++) {
    const bpm = (95 + rng() * 80).toFixed(2);
    const key = rng() < 0.15 ? musical[Math.floor(rng() * musical.length)] : keys[Math.floor(rng() * keys.length)];
    const a = {
      TrackID: i, Name: `Track ${i} & "Mix" <${i}>`, Artist: `Artist ${1 + Math.floor(rng() * 400)}`,
      Album: '', Genre: genres[Math.floor(rng() * genres.length)], Kind: rng() < 0.9 ? 'WAV File' : 'MP3 File',
      TotalTime: 180 + Math.floor(rng() * 300), Year: 1990 + Math.floor(rng() * 35), AverageBpm: bpm,
      DateAdded: `20${15 + Math.floor(rng() * 10)}-0${1 + Math.floor(rng() * 9)}-1${Math.floor(rng() * 9)}`,
      Rating: 51 * Math.floor(rng() * 6), Comments: '', Tonality: key,
      Location: `file://localhost/Users/dj/Music/${encodeURIComponent(`Track ${i}.wav`)}`,
    };
    lines.push(`<TRACK ${Object.entries(a).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ')}><TEMPO Inizio="0.0" Bpm="${bpm}" Metro="4/4" Battito="1"/></TRACK>`);
  }
  lines.push('</COLLECTION>', '<PLAYLISTS>', '<NODE Type="0" Name="ROOT" Count="2">',
    '<NODE Name="Warmup" Type="1" KeyType="0" Entries="3"><TRACK Key="1"/><TRACK Key="2"/><TRACK Key="3"/></NODE>',
    '<NODE Name="Régi" Type="0" Count="1"><NODE Name="Klasszikusok" Type="1" KeyType="0" Entries="2"><TRACK Key="10"/><TRACK Key="11"/></NODE></NODE>',
    '</NODE>', '</PLAYLISTS>', '</DJ_PLAYLISTS>', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const n = +process.argv[2] || 5000;
  const out = process.argv[3] || 'samples/sample-collection.xml';
  writeFileSync(out, generateSampleXml(n));
  console.log(`${n} track -> ${out}`);
}
