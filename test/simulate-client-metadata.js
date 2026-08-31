'use strict';

/**
 * DiPole - a kliens UI-fejlesztes (2026-08-31, felhasznaloi visszajelzes
 * alapjan: "x/3 auto-lepes jelzese" + "AI - (szint)" egyseges cimke) uj
 * szerver->kliens adatokra tamaszkodik, amik korabban EGYALTALAN nem voltak
 * resze semmilyen payload-nak:
 *
 *  - `missedTurns`: { 1: n, 2: n } - mindket jatekos aktualis kihagyott-kor-
 *    szamlaloja. Jelen kell legyen `match:start`-ban ES minden `state:update`-ben.
 *  - `aiDifficulty`: a szerveroldali AI nehezsege (`match:start` es
 *    `player:ai-takeover` payloadban).
 *
 * Ez a teszt kifejezetten ezt a ket uj mezot ellenorzi vegponttol vegpontig -
 * nem a jatekszabaly-logikat (azt mar a tobbi simulate-*.js fedi).
 *
 * Futtatas: node test/simulate-client-metadata.js
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const PORT = 4118;
  const TURN_SECONDS = 2;
  const { httpServer } = createServer({ port: PORT, turnSeconds: TURN_SECONDS, aiMoveDelayMs: 0 });
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

  log(
    c1Start.missedTurns && c1Start.missedTurns[1] === 0 && c1Start.missedTurns[2] === 0,
    'match:start tartalmazza a kezdeti missedTurns pillanatkepet (mindket oldal 0)',
    JSON.stringify(c1Start.missedTurns)
  );
  log(
    typeof c1Start.aiDifficulty === 'string' && c1Start.aiDifficulty.length > 0,
    'match:start tartalmazza a szerveroldali AI nehezseget (aiDifficulty)',
    `aiDifficulty=${c1Start.aiDifficulty}`
  );

  // Egy sikeres lepes utan a state:update-nek is tartalmaznia kell a
  // (valtozatlan) missedTurns pillanatkepet.
  const updateP = waitFor(c1, 'state:update');
  c1.emit('move:primary', { row: 10, col: 10 });
  const update = await updateP;
  log(
    update.missedTurns && update.missedTurns[1] === 0 && update.missedTurns[2] === 0,
    'state:update (sajat elsodleges lepes utan) is tartalmazza a missedTurns pillanatkepet',
    JSON.stringify(update.missedTurns)
  );
  c1.emit('move:retract'); // tisztitsuk vissza 'primary' fazisra a kovetkezo reszhez

  // ---------- Idokorlat lejarta: a missedTurns-nek nonie kell ----------
  const timeoutUpdateP = waitFor(c2, 'state:update'); // C1 van soron, C2 latja majd a lezart lepespart/timeoutot
  await sleep((TURN_SECONDS + 1) * 1000);
  const timeoutUpdate = await timeoutUpdateP;
  log(
    timeoutUpdate.missedTurns && timeoutUpdate.missedTurns[1] === 1,
    'Idokorlat lejarta utan a hibazo fel (1. jatekos) missedTurns erteke 1-re no, es ez a state:update-ben is lathato',
    JSON.stringify(timeoutUpdate.missedTurns)
  );

  // ---------- Meg ket tovabbi kihagyott kor: AI-atvetel + aiDifficulty ----------
  const takeoverP = waitFor(c2, 'player:ai-takeover');
  await sleep((TURN_SECONDS + 1) * 1000);
  await sleep((TURN_SECONDS + 1) * 1000);
  const takeover = await takeoverP;
  log(
    typeof takeover.aiDifficulty === 'string' && takeover.aiDifficulty.length > 0,
    'player:ai-takeover esemeny tartalmazza az aiDifficulty mezot (kliens "AI - <szint>" cimkejehez)',
    `aiDifficulty=${takeover.aiDifficulty}`
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
