# DJ Playlist

Telefonon és gépen használható webapp DJ-szettek előkészítésére a **Rekordbox 7** gyűjteményedből – WAV-támogatással (a Rekordbox saját mobilapp-ja nélkül).

## Hogyan működik

```
Mac / Rekordbox 7                         Telefon / bármely böngésző
┌──────────────────────┐   XML (AirDrop,   ┌─────────────────────────────┐
│ File → Export        │ ───iCloud Drive──▶│ Import → helyi adatbázis    │
│ Collection in xml    │                   │ (IndexedDB, csak nálad)     │
│                      │◀──────────────────│ Szűrés: BPM / kulcs / műfaj │
│ Preferences → rekordbox xml → Import     │ Kézi + automatikus + AI szett│
│ Playlist             │   lista XML/M3U8  │ Export: Rekordbox XML, M3U8 │
└──────────────────────┘                   └─────────────────────────────┘
```

- **Nincs szerver, nincs fiók.** Az app statikus fájlok (PWA); a zenei adatbázis kizárólag a készülék böngészőjében él. Offline is működik, telepíthető a kezdőképernyőre.
- **Miért XML?** A Rekordbox hivatalos exportja, tartalmazza a WAV-okat is. A titkosított `master.db`-hez nem nyúlunk, így nem sérülhet az adatbázisod.
- **Nincs zenei fájl** az appban, csak metaadat (cím, előadó, BPM, kulcs, műfaj, hossz, értékelés, útvonal).

## Használat

1. **Rekordbox (Mac):** `File → Export Collection in xml format`.
2. Vidd át az XML-t a telefonra, majd az app **Adatok** fülén importáld. (5000 track kb. 1–2 mp.)
3. **Könyvtár:** keresés, BPM-tartomány, kulcs (Camelot, harmonikus vagy pontos), műfaj, értékelés, rendezés. `+` a szetthez adja. A 🔍 a szett egy számánál **illeszkedő következőt** keres (harmonikus kulcs, ±6% BPM).
4. **Szett:** sorrend `↑ ↓`, minden átmenetnél látod a BPM-különbséget és a harmonikus / energia-ugrás / kulcsütközés jelzést.
5. **Auto / AI:**
   - *Offline:* BPM-ív (kezdő → záró BPM) + Camelot-harmónia, műfaj- és értékelés-szűrővel. Gyors, ingyenes, adat sem hagyja el a készüléket.
   - *AI (Claude):* szöveges kérésből építi a sorrendet. Csak metaadat megy az Anthropic API-nak (max. ~400 jelölt, fájlútvonal soha). Saját API-kulcs kell, az **Adatok** fülön add meg.
6. **Export:** Rekordbox XML, M3U8, tracklista-szöveg. Mobilon a megosztás-lap (AirDrop / Fájlok), gépen letöltés.
7. **Vissza a Rekordboxba:** `Preferences → Advanced → Database → rekordbox xml` → add meg az exportált fájlt; a bal oldali *rekordbox xml* fában jobb klikk a listán → `Import Playlist`. (A trackek a Rekordbox gyűjteményben már megvannak, a lista azokra mutat.)

## Biztonság

- Semmilyen adat nem hagyja el a készüléket, kivéve az általad indított AI-hívást (csak az `api.anthropic.com`-ra, a CSP más kimenő kapcsolatot nem enged).
- Szigorú Content-Security-Policy, nincs külső script/font/CDN, nincs `innerHTML`: az XML-ből jövő szöveg mindig szövegként jelenik meg.
- Az API-kulcs a böngésző `localStorage`-ában van (csak ezen az eszközön), törölhető. Ajánlott külön, költségkorlátos kulcsot használni.
- Az *Adatok → Mentés (JSON)* a listáidról készít biztonsági másolatot.

## Telepítés / futtatás

Statikus fájlok, bármilyen HTTPS-es tárhely jó (GitHub Pages, Netlify, Cloudflare Pages). Helyben:

```sh
npm run serve        # http://localhost:8080
npm test             # logika tesztek (Node 20+)
npm run sample       # 5000 trackes minta XML a kipróbáláshoz → samples/
```

A PWA-telepítéshez és az offline módhoz HTTPS kell (a `localhost` kivétel). iPhone-on: Safari → Megosztás → *Add to Home Screen*.

## Felépítés

| Fájl | Szerep |
|---|---|
| `js/camelot.js` | kulcs-normalizálás (`Am`, `F#m`, `8A` → Camelot), harmónia-távolság |
| `js/rbxml.js` | Rekordbox XML olvasás/írás, M3U8, tracklista |
| `js/planner.js` | szűrők, rendezés, átmenet-minősítés, offline szett-építő |
| `js/ai.js` | Claude-kérés, válasz-validálás (csak létező azonosítók, duplikáció nélkül) |
| `js/db.js` | IndexedDB réteg |
| `js/app.js` | felület |
