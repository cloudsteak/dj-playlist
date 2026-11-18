// Előnézet-lejátszó: egy <audio>, mini-sáv a képernyő alján, zárolt képernyős vezérlés (Media Session).

const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

export function createPlayer({ urlFor, nextOf, onState, onError }) {
  const $ = (id) => document.getElementById(id);
  const box = $('player'), title = $('p-title'), sub = $('p-sub'), toggleBtn = $('p-toggle'), seek = $('p-seek'), time = $('p-time');
  const a = new Audio();
  a.preload = 'metadata';
  let track = null, dragging = false;

  function ui() {
    toggleBtn.textContent = a.paused ? '▶' : '❚❚';
    toggleBtn.setAttribute('aria-label', a.paused ? 'Lejátszás' : 'Szünet');
    onState?.(track, !a.paused);
  }
  function tick() {
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : track?.duration || 0;
    if (!dragging && d) seek.value = String(Math.round((a.currentTime / d) * 1000));
    time.textContent = `${fmt(a.currentTime)} / ${fmt(d)}`;
  }

  function play(t) {
    if (track && track.id === t.id) { toggle(); return; }
    track = t;
    a.src = urlFor(t);
    box.hidden = false;
    document.body.classList.add('has-player');
    title.textContent = t.title || '(cím nélkül)';
    sub.textContent = [t.artist, t.camelot, t.bpm ? `${Math.round(t.bpm)} BPM` : ''].filter(Boolean).join(' · ');
    seek.value = '0';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album });
    }
    a.play().catch(() => {});
    ui();
  }
  function toggle() { if (!track) return; if (a.paused) a.play().catch(() => {}); else a.pause(); }
  function close() {
    a.pause(); a.removeAttribute('src'); a.load();
    track = null; box.hidden = true; document.body.classList.remove('has-player');
    ui();
  }

  a.addEventListener('play', ui);
  a.addEventListener('pause', ui);
  a.addEventListener('timeupdate', tick);
  a.addEventListener('loadedmetadata', tick);
  a.addEventListener('ended', () => { const n = track && nextOf?.(track); if (n) play(n); else ui(); });
  a.addEventListener('error', () => { onError?.(track); ui(); });

  toggleBtn.addEventListener('click', toggle);
  $('p-close').addEventListener('click', close);
  seek.addEventListener('input', () => { dragging = true; });
  seek.addEventListener('change', () => {
    const d = Number.isFinite(a.duration) ? a.duration : track?.duration || 0;
    if (d) a.currentTime = (Number(seek.value) / 1000) * d;
    dragging = false;
  });
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => a.play().catch(() => {}));
    ms.setActionHandler('pause', () => a.pause());
    ms.setActionHandler('nexttrack', () => { const n = track && nextOf?.(track); if (n) play(n); });
    try { ms.setActionHandler('seekto', (e) => { if (e.seekTime != null) a.currentTime = e.seekTime; }); } catch { /* nem támogatott */ }
  }
  return { play, toggle, close, current: () => track };
}
