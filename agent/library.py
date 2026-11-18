"""Memóbeli index a könyvtárról + a saját (telefonon/gépen készített) listák tárolása + Rekordbox-export."""
import gzip
import hashlib
import json
import os
import tempfile
import threading
import time
import urllib.parse

from .sources import AUDIO_EXT

def quoteattr(v):
    v = str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    return '"' + v.replace("\n", "&#10;").replace("\r", "&#13;") + '"'


PUBLIC = ("id", "title", "artist", "album", "genre", "bpm", "key", "camelot", "duration", "rating", "year", "comments", "kind", "added")


class Library:
    def __init__(self, source):
        self.source = source
        self.lock = threading.RLock()
        self.rev = 0
        self.tracks = []
        self.by_id = {}
        self.rb_playlists = []
        self.json_gz = b""
        self.etag = '"0"'
        self._stamp = None
        self.loaded_at = 0.0

    def refresh(self, force=False) -> bool:
        stamp = self.source.stamp()
        if not force and stamp == self._stamp and self.rev:
            return False
        tracks, playlists = self.source.load()
        body = json.dumps({"source": self.source.name, "tracks": [{k: t[k] for k in PUBLIC} for t in tracks]},
                          ensure_ascii=False, separators=(",", ":")).encode()
        with self.lock:
            self.tracks, self.rb_playlists = tracks, playlists
            self.by_id = {t["id"]: t for t in tracks}
            self.rev += 1
            self._stamp = stamp
            self.json_gz = gzip.compress(body, 6)
            self.etag = '"%d-%s"' % (self.rev, hashlib.sha1(body).hexdigest()[:12])
            self.loaded_at = time.time()
        return True

    def audio_path(self, track_id: str):
        """Csak az indexben szereplő track, csak audio-kiterjesztés, csak létező fájl. A kliens soha nem ad útvonalat."""
        t = self.by_id.get(track_id)
        if not t or not t["path"]:
            return None
        if os.path.splitext(t["path"])[1].lower() not in AUDIO_EXT:
            return None
        return t["path"] if os.path.isfile(t["path"]) else None


class PlaylistStore:
    """Saját listák: egyetlen JSON fájl, atomikus írással. Változáskor frissül a Rekordbox-XML export is."""

    def __init__(self, directory: str, library: Library, export_path: str):
        self.file = os.path.join(directory, "playlists.json")
        self.lib = library
        self.export_path = export_path
        self.lock = threading.RLock()
        self.items = {}
        if os.path.exists(self.file):
            with open(self.file, encoding="utf-8") as f:
                self.items = {p["id"]: p for p in json.load(f).get("playlists", [])}

    def list(self):
        with self.lock:
            return sorted(self.items.values(), key=lambda p: p.get("updated", 0), reverse=True)

    def get(self, pid):
        with self.lock:
            return self.items.get(pid)

    def put(self, pid, data: dict):
        if not isinstance(pid, str) or not (1 <= len(pid) <= 64) or not all(c.isalnum() or c in "-_" for c in pid):
            raise ValueError("érvénytelen azonosító")
        name, ids = data.get("name"), data.get("trackIds")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError("érvénytelen név")
        if not isinstance(ids, list) or len(ids) > 5000 or not all(isinstance(i, str) and len(i) < 40 for i in ids):
            raise ValueError("érvénytelen trackIds")
        now = int(time.time() * 1000)
        with self.lock:
            old = self.items.get(pid, {})
            self.items[pid] = {"id": pid, "name": name.strip(), "trackIds": ids,
                               "created": old.get("created") or int(data.get("created") or now), "updated": now}
            self._save()
        return self.items[pid]

    def delete(self, pid):
        with self.lock:
            existed = self.items.pop(pid, None) is not None
            if existed:
                self._save()
        return existed

    def _save(self):
        d = os.path.dirname(self.file)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"playlists": list(self.items.values())}, f, ensure_ascii=False)
        os.replace(tmp, self.file)
        self.export_xml()

    def export_xml(self, ids=None):
        xml = build_rekordbox_xml(self.list() if ids is None else [self.items[i] for i in ids if i in self.items], self.lib.by_id)
        if ids is None and self.export_path:
            os.makedirs(os.path.dirname(self.export_path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.export_path), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(xml)
            os.replace(tmp, self.export_path)
        return xml


def _attrs(t):
    if t.get("raw"):
        raw = dict(t["raw"])
        raw["TrackID"] = t["id"]
        return raw
    return {"TrackID": t["id"], "Name": t["title"], "Artist": t["artist"], "Album": t["album"], "Genre": t["genre"],
            "Kind": t["kind"], "TotalTime": str(t["duration"]), "Year": str(t["year"] or ""), "AverageBpm": "%.2f" % t["bpm"],
            "Tonality": t["key"], "Comments": t["comments"],
            "Location": "file://localhost" + urllib.parse.quote(t["path"])}


def build_rekordbox_xml(playlists, by_id) -> str:
    used = {}
    for p in playlists:
        for i in p["trackIds"]:
            if i in by_id:
                used[i] = by_id[i]
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
           '  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>', '  <COLLECTION Entries="%d">' % len(used)]
    for t in used.values():
        out.append("    <TRACK %s/>" % " ".join("%s=%s" % (k, quoteattr(str(v))) for k, v in _attrs(t).items()))
    out += ["  </COLLECTION>", "  <PLAYLISTS>", '    <NODE Type="0" Name="ROOT" Count="%d">' % len(playlists)]
    for p in playlists:
        ids = [i for i in p["trackIds"] if i in used]
        out.append('      <NODE Name=%s Type="1" KeyType="0" Entries="%d">' % (quoteattr(p["name"]), len(ids)))
        out += ['        <TRACK Key=%s/>' % quoteattr(i) for i in ids]
        out.append("      </NODE>")
    out += ["    </NODE>", "  </PLAYLISTS>", "</DJ_PLAYLISTS>", ""]
    return "\n".join(out)


def build_m3u(ids, by_id) -> str:
    out = ["#EXTM3U"]
    for i in ids:
        t = by_id.get(i)
        if t:
            out += ["#EXTINF:%d,%s" % (t["duration"], " - ".join(x for x in (t["artist"], t["title"]) if x)), t["path"]]
    return "\n".join(out) + "\n"
