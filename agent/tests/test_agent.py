import http.client
import json
import os
import shutil
import tempfile
import threading
import unittest
import wave

from agent.library import Library, PlaylistStore
from agent.server import AgentServer
from agent.sources import XmlSource

TOKEN = "test-token-123"


def make_wav(path, seconds=1.0, rate=8000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"\x01\x02" * int(rate * seconds))


class AgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        music = os.path.join(cls.tmp, "Music Dir"); os.makedirs(music)
        cls.wav1 = os.path.join(music, "a & b.wav"); make_wav(cls.wav1)
        cls.txt = os.path.join(music, "secret.txt"); open(cls.txt, "w").write("titok")
        xml = os.path.join(cls.tmp, "rb.xml")
        from urllib.parse import quote
        open(xml, "w", encoding="utf-8").write(f'''<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="3">
<TRACK TrackID="1" Name="Első &amp; &quot;Mix&quot;" Artist="Ő" Genre="House" AverageBpm="124.00" Tonality="Am" TotalTime="1" Rating="102" Kind="WAV File" Location="file://localhost{quote(cls.wav1)}"><TEMPO Inizio="0" Bpm="124" Metro="4/4" Battito="1"/></TRACK>
<TRACK TrackID="2" Name="Másik" Artist="X" AverageBpm="128" Tonality="8A" TotalTime="2" Location="file://localhost{quote(cls.txt)}"/>
<TRACK TrackID="3" Name="Hiányzó" Artist="Y" AverageBpm="100" Tonality="C" TotalTime="2" Location="file://localhost/nincs/ilyen.wav"/>
</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Name="RB lista" Type="1" KeyType="0" Entries="2"><TRACK Key="1"/><TRACK Key="3"/></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>''')
        cls.lib = Library(XmlSource(xml)); cls.lib.refresh(force=True)
        cls.export = os.path.join(cls.tmp, "export", "out.xml")
        cls.store = PlaylistStore(cls.tmp, cls.lib, cls.export)
        web = os.path.join(cls.tmp, "web"); os.makedirs(os.path.join(web, "js")); os.makedirs(os.path.join(web, "agent"))
        open(os.path.join(web, "index.html"), "w").write("<html>app</html>")
        open(os.path.join(web, "js", "app.js"), "w").write("//js")
        open(os.path.join(web, "agent", "secret.py"), "w").write("x")
        cls.srv = AgentServer(("127.0.0.1", 0), library=cls.lib, store=cls.store, token=TOKEN, web_root=web,
                              cache_dir=os.path.join(cls.tmp, "cache"))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.cookie = cls.req("POST", "/api/login", {"token": TOKEN}, auth=False)[2]["Set-Cookie"].split(";")[0]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def req(cls, method, path, body=None, auth=True, headers=None, raw=False):
        c = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=30)
        h = dict(headers or {})
        if auth: h["Cookie"] = cls.cookie
        data = None
        if body is not None:
            data = json.dumps(body); h["Content-Type"] = "application/json"
        if method in ("PUT", "POST", "DELETE") and auth: h.setdefault("X-DJ", "1")
        c.request(method, path, data, h)
        r = c.getresponse(); b = r.read()
        c.close()
        return r.status, (b if raw else (json.loads(b) if b[:1] in (b"{", b"[") else b)), dict(r.getheaders())

    def test_parse_and_public_library_has_no_paths(self):
        st, lib, hd = self.req("GET", "/api/library")
        self.assertEqual(st, 200)
        # a kliens kérése nem küld Accept-Encoding-et -> sima JSON
        self.assertEqual(len(lib["tracks"]), 3)
        t = lib["tracks"][0]
        self.assertEqual(t["title"], 'Első & "Mix"'); self.assertEqual(t["camelot"], "8A"); self.assertEqual(t["rating"], 2)
        self.assertNotIn("path", t); self.assertNotIn("raw", t)
        self.assertNotIn("Music Dir", json.dumps(lib))

    def test_etag_304(self):
        _, _, hd = self.req("GET", "/api/library")
        st, *_ = self.req("GET", "/api/library", headers={"If-None-Match": hd["ETag"]})
        self.assertEqual(st, 304)

    def test_auth_required_and_wrong_token(self):
        self.assertEqual(self.req("GET", "/api/library", auth=False)[0], 401)
        self.assertEqual(self.req("GET", "/api/health", auth=False)[0], 200)
        self.assertEqual(self.req("POST", "/api/login", {"token": "rossz"}, auth=False)[0], 403)

    def test_cookie_flags(self):
        _, _, hd = self.req("POST", "/api/login", {"token": TOKEN}, auth=False)
        ck = hd["Set-Cookie"]
        self.assertIn("HttpOnly", ck); self.assertIn("SameSite=Strict", ck)

    def test_csrf_header_required(self):
        st, *_ = self.req("PUT", "/api/playlists/p1", {"name": "x", "trackIds": []}, headers={"X-DJ": "0"})
        self.assertEqual(st, 403)

    def test_host_header_rebinding(self):
        st, *_ = self.req("GET", "/api/health", auth=False, headers={"Host": "evil.example.com"})
        self.assertEqual(st, 421)
        st, *_ = self.req("GET", "/api/health", auth=False, headers={"Host": "mac.tail1234.ts.net"})
        self.assertEqual(st, 200)

    def test_audio_range_original(self):
        size = os.path.getsize(self.wav1)
        st, body, hd = self.req("GET", "/api/audio/1?q=original", raw=True, headers={"Range": "bytes=10-19"})
        self.assertEqual(st, 206); self.assertEqual(hd["Content-Range"], f"bytes 10-19/{size}")
        self.assertEqual(body, open(self.wav1, "rb").read()[10:20])
        st, body, hd = self.req("GET", "/api/audio/1?q=original", raw=True, headers={"Range": "bytes=-4"})
        self.assertEqual(body, open(self.wav1, "rb").read()[-4:])
        self.assertEqual(self.req("GET", "/api/audio/1?q=original", raw=True, headers={"Range": "bytes=99999999-"})[0], 416)
        st, body, hd = self.req("GET", "/api/audio/1?q=original", raw=True)
        self.assertEqual((st, len(body), hd["Content-Type"]), (200, size, "audio/wav"))

    @unittest.skipUnless(shutil.which("ffmpeg"), "nincs ffmpeg")
    def test_audio_preview_transcode(self):
        st, body, hd = self.req("GET", "/api/audio/1", raw=True)
        self.assertEqual(st, 200); self.assertEqual(hd["Content-Type"], "audio/mp4"); self.assertGreater(len(body), 500)
        self.assertEqual(body[4:8], b"ftyp")
        st, part, hd = self.req("GET", "/api/audio/1", raw=True, headers={"Range": "bytes=0-99"})
        self.assertEqual((st, len(part)), (206, 100))

    def test_audio_blocked_cases(self):
        self.assertEqual(self.req("GET", "/api/audio/2?q=original", raw=True)[0], 404)  # .txt: nem audio-kiterjesztés
        self.assertEqual(self.req("GET", "/api/audio/3?q=original", raw=True)[0], 404)  # nincs a lemezen
        self.assertEqual(self.req("GET", "/api/audio/999", raw=True)[0], 404)
        self.assertEqual(self.req("GET", "/api/audio/..%2F..%2Fetc%2Fpasswd", raw=True)[0], 404)
        self.assertEqual(self.req("GET", "/api/audio/1", auth=False, raw=True)[0], 401)

    def test_playlists_crud_and_export(self):
        st, pl, _ = self.req("PUT", "/api/playlists/abc-1", {"name": 'Péntek "est" & co', "trackIds": ["1", "2", "nincs"]})
        self.assertEqual(st, 200)
        st, lists, _ = self.req("GET", "/api/playlists")
        self.assertEqual([p["id"] for p in lists["playlists"]], ["abc-1"])
        self.assertEqual(lists["rekordbox"][0]["name"], "RB lista")
        self.assertTrue(os.path.isfile(self.export))  # automatikus Rekordbox-XML
        st, xml, hd = self.req("GET", "/api/export.xml", raw=True)
        open(os.path.join(self.tmp, "re.xml"), "wb").write(xml)
        tr, pls = XmlSource(os.path.join(self.tmp, "re.xml")).load()
        self.assertEqual(pls[0]["name"], 'Péntek "est" & co'); self.assertEqual(pls[0]["trackIds"], ["1", "2"])
        self.assertEqual([t["id"] for t in tr], ["1", "2"])
        st, m3u, _ = self.req("GET", "/api/export.m3u8?id=abc-1", raw=True)
        self.assertIn(b"a & b.wav", m3u)
        self.assertEqual(self.req("PUT", "/api/playlists/bad!id", {"name": "x", "trackIds": []})[0], 404)
        self.assertEqual(self.req("PUT", "/api/playlists/p2", {"name": "", "trackIds": []})[0], 400)
        self.assertEqual(self.req("PUT", "/api/playlists/p2", {"name": "x", "trackIds": [1]})[0], 400)
        self.assertEqual(self.req("DELETE", "/api/playlists/abc-1")[2] is not None, True)
        self.assertEqual(self.req("GET", "/api/playlists")[1]["playlists"], [])

    def test_static_whitelist(self):
        self.assertEqual(self.req("GET", "/", auth=False, raw=True)[0], 200)
        self.assertEqual(self.req("GET", "/js/app.js", auth=False, raw=True)[0], 200)
        for p in ("/agent/secret.py", "/js/../agent/secret.py", "/../etc/passwd", "/.git/config", "/js/x.py"):
            self.assertEqual(self.req("GET", p, auth=False, raw=True)[0], 404, p)


if __name__ == "__main__":
    unittest.main()
