'use strict';

/**
 * DiPole - F1 backend-vaz: a szerveroldali ora tenylegesen kikenyszeriti-e az
 * automatikus lepest, ha egy jatekos nem lep idoben? Lerovidhitett (2 mp-es)
 * korido mellett teszteljuk, hogy gyors legyen.
 *
 * Futtatas: node test/simulate-timeout.js
 */

const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/server');

function log(ok, label, extra) {
  console.log((ok ? 'OK  ' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function main() {
  const PORT = 4112;
  const { httpServer } = createServer({ port: PORT, turnSeconds: 2, aiMoveDelayMs: 0 });
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

  log(c1Start.state.timer === 2, 'A szoba a rovidre allitott (2 mp-es) korido-vel indul a teszthez', `timer=${c1Start.state.timer}`);

  // Senki nem lep - varjuk meg, hogy a szerver sajat maga lepjen helyettunk.
  const timeoutUpdateP = waitFor(c1, 'state:update');
  const update = await timeoutUpdateP;

  log(update.cause === 'timeout', 'A lejaro ido tenylegesen kivaltja a szerver-oldali automatikus lepest', `cause=${update.cause}`);
  log(update.state.turnIndex === 1, 'Az automatikus lepespar utan a kor tovabblep a masik jatekosra', `turnIndex=${update.state.turnIndex} currentPlayer=${update.state.currentPlayer}`);
  log(update.state.currentPlayer === 2, 'Az idozito lejarta utan valoban a masik jatekos kovetkezik', `currentPlayer=${update.state.currentPlayer}`);

  c1.close();
  c2.close();
  httpServer.close();
  console.log('\nOsszes ellenorzes lefutott.');
  // A meccs a teszt vegen meg "playing" allapotban van (csak az 1. kor jart le),
  // igy a szoba sajat ora-intervalluma szandekosan tovabb futna (ez helyes
  // viselkedes egy valodi szerveren) - ez a demoszkript viszont itt mar vegzett,
  // ezert explicit kilepunk, nehogy a nyitott intervallum a folyamatot fogva tartsa.
  process.exit(0);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
