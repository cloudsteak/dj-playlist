"""HTTP szerver: statikus webapp + /api. Csak szabványkönyvtár.

Biztonsági modell:
  * alapértelmezetten csak 127.0.0.1-en figyel; távoli elérés: `tailscale serve` (HTTPS, privát hálózat)
  * minden /api hívás (a /api/health és /api/login kivételével) HttpOnly+SameSite=Strict sütit kér,
    amit a belépés (egyszeri token) ad; módosító hívásokhoz X-DJ fejléc is kell (CSRF)
  * Host-fejléc ellenőrzés (DNS-rebinding ellen)
  * audio csak az indexben szereplő trackhez, azonosító alapján, audio-kiterjesztéssel; a kliens soha nem ad útvonalat
  * a statikus kiszolgálás fehérlistás (csak a webapp fájljai)
"""
import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from . import VERSION
from .library import build_m3u

WEB_FILES = {"/": "index.html", "/index.html": "index.html", "/sw.js": "sw.js", "/manifest.webmanifest": "manifest.webmanifest",
             "/icon.svg": "icon.svg", "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png"}
WEB_DIRS = {"/css/": {".css"}, "/js/": {".js"}}
MIME = {".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff",
        ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg"}
COOKIE = "djsid"


def prune_cache(directory, max_bytes, keep=None):
    """Legrégebben használt előnézetek törlése, amíg a gyorsítótár a limit alá nem kerül."""
    files = []
    for name in os.listdir(directory):
        p = os.path.join(directory, name)
        if name.endswith(".m4a") and os.path.isfile(p):
            files.append((os.path.getmtime(p), os.path.getsize(p), p))
    total = sum(s for _, s, _ in files)
    for _, size, p in sorted(files):
        if total <= max_bytes:
            break
        if p == keep:
            continue
        try:
            os.unlink(p)
            total -= size
        except OSError:
            pass
    return total


class AgentServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, *, library, store, token, web_root, cache_dir, allowed_hosts=(), verbose=False, cache_max_bytes=5 * 1024**3):
        super().__init__(addr, Handler)
        self.lib, self.store, self.web_root, self.cache_dir, self.verbose = library, store, os.path.realpath(web_root), cache_dir, verbose
        self.token = token
        self.cache_max_bytes = cache_max_bytes
        self.session = hmac.new(token.encode(), b"dj-session-v1", hashlib.sha256).hexdigest()
        self.allowed_hosts = {"localhost", "127.0.0.1", "[::1]", *(h.lower() for h in allowed_hosts)}
        self.allowed_suffixes = (".ts.net",)
        self.fail_times = []
        self.fail_lock = threading.Lock()
        self.transcode_locks = {}
        self.transcode_guard = threading.Lock()
        os.makedirs(cache_dir, exist_ok=True)

    def host_ok(self, host: str) -> bool:
        h = host.lower()
        h = h[: h.rindex("]") + 1] if h.startswith("[") else h.split(":")[0]
        return h in self.allowed_hosts or h.endswith(self.allowed_suffixes)

    def login_blocked(self) -> bool:
        now = time.time()
        with self.fail_lock:
            self.fail_times = [t for t in self.fail_times if now - t < 60]
            return len(self.fail_times) >= 8

    def note_failure(self):
        with self.fail_lock:
            self.fail_times.append(time.time())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "dj-agent"
    sys_version = ""

    def log_message(self, fmt, *args):
        if self.server.verbose:
            print("%s %s" % (self.command, urlsplit(self.path).path), args[1] if len(args) > 1 else "")

    # ---------- segédek ----------
    def _send(self, status, body=b"", ctype="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200, headers=None):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode(), headers={"Cache-Control": "no-store", **(headers or {})})

    def _err(self, status, msg):
        self._json({"error": msg}, status)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("túl nagy kérés")
        return json.loads(self.rfile.read(n) or b"{}")

    def _authed(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and hmac.compare_digest(v, self.server.session):
                return True
        return False

    def _handle(self):
        try:
            if not self.server.host_ok(self.headers.get("Host", "")):
                return self._err(421, "ismeretlen Host")
            path = unquote(urlsplit(self.path).path)
            if path.startswith("/api/"):
                return self._api(path)
            if self.command not in ("GET", "HEAD"):
                return self._err(405, "nem engedélyezett")
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self._err(400, str(e))
        except Exception as e:  # noqa: BLE001
            if self.server.verbose:
                import traceback
                traceback.print_exc()
            try:
                self._err(500, "szerverhiba")
            except OSError:
                pass

    do_GET = do_HEAD = do_PUT = do_POST = do_DELETE = _handle

    # ---------- statikus ----------
    def _static(self, path):
        rel = WEB_FILES.get(path)
        if rel is None:
            for prefix, exts in WEB_DIRS.items():
                if path.startswith(prefix) and os.path.splitext(path)[1] in exts and ".." not in path:
                    rel = path.lstrip("/")
        if rel is None:
            return self._err(404, "nincs ilyen")
        full = os.path.realpath(os.path.join(self.server.web_root, rel))
        if not full.startswith(self.server.web_root + os.sep) or not os.path.isfile(full):
            return self._err(404, "nincs ilyen")
        ctype = MIME.get(os.path.splitext(full)[1]) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype == "application/manifest+json" else ""),
                       {"Cache-Control": "no-cache"})

    # ---------- API ----------
    def _api(self, path):
        srv, m = self.server, self.command
        if path == "/api/health" and m in ("GET", "HEAD"):
            return self._json({"ok": True, "agent": True, "version": VERSION})
        if path == "/api/login" and m == "POST":
            return self._login()
        if not self._authed():
            return self._err(401, "belépés szükséges")
        if m in ("PUT", "POST", "DELETE") and self.headers.get("X-DJ") != "1":
            return self._err(403, "hiányzó X-DJ fejléc")
        q = parse_qs(urlsplit(self.path).query)

        if path == "/api/info" and m == "GET":
            lib = srv.lib
            return self._json({"rev": lib.rev, "source": lib.source.name, "tracks": len(lib.tracks), "loadedAt": lib.loaded_at,
                               "ffmpeg": shutil.which("ffmpeg") is not None,
                               "exportPath": srv.store.export_path})
        if path == "/api/refresh" and m == "POST":
            return self._json({"changed": srv.lib.refresh(force=True), "rev": srv.lib.rev})
        if path == "/api/library" and m in ("GET", "HEAD"):
            lib = srv.lib
            hdrs = {"ETag": lib.etag, "Cache-Control": "private, no-cache"}
            if self.headers.get("If-None-Match") == lib.etag:
                return self._send(304, headers=hdrs)
            if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                return self._send(200, lib.json_gz, headers={**hdrs, "Content-Encoding": "gzip"})
            import gzip
            return self._send(200, gzip.decompress(lib.json_gz), headers=hdrs)
        if path == "/api/playlists" and m == "GET":
            return self._json({"playlists": srv.store.list(), "rekordbox": srv.lib.rb_playlists})
        mm = re.fullmatch(r"/api/playlists/([\w-]{1,64})", path)
        if mm and m == "PUT":
            return self._json(srv.store.put(mm.group(1), self._body()))
        if mm and m == "DELETE":
            return self._json({"deleted": srv.store.delete(mm.group(1))})
        if path in ("/api/export.xml", "/api/export.m3u8") and m == "GET":
            pid = (q.get("id") or [None])[0]
            if pid and not srv.store.get(pid):
                return self._err(404, "nincs ilyen lista")
            if path.endswith(".xml"):
                return self._send(200, srv.store.export_xml([pid] if pid else None).encode(), "text/xml; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="dj-playlists.xml"'})
            ids = srv.store.get(pid)["trackIds"] if pid else []
            return self._send(200, build_m3u(ids, srv.lib.by_id).encode(), "text/plain; charset=utf-8",
                              {"Content-Disposition": 'attachment; filename="playlist.m3u8"'})
        mm = re.fullmatch(r"/api/audio/([\w-]{1,40})", path)
        if mm and m in ("GET", "HEAD"):
            return self._audio(mm.group(1), (q.get("q") or ["preview"])[0])
        return self._err(404, "nincs ilyen végpont")

    def _login(self):
        srv = self.server
        if srv.login_blocked():
            return self._err(429, "túl sok próbálkozás, várj egy percet")
        tok = str(self._body().get("token", ""))
        if not hmac.compare_digest(tok.encode(), srv.token.encode()):
            srv.note_failure()
            return self._err(403, "hibás token")
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        cookie = f"{COOKIE}={srv.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000{secure}"
        self._json({"ok": True}, headers={"Set-Cookie": cookie})

    # ---------- audio ----------
    def _audio(self, tid, quality):
        path = self.server.lib.audio_path(tid)
        if not path:
            return self._err(404, "nincs hangfájl")
        ctype = MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        if quality != "original" and shutil.which("ffmpeg"):
            cached = self._transcode(path)
            if cached:
                path, ctype = cached, "audio/mp4"
        self._send_file(path, ctype)

    def _transcode(self, src):
        st = os.stat(src)
        key = hashlib.sha1(f"{src}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()
        out = os.path.join(self.server.cache_dir, key + ".m4a")
        if os.path.isfile(out):
            os.utime(out)  # "legutóbb használt": az LRU-törlés ez alapján dönt
            return out
        with self.server.transcode_guard:
            lock = self.server.transcode_locks.setdefault(key, threading.Lock())
        with lock:
            if os.path.isfile(out):
                return out
            fd, tmp = tempfile.mkstemp(dir=self.server.cache_dir, suffix=".m4a")
            os.close(fd)
            try:
                r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1", "-c:a", "aac",
                                    "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4", tmp],
                                   capture_output=True, timeout=300)
                if r.returncode != 0 or os.path.getsize(tmp) == 0:
                    return None
                os.replace(tmp, out)
                prune_cache(self.server.cache_dir, self.server.cache_max_bytes, keep=out)
                return out
            except (subprocess.TimeoutExpired, OSError):
                return None
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)

    def _send_file(self, path, ctype):
        size = os.path.getsize(path)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if not m or (not m.group(1) and not m.group(2)):
                return self._send(416, headers={"Content-Range": f"bytes */{size}"})
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(size - int(m.group(2)), 0)
            if start > end or start >= size:
                return self._send(416, headers={"Content-Range": f"bytes */{size}"})
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(256 * 1024, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
