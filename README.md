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
node test/simulate-timeout.js       # az óra lejártakor történő automatikus lépés tesztje
node test/simulate-ai-takeover.js   # újracsatlakozás + AI-átvétel tesztje
node test/simulate-ai-move-delay.js # az AI-lépés szándékos megjelenítési késleltetésének tesztje
node test/simulate-turn-timer.js    # a köridő csak a TELJES lépéspár lezárásakor áll vissza, egy önmagában levő elsődlegesnél/visszavonásnál nem
node test/simulate-double-ai-takeover.js # mindkét oldalt átveszi a gép -> a 2 AI végigjátssza egymás ellen, a szoba utána takarítva van
node test/simulate-client-metadata.js    # a kliens UI-hoz (x/3 auto-lépés, "AI - <szint>") szükséges missedTurns/aiDifficulty mezők jelen vannak minden érintett eseményben
```

## Mit tud már ez a váz

- **Matchmaking**: FIFO — az első várakozó klienshez párosítja a másodikat, szobát nyit.
- **Szerveroldali lépésvalidáció**: minden `move:*` eseményt a motor dönt el
  (helyes-e a kör, üres-e a mező stb.) — a kliens sosem megbízható forrás.
- **Óra**: szerveroldali, másodpercenkénti; lejáratkor a motor saját
  `handleTimeout` logikája lép a játékos helyett (ugyanaz, mint az AI-nál) -
  KIVÉVE, ha az adott oldalt már a gép vezeti (lásd lent), mert akkor a
  meglévő AI-motor (`ai/ai.js`, `easy` nehézség) dönt a random helyett. A
  köridő KIZÁRÓLAG akkor áll vissza a teljes értékére, amikor a lépéspár
  (elsődleges + másodlagos) ténylegesen lezárul és a kör átvált a másik
  játékosra (`engine/board.js`: `switchPlayer`) — egy önmagában levő
  elsődleges lépés, vagy annak visszavonása (`retract`), NEM állítja vissza
  az órát (2026-08-31, felhasználói visszajelzés alapján javítva: korábban a
  `RoomManager.applyMove` feltétel nélkül minden sikeres akció után
  visszaállította az órát, így a csak-elsődleges lépés is dupla időt adott a
  játékosnak a másodlagosra — lásd `test/simulate-turn-timer.js`).
- **Feladás** (`resign`).
- **Disconnect-értesítés**: ha valaki kilép, az ellenfél azonnal értesítést kap.
- **Újracsatlakozás**: minden játékos kap egy `sessionToken`-t a
  `match:start`-kor. Egy megszakadt (pl. rövid net-kimaradás miatti)
  kapcsolat helyett egy új socket-kapcsolat ugyanezzel a tokennel
  (`match:rejoin`) visszakerül ugyanabba, még folyamatban lévő meccsbe - a
  másik fél `opponent:reconnected` értesítést kap. Csak a Node-folyamat
  memóriájában él (nem éli túl a szerver-újraindítást, és a token a kliens
  memóriájában van, nem oldal-újratöltés-biztos - ez a lenti perzisztencia
  ponttal együtt oldódik meg).
- **AI-átvétel**: ha egy játékos 3 egymást követő kört kihagy (nem lép
  időben - akár mert nem kattint, akár mert megszakadt a kapcsolata), a
  szerver az ellenfélnek a `player:ai-takeover` eseménnyel jelzi, hogy
  mostantól a gép lép a hibázó fél helyett (a meglévő AI-motorral, `easy`
  nehézségen). A hibázó felet a szerver EBBEN A PILLANATBAN, VÉGLEGESEN és
  TELJESEN kizárja a partiból: ha éppen csatlakozva van, `kicked:ai-takeover`
  értesítést kap, kikerül a szoba Socket.io-csoportjából, és a szerver
  bontja is a kapcsolatát; onnantól semmilyen `match:rejoin` nem sikerül
  neki ehhez a meccshez - MÉG NÉZŐKÉNT (spectator) SEM térhet vissza -,
  ilyen kísérlet `rejoin:failed`-et kap `ai-took-over` hibával. Ez szándékos:
  a meccs kimenetele (a másik játékos jövőbeli "AI-győzelem" statisztikája/
  jutalma) nem befolyásolható attól, akit ledobott a hálózat, vagy aki nem
  lépett időben - ezért a szerver ettől kezdve MINDEN lépését (a feladást,
  `resign`-t is beleértve) elutasítja (`player-is-ai-controlled`) is, bár a
  gyakorlatban ő már a szobát sem éri el. Az AI a lépését azonnal
  kiszámolja, de a MEGJELENÍTÉSE (a broadcast) szándékosan ~2,5 másodpercet
  késik (`AI_MOVE_DELAY_MS` konstans / `aiMoveDelayMs` konstruktor-opció a
  `createServer`/`RoomManager`-en) — így a köridő láthatóan tovább pereg
  (`timer:tick` események továbbra is érkeznek a késleltetés alatt), nem
  úgy tűnik, mintha az AI órája nem számolna. Teszteléskor (`test/simulate-
  *.js`) ez az érték szándékosan `0`-ra van állítva a gyors, determinisztikus
  lefutás érdekében — a valós késleltetést a `test/simulate-ai-move-
  delay.js` fedi.
  - **Mindkét oldalt átveszi a gép**: mivel a kihagyott-kör-számláló minden
    játékosnál csak a SAJÁT körei alapján nő, elméletileg mindkét fél
    (egymástól függetlenül) elérheti a 3 kihagyást és kizárásra kerülhet. Ez
    esetben a két "easy" AI egymás ellen, teljesen automatikusan végigjátssza
    a partit (a fenti megjelenítési késleltetéssel), amíg valódi eredmény
    (győzelem vagy döntetlen) nem születik — a szerver ezt NEM szakítja meg
    és nem hagyja "megakadva". Lásd `test/simulate-double-ai-takeover.js`.
- **Meccs-lezárás és takarítás**: minden lezárási út (időtúllépés, AI-lánc,
  és egy emberi lépés által okozott győzelem/döntetlen/feladás is) egyetlen
  központi helyen fut át (`RoomManager._endMatch`/`endMatch`), ami a
  `match:end` kiküldése mellett TELJESEN eltávolítja a szobát a szerver
  memóriájából (`sessionToken`-ek, `socketToRoom`-bejegyzések, maga a szoba
  objektum). Korábban ez soha nem történt meg egyetlen véget ért meccsnél sem
  — ez hosszan futó szerveren (pl. az ingyenes Render-instance-on) lassú, de
  korlátlan memóriaszivárgást okozott volna, mivel minden valaha lejátszott
  parti örökre a memóriában maradt volna. Lásd `test/simulate-double-ai-
  takeover.js` (ami ezt kifejezetten a "mindkét oldalt átvette a gép"
  forgatókönyvre ellenőrzi) és a `test/simulate-match.js` végén lévő
  regressziós ellenőrzést.

## Esemény-protokoll (Socket.io)

Kliens → szerver:

| Esemény | Payload | Leírás |
|---|---|---|
| `queue:join` | `{ displayName }` | Belépés a matchmaking sorba |
| `match:rejoin` | `{ sessionToken }` | Visszacsatlakozás egy folyamatban lévő meccshez |
| `move:primary` | `{ row, col }` | Elsődleges jel lerakása |
| `move:secondary` | `{ row, col }` | Másodlagos jel lerakása |
| `move:retract` | – | Elsődleges lépés visszavonása |
| `resign` | – | Feladás |

Szerver → kliens:

| Esemény | Payload | Leírás |
|---|---|---|
| `queue:waiting` | – | Nincs még ellenfél |
| `match:start` | `{ roomId, playerNumber, opponentName, state, sessionToken, aiControlled, opponentAiControlled, missedTurns, aiDifficulty, rejoined? }` | Megtalált ellenfél (vagy sikeres újracsatlakozás - ekkor `rejoined: true`), indul/folytatódik a parti. `missedTurns`: `{ 1: n, 2: n }`, mindkét fél aktuális kihagyott-kör-száma (kliens-oldali "x/3" jelzéshez). `aiDifficulty`: a szerveroldali AI nehézsége (jelenleg mindig `'easy'`) - a kliens ezt jeleníti meg AI-átvétel esetén "AI - (szint)" formában. |
| `state:update` | `{ state, cause, result, missedTurns }` | Bármilyen állapotváltozás - `cause`: `'primary'`\|`'secondary'`\|`'retract'`\|`'resign'`\|`'timeout'`\|`'ai-move'` (ez utóbbi: az AI-átvett oldal saját, óra lejárta előtti automatikus lépése). FONTOS: `'primary'` és `'retract'` okú frissítést a szerver KIZÁRÓLAG a lépést végző félnek küldi el (`socket.emit`, nem szoba-broadcast) — az ellenfél csak a lépéspár lezárásakor (`'secondary'` ok) értesül, egyszerre mindkét jelről; így a fél lépés vagy annak visszavonása nem látszik előre a másik oldalon. `missedTurns`: ugyanaz a `{ 1: n, 2: n }` alak, mint a `match:start`-nál - minden állapotváltozásnál frissítve küldve, hogy a kliens "x/3" jelzése mindig aktuális maradjon. |
| `move:rejected` | `{ error }` | Csak a kezdeményezőnek — a lépés érvénytelen volt (pl. `player-is-ai-controlled`) |
| `timer:tick` | `{ timer }` | Másodpercenkénti visszaszámláló |
| `match:end` | `{ status, winner }` | A parti véget ért |
| `opponent:disconnected` | – | Az ellenfél kilépett |
| `opponent:reconnected` | – | Az ellenfél visszacsatlakozott |
| `player:ai-takeover` | `{ playerNumber, displayName, aiDifficulty }` | Csak az ELLENFÉLNEK: az adott oldalt mostantól a gép vezeti (3 kihagyott kör után) - a hibázó fél ezt már nem kapja meg (lásd `kicked:ai-takeover`) |
| `kicked:ai-takeover` | `{ playerNumber, displayName }` | Csak a hibázó félnek, közvetlenül a kizárás pillanatában (ha épp csatlakozva van): a gép vette át a helyét, és a szerver azonnal ki is zárja a partiból (a szerver ezután bontja is a kapcsolatot) |
| `rejoin:failed` | `{ error }` | A `match:rejoin` nem sikerült - `'ai-took-over'`: a gép már átvette ezt az oldalt (véglegesen, még nézőként sem térhet vissza); egyéb (`'unknown-session'`, `'match-ended'`): ismeretlen vagy már lezárt meccshez tartozó token |

## Amit ez a váz SZÁNDÉKOSAN nem tartalmaz még

Ezek a Roadmap F1 kártyáján felsorolt további alfeladatok — külön lépésben jönnek:

- **Fiók/azonosítás** — jelenleg bárki bárhogyan csatlakozhat, `displayName`
  puszta szöveg, nincs hitelesítés.
- **Perzisztencia** — minden állapot a Node-folyamat memóriájában él;
  újraindításkor minden folyamatban lévő meccs (és minden `sessionToken`)
  elvész. Emiatt az újracsatlakozás is csak addig működik, amíg a szerver-
  folyamat fut, és csak addig, amíg a kliens (böngészőlap) nyitva marad -
  oldal-bezárás/újratöltés esetén a token elvész.
- **Skálázás** — egyetlen folyamat memóriájában tárolt szobák; több szerver-
  példány esetén szükség lesz megosztott állapotra (pl. Redis) vagy sticky
  session-ökre a WebSocket-kapcsolatokhoz.
- **Rangsor-alapú matchmaking** — jelenleg tisztán FIFO, nem néz sem
  szintet, sem előzményt.
