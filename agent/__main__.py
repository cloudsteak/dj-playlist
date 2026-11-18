"""Indítás:  python3 -m agent --xml ~/Documents/rekordbox.xml      (vagy: --source db)"""
import argparse
import json
import os
import secrets
import sys
import threading
import time

from .library import Library, PlaylistStore
from .server import AgentServer
from .sources import DbSource, XmlSource

HOME = os.path.expanduser("~/.dj-agent")


def load_config():
    os.makedirs(HOME, mode=0o700, exist_ok=True)
    path = os.path.join(HOME, "config.json")
    cfg = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(24)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
    return cfg, path


def main(argv=None):
    ap = argparse.ArgumentParser(prog="agent", description="DJ Playlist háttérprogram (Rekordbox könyvtár -> telefon)")
    ap.add_argument("--xml", help="Rekordbox XML export útvonala (File → Export Collection in xml format)")
    ap.add_argument("--source", choices=["xml", "db"], help="forrás (alapból xml, ha van --xml)")
    ap.add_argument("--host", default="127.0.0.1", help="figyelő cím (alap: csak helyi; távolihoz tailscale serve)")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--allow-host", action="append", default=[], help="további engedélyezett Host fejléc (pl. a gép .local neve)")
    ap.add_argument("--cache-gb", type=float, default=5, help="az AAC-előnézetek gyorsítótárának max. mérete GB-ban (alap: 5)")
    ap.add_argument("--rotate-token", action="store_true", help="új token (minden belépett eszköz kilép)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    cfg, cfg_path = load_config()
    if args.rotate_token:
        cfg["token"] = secrets.token_urlsafe(24)
        with open(os.open(cfg_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
    xml = args.xml or cfg.get("xml")
    src_kind = args.source or ("xml" if xml else "db")
    if src_kind == "xml":
        if not xml or not os.path.isfile(os.path.expanduser(xml)):
            sys.exit("Add meg a Rekordbox XML-t: --xml /út/a/rekordbox.xml (Rekordbox: File → Export Collection in xml format)")
        source = XmlSource(xml)
        cfg["xml"] = os.path.abspath(os.path.expanduser(xml))
        with open(os.open(cfg_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
    else:
        try:
            source = DbSource()
        except RuntimeError as e:
            sys.exit(str(e))

    lib = Library(source)
    t0 = time.time()
    lib.refresh(force=True)
    print(f"Index kész: {len(lib.tracks)} track, {len(lib.rb_playlists)} Rekordbox-lista ({time.time() - t0:.1f} mp, forrás: {source.name})")

    export = os.path.join(HOME, "export", "dj-playlists.xml")
    store = PlaylistStore(HOME, lib, export)
    web_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    srv = AgentServer((args.host, args.port), library=lib, store=store, token=cfg["token"], web_root=web_root,
                      cache_dir=os.path.join(HOME, "cache"), allowed_hosts=args.allow_host + cfg.get("allowed_hosts", []),
                      verbose=args.verbose, cache_max_bytes=int(args.cache_gb * 1024**3))

    def watcher():  # "indexes": a forrás változását figyeli, és újraindexel
        while True:
            time.sleep(20)
            try:
                if lib.refresh():
                    print(f"Könyvtár frissítve ({len(lib.tracks)} track)")
            except Exception as e:  # noqa: BLE001
                print("Frissítési hiba:", e)

    threading.Thread(target=watcher, daemon=True).start()
    port = srv.server_address[1]
    print(f"\nFut: http://{args.host}:{port}/")
    print(f"Párosítás (egyszeri): http://localhost:{port}/#pair={cfg['token']}")
    print(f"Token: {cfg['token']}")
    print(f"Rekordbox-XML export (automatikus): {export}")
    print("Távoli elérés a telefonról: tailscale serve --bg %d  (lásd README)" % port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nLeáll.")


if __name__ == "__main__":
    main()
