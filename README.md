# DiPole szerver — F1 váz

Ez a `dipole-roadmap` F1 fázisának első, ténylegesen futó és tesztelt szelete:
egy Socket.io alapú szerver, ami **szerveroldalon, hitelesen** validálja a
lépéseket a már meglévő, kliens-független motorra (`app/engine/board.js`)
építve — nem duplikálja a szabályokat, ugyanazt a fájlt importálja.

## Futtatás

```bash
npm install
npm start                 # szerver indítása (alapértelmezett port: 4000)
npm run test:simulate      # végpontok-közötti demó: 2 kliens lejátszik egy teljes partit
node test/simulate-timeout.js   # az óra lejártakor történő automatikus lépés tesztje
```

## Mit tud már ez a váz

- **Matchmaking**: FIFO — az első várakozó klienshez párosítja a másodikat, szobát nyit.
- **Szerveroldali lépésvalidáció**: minden `move:*` eseményt a motor dönt el
  (helyes-e a kör, üres-e a mező stb.) — a kliens sosem megbízható forrás.
- **Óra**: szerveroldali, másodpercenkénti; lejáratkor a motor saját
  `handleTimeout` logikája lép a játékos helyett (ugyanaz, mint az AI-nál).
- **Feladás** (`resign`).
- **Disconnect-értesítés**: ha valaki kilép, az ellenfél azonnal értesítést kap.

## Esemény-protokoll (Socket.io)

Kliens → szerver:

| Esemény | Payload | Leírás |
|---|---|---|
| `queue:join` | `{ displayName }` | Belépés a matchmaking sorba |
| `move:primary` | `{ row, col }` | Elsődleges jel lerakása |
| `move:secondary` | `{ row, col }` | Másodlagos jel lerakása |
| `move:retract` | – | Elsődleges lépés visszavonása |
| `resign` | – | Feladás |

Szerver → kliens:

| Esemény | Payload | Leírás |
|---|---|---|
| `queue:waiting` | – | Nincs még ellenfél |
| `match:start` | `{ roomId, playerNumber, opponentName, state }` | Megtalált ellenfél, indul a parti |
| `state:update` | `{ state, cause, result }` | Bármilyen állapotváltozás (lépés vagy timeout) |
| `move:rejected` | `{ error }` | Csak a kezdeményezőnek — a lépés érvénytelen volt |
| `timer:tick` | `{ timer }` | Másodpercenkénti visszaszámláló |
| `match:end` | `{ status, winner }` | A parti véget ért |
| `opponent:disconnected` | – | Az ellenfél kilépett |

## Amit ez a váz SZÁNDÉKOSAN nem tartalmaz még

Ezek a Roadmap F1 kártyáján felsorolt további alfeladatok — külön lépésben jönnek:

- **Fiók/azonosítás** — jelenleg bárki bárhogyan csatlakozhat, `displayName`
  puszta szöveg, nincs hitelesítés.
- **Perzisztencia** — minden állapot a Node-folyamat memóriájában él;
  újraindításkor minden folyamatban lévő meccs elvész.
- **Újracsatlakozás** — `opponent:disconnected` csak értesít, a szoba nem
  vár és nem enged vissza-csatlakozást.
- **Skálázás** — egyetlen folyamat memóriájában tárolt szobák; több szerver-
  példány esetén szükség lesz megosztott állapotra (pl. Redis) vagy sticky
  session-ökre a WebSocket-kapcsolatokhoz.
- **Rangsor-alapú matchmaking** — jelenleg tisztán FIFO, nem néz sem
  szintet, sem előzményt.
