// IndexedDB: tracks (a Rekordbox gyűjtemény), playlists (a saját listák). Minden csak a készüléken marad.

const NAME = 'dj-playlist';
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('tracks', { keyPath: 'id' });
        req.result.createObjectStore('playlists', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const result = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function allTracks() {
  const db = await open();
  return result(db.transaction('tracks').objectStore('tracks').getAll());
}

export async function replaceTracks(tracks) {
  const db = await open();
  const tx = db.transaction('tracks', 'readwrite');
  const st = tx.objectStore('tracks');
  st.clear();
  for (const t of tracks) st.put(t);
  return done(tx);
}

export async function allPlaylists() {
  const db = await open();
  return result(db.transaction('playlists').objectStore('playlists').getAll());
}

export async function putPlaylists(list) {
  const db = await open();
  const tx = db.transaction('playlists', 'readwrite');
  for (const p of list) tx.objectStore('playlists').put(p);
  return done(tx);
}

export async function deletePlaylist(id) {
  const db = await open();
  const tx = db.transaction('playlists', 'readwrite');
  tx.objectStore('playlists').delete(id);
  return done(tx);
}

export async function wipe() {
  const db = await open();
  const tx = db.transaction(['tracks', 'playlists'], 'readwrite');
  tx.objectStore('tracks').clear();
  tx.objectStore('playlists').clear();
  return done(tx);
}
