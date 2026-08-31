'use strict';

/**
 * DiPole - mi tortenik, ha EGYIK jatekos SEM lep soha (mindket oldalt atveszi
 * a gep)? Felhasznaloi kerdes alapjan (2026-08-31): "Olyankor mi történik, ha
 * mindkét játékost kidobja a rendszer? 2 AI lejátssza a játékot vagy platform
 * híján megszakad a játék?"
 *
 * Ez a teszt VALODIAN, egyetlen kattintas/emit nelkul lejatssza ezt a
 * forgatokonyvet (mindket kliens csatlakozik, majd tobbe semmit nem kuld) es
 * ellenorzi:
 *  - mindket oldal (egymastol fuggetlenul, sajat kihagyott koreik alapjan)
 *    tenylegesen AI-atvetelre es kizarasra kerul (kicked:ai-takeover mindket
 *    oldalon, egymas utan),
 *  - EZUTAN a ket "easy" AI valoban VEGIGJATSSZA a partit egymas ellen
 *    (a szerver NEM szakitja meg, NEM "akad meg" - match:end tenylegesen
 *    megerkezik, 'won' vagy 'draw' statusszal),
 *  - a meccs veget erese utan a szerver TENYLEGESEN takarit: a szoba mar nem
 *    talalhato a RoomManager.rooms terkepeben (2026-08-31-i javitas - lasd
 *    RoomManager._endMatch: korabban ez SOHA nem tortent meg egyetlen veget
 *    ert meccsnel sem, ami hosszan futo szerveren - pl. ingyenes Render-
 *    instance-on - lassu, korlatlan memoriaszivargast okozott volna).
 *
 * A teszt gyorsitasa erdekeben nagyon rovid koridot (turnSeconds=1) hasznal,
 * igy a "3x egymast koveto kihagyott kor mindket oldalon" forgatokonyv
 * masodperceken belul lejatszodik, nem kell percekig varni.
 *
 * Futtatas: node test/simulate-double-ai-takeover.js
 */

const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/server');

let failures = 0;
function log(ok, label, extra) {
  console.log((ok ? 'OK  ' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
  if (!ok) failures++;
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function main() {
  const PORT = 4117;
  // Rovid koridok, hogy a teszt gyorsan lefusson - senki nem fog lepni.
  const { httpServer, rooms } = createServer({ port: PORT, turnSeconds: 1 });
  const url = `http://localhost:${PORT}`;
  const c1 = ioClient(url, { transports: ['websocket'] });
  const c2 = ioClient(url, { transports: ['websocket'] });
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  const c2StartP = waitFor(c2, 'match:start');
  c1.emit('queue:join', { displayName: 'Alice' });
  await waitFor(c1, 'queue:waiting');
  c2.emit('queue:join', { displayName: 'Bob' });
  const c1Start = await waitFor(c1, 'match:start');
  await c2StartP;
  const roomId = c1Start.roomId;

  log(rooms.rooms.has(roomId), 'A szoba a meccs elejen letezik a szerver memoriajaban', `roomId=${roomId}`);

  // Innentol EGYIK kliens SEM kuld tobbe semmit - mindket oldal sajat
  // kihagyott koreit gyujti, fuggetlenul egymastol, amig mindkettot at nem
  // veszi a gep. Varjuk meg mindket 'kicked:ai-takeover' esemenyt.
  const c1KickedP = waitFor(c1, 'kicked:ai-takeover');
  const c2KickedP = waitFor(c2, 'kicked:ai-takeover');

  const c1Kicked = await c1KickedP;
  log(true, '1. jatekos (soha nem lepett) vegul AI-atvetelre es kizarasra kerul', `playerNumber=${c1Kicked.playerNumber}`);

  const c2Kicked = await c2KickedP;
  log(true, '2. jatekos (o SEM lepett soha) FUGGETLENUL, sajat maga is AI-atvetelre es kizarasra kerul', `playerNumber=${c2Kicked.playerNumber}`);

  log(
    (c1Kicked.playerNumber === 1 && c2Kicked.playerNumber === 2) || (c1Kicked.playerNumber === 2 && c2Kicked.playerNumber === 1),
    'Mindket oldal ("1. Jatekos" ES "2. Jatekos" is) valoban kizarasra kerult - egyik sem maradt emberi kezelesben',
    JSON.stringify({ c1Kicked: c1Kicked.playerNumber, c2Kicked: c2Kicked.playerNumber })
  );

  // Mindket kliens socketje mar bontva (a szerver maga zarta) - de a MECCS
  // (a szoba, benne a ket "easy" AI-val) a szerver oldalan tovabb fut, amig
  // termeszetes veget nem er (gyozelem vagy dontetlen). Ezt egy FRISS,
  // "megfigyelo" kapcsolattal kovetjuk nyomon (nem veszunk reszt a meccsben,
  // csak a szerver oldali RoomManager allapotat es a szoba tenyleges
  // lezarasat ellenorizzuk kozvetlenul).
  const room = rooms.rooms.get(roomId);
  if (!room) throw new Error('A szoba varatlanul mar a kizarasok pillanataban eltunt - ez nem helyes.');

  const deadline = Date.now() + 120000; // legfeljebb 2 perc - a valodi partiknak jval hamarabb veget kell erniuk
  while (room.state.status === 'playing' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  log(
    room.state.status !== 'playing',
    'A ket "easy" AI TENYLEGESEN vegigjatssza a partit egymas ellen - a szerver nem akad meg, nem szakitja meg',
    `vegso statusz=${room.state.status} gyoztes=${JSON.stringify(room.state.winner)}`
  );

  // Adjunk egy kis idot a match-end-utani takaritasnak (szinkron fut, de a
  // biztonsag kedveert varunk ra egy tick-et).
  await new Promise((resolve) => setTimeout(resolve, 100));

  log(
    !rooms.rooms.has(roomId),
    'A meccs veget erese utan a szerver TENYLEGESEN eltavolitja a szobat a memoriabol (nincs memoriaszivargas)',
    `rooms.size=${rooms.rooms.size}`
  );
  log(
    !rooms.socketToRoom.has(c1.id) && !rooms.socketToRoom.has(c2.id),
    'A ket (mar amugy is bontott) socket-bejegyzes is eltunik a socketToRoom terkepbol'
  );

  c1.close();
  c2.close();
  httpServer.close();

  console.log(`\n${failures === 0 ? 'Osszes' : failures + ' HIBAS'} ellenorzes lefutott.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
