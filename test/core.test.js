import test from 'node:test';
import assert from 'node:assert/strict';
import { toCamelot, keyDistance, compatibleKeys } from '../js/camelot.js';
import { parseRekordboxXml, buildRekordboxXml, buildM3u, escapeXml } from '../js/rbxml.js';
import { filterTracks, buildSet, mulberry32, transition, keySet } from '../js/planner.js';
import { parseAiResponse, buildPrompt, askClaude } from '../js/ai.js';
import { generateSampleXml } from '../tools/gen-sample.mjs';

test('toCamelot: Camelot, zenei jelölések, ismeretlen', () => {
  assert.equal(toCamelot('8A'), '8A');
  assert.equal(toCamelot('12b'), '12B');
  assert.equal(toCamelot('Am'), '8A');
  assert.equal(toCamelot('C'), '8B');
  assert.equal(toCamelot('F#m'), '11A');
  assert.equal(toCamelot('Bbm'), '3A');
  assert.equal(toCamelot('Bb'), '6B');
  assert.equal(toCamelot('B'), '1B');
  assert.equal(toCamelot('Dbm'), '12A');
  assert.equal(toCamelot('13A'), '');
  assert.equal(toCamelot(''), '');
  assert.equal(toCamelot('valami'), '');
});

test('keyDistance és compatibleKeys', () => {
  assert.equal(keyDistance('8A', '8A'), 0);
  assert.equal(keyDistance('8A', '9A'), 1);
  assert.equal(keyDistance('12A', '1A'), 1); // körbeér
  assert.equal(keyDistance('8A', '8B'), 1); // relatív
  assert.equal(keyDistance('8A', '10A'), 2);
  assert.equal(keyDistance('8A', '2A'), 6);
  assert.equal(keyDistance('8A', ''), null);
  assert.deepEqual([...compatibleKeys('8A')].sort(), ['7A', '8A', '8B', '9A']);
  assert.equal(compatibleKeys('8A', true).size, 6);
});

test('Rekordbox XML: beolvasás, speciális karakterek, lejátszási listák', () => {
  const { tracks, playlists } = parseRekordboxXml(generateSampleXml(50));
  assert.equal(tracks.length, 50);
  assert.equal(tracks[0].title, 'Track 1 & "Mix" <1>');
  assert.ok(tracks.every((t) => t.bpm > 0));
  assert.equal(playlists.length, 2);
  assert.deepEqual(playlists[0].trackIds, ['1', '2', '3']);
  assert.deepEqual(playlists[1].path, ['Régi']);
});

test('Rekordbox XML: export -> import körút megőrzi az adatokat', () => {
  const { tracks } = parseRekordboxXml(generateSampleXml(30));
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const xml = buildRekordboxXml([{ name: 'Teszt "lista" & co', trackIds: ['5', '3', '9', 'nincs'] }], byId);
  const back = parseRekordboxXml(xml);
  assert.equal(back.tracks.length, 3);
  assert.equal(back.playlists[0].name, 'Teszt "lista" & co');
  assert.deepEqual(back.playlists[0].trackIds, ['5', '3', '9']);
  const orig = byId.get('5');
  const t5 = back.tracks.find((t) => t.id === '5');
  assert.equal(t5.location, orig.location);
  assert.equal(t5.title, orig.title);
  assert.equal(t5.key, orig.key);
});

test('M3U kimenet és escape', () => {
  const { tracks } = parseRekordboxXml(generateSampleXml(3));
  const m3u = buildM3u(['1'], new Map(tracks.map((t) => [t.id, t])));
  assert.match(m3u, /^#EXTM3U\n#EXTINF:\d+,Artist \d+ - Track 1/);
  assert.match(m3u, /\/Users\/dj\/Music\/Track 1\.wav\n$/);
  assert.equal(escapeXml('a&b"<c>'), 'a&amp;b&quot;&lt;c&gt;');
});

test('filterTracks', () => {
  const { tracks } = parseRekordboxXml(generateSampleXml(500));
  const f = filterTracks(tracks, { bpmMin: 120, bpmMax: 128, keys: keySet('8A', 'harmonic') });
  assert.ok(f.length > 0);
  assert.ok(f.every((t) => t.bpm >= 120 && t.bpm <= 128 && ['7A', '8A', '8B', '9A'].includes(t.camelot)));
  assert.ok(filterTracks(tracks, { text: 'track 42' }).some((t) => t.id === '42'));
});

test('buildSet: darabszám, nincs duplikáció, BPM-ív és harmónia', () => {
  const { tracks } = parseRekordboxXml(generateSampleXml(3000));
  const set = buildSet(tracks, { count: 25, startBpm: 118, endBpm: 128, rng: mulberry32(7) });
  assert.equal(set.length, 25);
  assert.equal(new Set(set.map((t) => t.id)).size, 25);
  assert.ok(Math.abs(set[0].bpm - 118) < 3);
  assert.ok(Math.abs(set[24].bpm - 128) < 4);
  const harmonic = set.slice(1).filter((t, i) => transition(set[i], t).level === 'ok').length;
  assert.ok(harmonic >= 20, `harmonikus átmenetek: ${harmonic}/24`);
  // determinisztikus azonos seedre
  const again = buildSet(tracks, { count: 25, startBpm: 118, endBpm: 128, rng: mulberry32(7) });
  assert.deepEqual(again.map((t) => t.id), set.map((t) => t.id));
  assert.deepEqual(buildSet([], { count: 5 }), []);
});

test('AI: válasz szűrése és hibatűrés', async () => {
  const valid = new Set(['1', '2', '3']);
  const r = parseAiResponse('Íme:\n```json\n{"playlist":["2","x","1","2",3],"notes":"ok"}\n```', valid);
  assert.deepEqual(r.ids, ['2', '1', '3']);
  assert.throws(() => parseAiResponse('nincs json', valid));

  const { tracks } = parseRekordboxXml(generateSampleXml(5));
  const p = buildPrompt({ pool: tracks, brief: 'deep house', count: 3, startBpm: 120, endBpm: 124 });
  assert.match(p.user, /^Kérés: deep house/m);
  assert.ok(!p.user.includes('/Users/dj'), 'fájlútvonal nem szivároghat az AI-nak');

  let seen;
  const fake = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"playlist":["1"]}' }] }) };
  };
  const text = await askClaude({ apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl: fake });
  assert.equal(text, '{"playlist":["1"]}');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(askClaude({ apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl: bad }), /invalid/);
});
