// Offline app-shell: az alkalmazás fájljai gyorsítótárba kerülnek; minden más kérés (pl. AI API) érintetlen.
const CACHE = 'dj-playlist-v2';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/db.js', 'js/camelot.js', 'js/rbxml.js', 'js/planner.js', 'js/ai.js', 'js/agent.js', 'js/player.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // az API (privát adat, hang) sosem kerül a gyorsítótárba
  // hálózat először (friss kód), gyorsítótár tartalék (offline)
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
