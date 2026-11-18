# DJ Playlist

Telefonon és gépen használható webapp DJ-szettek előkészítésére a **Rekordbox 7** gyűjteményedből – WAV-támogatással, meghallgatással és szinkronnal, a Rekordbox saját mobilapp-ja nélkül.

## Hogyan működik

```
 Mac (Rekordbox könyvtár + hangfájlok)
        │  olvassa, indexeli, streameli
        ▼
 ┌──────────────┐   Tailscale (privát, titkosított)   ┌───────────────────────┐
 │  dj-agent    │ ◀──────────────────────────────────▶│ telefon / bármely     │
 │  (Python)    │   HTTPS + belépési token            │ böngésző (PWA)        │
 └──────────────┘                                     └───────────────────────┘
        │ a listáid itt tárolódnak, és automatikusan
        ▼ Rekordbox-XML-be is kiíródnak → Rekordbox „rekordbox xml" fa
```

A **dj-agent** a Mac-en fut: olvassa a Rekordbox-könyvtárat, memóriában indexeli (a változást figyeli), és a webappot is kiszolgálja. A telefon ugyanazt a könyvtárat és ugyanazokat a listákat látja, mint a gép; koppintásra meghallgathatod a számokat (a WAV-ot a háttérprogram 160 kbps AAC előnézetté alakítja, így mobilnetről is gyors).

Ha nincs háttérprogram, az app **önálló módban** is megy: XML-import, minden helyben marad a böngészőben (lásd lejjebb).

## Gyors indítás (Mac)

Kell: Python 3.9+, `ffmpeg` (`brew install ffmpeg`), opcionálisan Tailscale.

```sh
git clone <ez a repó> && cd dj-playlist
# Rekordboxban: File → Export Collection in xml format  (WAV-ok is benne vannak)
python3 -m agent --xml ~/Documents/rekordbox.xml
```

Kiírja a **párosító linket** (`http://localhost:8787/#pair=…`) – nyisd meg a gépen, és be vagy léptetve. A háttérprogram 20 mp-enként figyeli az XML-t; ha újra exportálod a Rekordboxból, magától frissít.

### Telefonról (Tailscale, ajánlott)

1. Telepítsd a Tailscale-t a Mac-re és a telefonra, ugyanazzal a fiókkal.
2. Mac-en: `tailscale serve --bg 8787` – ez HTTPS-en, csak a saját hálózatodnak teszi elérhetővé (nem a nyilvános internetnek).
3. Telefonon nyisd meg a `https://<mac-neve>.<tailnet>.ts.net/` címet, add meg a tokent (egyszer), majd *Add to Home Screen*.

A háttérprogram alapból csak `127.0.0.1`-en figyel, vagyis a helyi hálózaton senki nem éri el, csak a Tailscale-en át.

## Mit tud

- **Könyvtár:** keresés, BPM-tartomány, kulcs (Camelot: harmonikus / energia / pontos), műfaj, értékelés, rendezés. A kulcs-jelvényre koppintva **meghallgatod** a számot; a szett végén a következőre lép.
- **Szett:** sorrend, átmenet-minősítés (BPM-különbség, harmónia), 🔍 az illeszkedő következő keresésére.
- **Auto / AI:** offline BPM-ív + Camelot-algoritmus, vagy Claude szöveges kérésből (csak metaadat megy ki, fájlútvonal soha).
- **Szinkron:** a listák a Mac-en élnek, a telefon és a gép ugyanazt mutatja.
- **Rekordboxba vissza:** a háttérprogram minden módosításkor frissíti a `~/.dj-agent/export/dj-playlists.xml`-t. Egyszer add meg Rekordboxban (`Preferences → Advanced → Database → rekordbox xml`), utána a *rekordbox xml* fában jobb klikk a listán → `Import Playlist`.
- A Rekordbox saját listái csak olvashatók (másolhatod és szerkesztheted a másolatot).

## Fontos korlátok (őszintén)

- **XML-forrásnál a könyvtár nem élő:** amit a Rekordboxban változtatsz (új szám, kulcs), azt újra kell exportálnod. Az `--source db` mód (a Rekordbox `master.db` közvetlen, csak olvasható elérése a `pyrekordbox` csomaggal, `pip install pyrekordbox`) ezt megoldaná, **de ezt még nem próbáltam ki valódi Rekordbox-adatbázison**, ezért kísérleti. Az adatbázist a program soha nem írja.
- A Rekordbox-adatbázisba **nem írunk** (korrupció-veszély); a visszaút az XML-import.
- **Tárhely:** a zenefájlok **nem költöznek sehova**, a Mac-en maradnak, ahol most is vannak; a háttérprogram lejátszáskor streameli őket. Egyetlen helyi gyorsítótár van (`~/.dj-agent/cache`, AAC-előnézetek, kb. 1,2 MB/perc), ennek mérete korlátozott: alap 5 GB, `--cache-gb`-vel állítható, a legrégebben használtat törli. Felhőbe nem töltünk fel semmit.
- A háttérprogram csak akkor érhető el, ha a Mac be van kapcsolva, és fut.

## Biztonság

- Csak helyi figyelés; távoli elérés kizárólag Tailscale-en (privát hálózat, WireGuard-titkosítás) keresztül.
- Belépés egyszeri tokennel (192 bit, `~/.dj-agent/config.json`, `600` jogosultság); utána `HttpOnly`, `SameSite=Strict` süti. A token nem kerül a böngésző tárolójába. Próbálkozás-korlát (8 hibás kísérlet/perc). `--rotate-token`: új token, minden eszköz kilép.
- CSRF-védelem (módosításhoz egyedi fejléc), Host-fejléc ellenőrzés (DNS-rebinding ellen).
- Hang csak az indexben szereplő trackhez, azonosító alapján, csak audio-kiterjesztésű, létező fájlra; a kliens soha nem ad útvonalat. A statikus kiszolgálás fehérlistás (a háttérprogram forrása, a `.git` stb. nem érhető el).
- Az API-válaszok sosem kerülnek a service worker gyorsítótárába. Szigorú CSP, nincs külső script, nincs `innerHTML`.
- Az AI API-kulcs (opcionális) csak a böngésző helyi tárolójában van.

## Önálló mód (háttérprogram nélkül)

Az `index.html` bármilyen statikus HTTPS-tárhelyről is működik: Rekordbox XML import az *Adatok* fülön, minden adat a böngésző IndexedDB-jében, kimenet Rekordbox-XML / M3U8. Hang itt nincs (nincs honnan streamelni).

## Fejlesztés

```sh
npm test                              # webapp-logika (Node 20+)
python3 -m unittest agent.tests.test_agent   # háttérprogram (azonosítás, Range, védelem, export)
npm run sample                        # 5000 trackes minta XML
```

| Fájl | Szerep |
|---|---|
| `agent/server.py` | HTTP: statikus + API + azonosítás + audio (Range, ffmpeg-előnézet) |
| `agent/sources.py` | Rekordbox XML és (kísérleti) `master.db` olvasó |
| `agent/library.py` | memóriabeli index, listák tárolása, Rekordbox-XML / M3U8 export |
| `js/app.js`, `js/agent.js`, `js/player.js` | felület, API-kliens, lejátszó |
| `js/camelot.js`, `js/planner.js`, `js/rbxml.js`, `js/ai.js`, `js/db.js` | kulcsok, szettépítő, XML, AI, helyi tároló |
