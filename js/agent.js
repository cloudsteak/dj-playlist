// Kliens a Mac-en futó háttérprogramhoz (azonos origin, HttpOnly süti az azonosításhoz).

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function call(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-DJ'] = '1'; // CSRF-védelem: a szerver ezt várja módosító hívásnál
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

/** Igaz, ha ezt az oldalt a háttérprogram szolgálja ki (egyébként önálló, XML-importos mód). */
export async function probe() {
  try {
    const r = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
    return r.ok && (await r.json()).agent === true;
  } catch { return false; }
}

export const login = (token) => call('POST', '/api/login', { token });
export const info = () => call('GET', '/api/info');
export const refresh = () => call('POST', '/api/refresh', {});
export const library = () => call('GET', '/api/library');
export const playlists = () => call('GET', '/api/playlists');
export const putPlaylist = (p) => call('PUT', `/api/playlists/${encodeURIComponent(p.id)}`,
  { name: p.name, trackIds: p.trackIds, created: p.created });
export const deletePlaylist = (id) => call('DELETE', `/api/playlists/${encodeURIComponent(id)}`);
export const audioUrl = (id) => `/api/audio/${encodeURIComponent(id)}?q=preview`;

export async function exportText(kind, id) {
  const r = await fetch(`/api/export.${kind}?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, 'Az export nem sikerült');
  return r.text();
}
