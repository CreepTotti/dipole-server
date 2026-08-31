'use strict';

/**
 * DiPole - a koridő (timer) NEM allhat vissza a teljes ertekre egy onmagaban
 * levo ELSODLEGES lepestol, sem annak visszavonasatol (retract) - csakis a
 * TELJES lepespar lezarasakor (masodlagos lepes), amikor a kor tenylegesen
 * atvalt a masik jatekosra (lasd engine/board.js: switchPlayer).
 *
 * Felhasznaloi visszajelzes alapjan (2026-08-31, elso eles online teszt):
 * "Az első lépés lerakása után most az idő újraindul 60s-tól. Ez eddig nem
 * így volt, és nem is helyes működés." Root cause: a RoomManager.applyMove
 * korabban FELTETEL NELKUL ujraallitotta az orat MINDEN sikeres akcio utan
 * (meg a csak-elsodleges lepes utan is), felulirva az engine sajat, szandekos
 * dontesét (retractPrimary() kifejezetten NEM allitja vissza az orat, "ne
 * lehessen idot lopni" - lasd ott a megjegyzest).
 *
 * Futtatas: node test/simulate-turn-timer.js
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
  const PORT = 4116;
  const TURN_SECONDS = 6;
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
    c1Start.state.timer === TURN_SECONDS,
    `A meccs a beallitott (${TURN_SECONDS} mp-es) koridovel indul`,
    `timer=${c1Start.state.timer}`
  );

  // Varjunk kb. 2 masodpercet, hogy az ora tenylegesen csokkenjen, mielott
  // lepnenk - igy a "visszaallt-e teljesen a lepes utan?" ellenorzes
  // egyertelmu (nem csak veletlen egybeeses egy meg le nem futott tick miatt).
  await sleep(2200);

  // ---------- Onmagaban levo ELSODLEGES lepes: az ora NEM allhat vissza ----------
  const primaryUpdateP = waitFor(c1, 'state:update');
  c1.emit('move:primary', { row: 10, col: 10 });
  const primaryUpdate = await primaryUpdateP;
  log(
    primaryUpdate.state.timer < TURN_SECONDS,
    'Onmagaban levo ELSODLEGES lepes utan az ora NEM all vissza a teljes koridore',
    `timer=${primaryUpdate.state.timer} (teljes: ${TURN_SECONDS})`
  );
  const timerAfterPrimary = primaryUpdate.state.timer;

  await sleep(1200);

  // ---------- Visszavonas (retract): az ora MEG MINDIG NEM allhat vissza ----------
  const retractUpdateP = waitFor(c1, 'state:update');
  c1.emit('move:retract');
  const retractUpdate = await retractUpdateP;
  log(
    retractUpdate.state.timer < TURN_SECONDS && retractUpdate.state.timer <= timerAfterPrimary,
    'Visszavonas (retract) utan sem all vissza az ora - nem lehet vele "idot lopni"',
    `timer=${retractUpdate.state.timer} (elsodleges utan: ${timerAfterPrimary})`
  );

  // ---------- A TELJES lepespar (elsodleges + masodlagos) lezarasa UTAN mar IGEN, vissza kell alljon ----------
  const primaryUpdate2P = waitFor(c1, 'state:update');
  c1.emit('move:primary', { row: 10, col: 10 });
  await primaryUpdate2P;

  const c2SecondaryUpdateP = waitFor(c2, 'state:update'); // az ellenfel a lezart parral egyutt ertesul
  c1.emit('move:secondary', { row: 10, col: 11 });
  const secondaryUpdate = await c2SecondaryUpdateP;
  log(
    secondaryUpdate.state.timer === TURN_SECONDS,
    'A TELJES lepespar (masodlagos lepessel) lezarasa utan az ora MOST MAR helyesen visszaall a teljes koridore (a kor a masik jatekosra valtott)',
    `timer=${secondaryUpdate.state.timer} (varhato: ${TURN_SECONDS})`
  );
  log(
    secondaryUpdate.state.currentPlayer === 2,
    'A kor tenylegesen a masik (2.) jatekosra valtott',
    `currentPlayer=${secondaryUpdate.state.currentPlayer}`
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
