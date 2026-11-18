"""Zenei könyvtár-források: Rekordbox XML (stabil) és Rekordbox master.db (pyrekordbox, kísérleti).

Mindkettő ugyanazt adja: (tracks, playlists)
  track    = publikus mezők + 'path' (helyi fájl) + 'raw' (eredeti XML-attribútumok, ha van)
  playlist = {"name", "path": [mappák], "trackIds": [..]}
"""
import os
import re
import urllib.parse
import xml.etree.ElementTree as ET

from .camelot import to_camelot

AUDIO_EXT = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".m4a", ".aac", ".ogg", ".opus"}


def location_to_path(loc: str) -> str:
    return urllib.parse.unquote(re.sub(r"^file://(localhost)?", "", loc or ""))


def _int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def norm_track(a: dict) -> dict:
    loc = a.get("Location", "")
    return {
        "id": str(a.get("TrackID", "")),
        "title": a.get("Name", ""),
        "artist": a.get("Artist", ""),
        "album": a.get("Album", ""),
        "genre": a.get("Genre", ""),
        "bpm": float(a.get("AverageBpm") or 0) if re.fullmatch(r"[\d.]+", a.get("AverageBpm") or "") else 0.0,
        "key": a.get("Tonality", ""),
        "camelot": to_camelot(a.get("Tonality")),
        "duration": _int(a.get("TotalTime")),
        "rating": round(_int(a.get("Rating")) / 51),
        "year": _int(a.get("Year")),
        "comments": a.get("Comments", ""),
        "kind": a.get("Kind", ""),
        "added": a.get("DateAdded", ""),
        "path": location_to_path(loc),
        "raw": a,
    }


class XmlSource:
    name = "xml"

    def __init__(self, path: str):
        self.path = os.path.abspath(os.path.expanduser(path))

    def stamp(self):
        st = os.stat(self.path)
        return (st.st_mtime_ns, st.st_size)

    def load(self):
        tracks, playlists = [], []
        stack, cur = [], None
        in_coll = in_track = False
        for ev, el in ET.iterparse(self.path, events=("start", "end")):
            tag = el.tag
            if ev == "start":
                if tag == "COLLECTION":
                    in_coll = True
                elif tag == "TRACK" and in_coll and not in_track:
                    in_track = True
                    if "TrackID" in el.attrib:
                        tracks.append(norm_track(dict(el.attrib)))
                elif tag == "NODE":
                    if el.get("Type") == "1":
                        cur = {"name": el.get("Name", "Playlist"), "path": [n for k, n in stack if k == "f" and n != "ROOT"],
                               "keyType": el.get("KeyType", "0"), "keys": []}
                        stack.append(("p", cur))
                    else:
                        stack.append(("f", el.get("Name", "")))
                elif tag == "TRACK" and cur is not None and "Key" in el.attrib:
                    cur["keys"].append(el.get("Key"))
            else:
                if tag == "COLLECTION":
                    in_coll = False
                elif tag == "TRACK" and in_track and in_coll:
                    in_track = False
                elif tag == "NODE":
                    kind, val = stack.pop()
                    if kind == "p":
                        playlists.append(val)
                        cur = None
                el.clear()
        by_loc = {t["path"]: t["id"] for t in tracks}
        out = []
        for p in playlists:
            ids = [by_loc.get(location_to_path(k)) if p["keyType"] == "1" else str(k) for k in p["keys"]]
            out.append({"name": p["name"], "path": p["path"], "trackIds": [i for i in ids if i]})
        return tracks, out


class DbSource:
    """Rekordbox 6/7 master.db olvasása a pyrekordbox-szal (csak olvasás).

    KÍSÉRLETI: valódi Rekordbox-adatbázison még nem lett kipróbálva, ezért hibatűrően van írva.
    Ha elbukik, az XML-forrás a biztos út (--xml).
    """
    name = "db"

    def __init__(self):
        try:
            from pyrekordbox import Rekordbox6Database  # noqa: F401
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("A master.db olvasásához kell a pyrekordbox: pip install pyrekordbox") from e
        self._db = None

    def _open(self):
        from pyrekordbox import Rekordbox6Database
        if self._db is None:
            self._db = Rekordbox6Database()
        return self._db

    def stamp(self):
        db = self._open()
        p = getattr(db, "db_path", None) or getattr(db, "path", None)
        try:
            return os.stat(str(p)).st_mtime_ns
        except (OSError, TypeError):
            return None

    def load(self):  # pragma: no cover - valódi adatbázis kell hozzá
        db = self._open()
        g = lambda o, n, d="": getattr(o, n, d) if getattr(o, n, d) is not None else d  # noqa: E731
        tracks = []
        for c in db.get_content():
            path = g(c, "FolderPath")
            rating = _int(g(c, "Rating"))
            tracks.append({
                "id": str(c.ID), "title": g(c, "Title"), "artist": g(c, "ArtistName"), "album": g(c, "AlbumName"),
                "genre": g(c, "GenreName"), "bpm": round(_int(g(c, "BPM")) / 100, 2), "key": g(c, "KeyName"),
                "camelot": to_camelot(g(c, "KeyName")), "duration": _int(g(c, "Length")),
                "rating": round(rating / 51) if rating > 5 else rating, "year": _int(g(c, "ReleaseYear")),
                "comments": g(c, "Commnt"), "kind": os.path.splitext(path)[1].lstrip(".").upper() + " File",
                "added": str(g(c, "created_at"))[:10], "path": path, "raw": None,
            })
        playlists = []
        for pl in db.get_playlist():
            if _int(g(pl, "Attribute")) != 0:  # 0 = sima lista (1 mappa, 4 smart)
                continue
            songs = db.get_playlist_songs(PlaylistID=pl.ID)
            ids = [str(s.ContentID) for s in sorted(songs, key=lambda s: _int(g(s, "TrackNo")))]
            playlists.append({"name": g(pl, "Name"), "path": [], "trackIds": ids})
        return tracks, playlists
