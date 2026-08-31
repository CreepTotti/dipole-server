'use strict';

/**
 * DiPole - AI-lepes szandekos megjelenitesi kesleltetesenek tesztje.
 *
 * Felhasznaloi visszajelzes alapjan (2026-08-31, elso eles online teszt):
 * korabban a lancolt AI-lepesek (lasd roomManager.js _maybeAutoPlayAiTurns)
 * TELJESEN azonnal jelentek meg, az ora barmilyen lathato pergese nelkul -
 * ez zavarot keltett ("nem szamol az AI oraja"). Ez a teszt azt ellenorzi,
 * hogy alapertelmezett beallitasokkal (aiMoveDelayMs NINCS felulirva, tehat
 * a production-ertek, AI_MOVE_DELAY_MS ervenyes):
 *  - a lepes MEGJELENITESE ~2-3 masodpercet kesik (nem azonnali),
 *  - eközben legalabb egy 'timer:tick' esemeny is erkezik (tehat az ora
 *    lathatoan pereg),
 *  - de a kesleltetes nem tul hosszu (nem kell egy teljes kort/percet varni).
 *
 * A gyorsabb setup erdekeben itt NEM a valodi "3x kihagyott kor" utvonalon
 * megyunk vegig (azt a simulate-ai-takeover.js mar kulon, telejesen lefedi) -
 * kozvetlenul, a RoomManager peldanyon keresztul allitjuk be, hogy player1-et
 * mar korabban "atvette volna a gep", és csak a KESLELTETES idozitesere
 * koncentralunk.
 *
 * Futtatas: node test/simulate-ai-move-delay.js
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
  const PORT = 4114;
  // aiMoveDelayMs SZANDEKOSAN nincs felulirva -> a production alapertelmezes
  // (AI_MOVE_DELAY_MS, lasd roomManager.js) ervenyes. turnSeconds=10, hogy a
  // rendes ora-lejarat biztosan ne fusson bele a mesterseges kesleltetesbe.
  const { httpServer, rooms } = createServer({ port: PORT, turnSeconds: 10 });
  const url = `http://localhost:${PORT}`;

  const c1 = ioClient(url, { transports: ['websocket'] });
  const c2 = ioClient(url, { transports: ['websocket'] });
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  const c2StartP = waitFor(c2, 'match:start');
  c1.emit('queue:join', { displayName: 'Alice' });
  await waitFor(c1, 'queue:waiting');
  c2.emit('queue:join', { displayName: 'Bob' });
  await waitFor(c1, 'match:start');
  await c2StartP;

  const room = rooms.getRoomBySocket(c1.id);
  room.players[1].aiControlled = true; // "mintha mar korabban atvette volna a gep"

  const tickPromise = waitFor(c2, 'timer:tick');
  const aiMoveP = waitFor(c2, 'state:update');
  const start = Date.now();
  rooms._maybeAutoPlayAiTurns(room);

  const tick = await tickPromise;
  log(
    typeof tick.timer === 'number' && tick.timer < 10,
    'A kesleltetes alatt legalabb egy timer:tick erkezik - az ora lathatoan pereg',
    `timer=${tick.timer}`
  );

  const aiUpdate = await aiMoveP;
  const elapsed = Date.now() - start;
  log(aiUpdate.cause === 'ai-move', 'Az AI lepese vegul megerkezik', `cause=${aiUpdate.cause}`);
  log(elapsed >= 2000, 'Az AI lepesenek megjelenitese szandekosan kesik nehany masodpercet (nem azonnali)', `elapsed=${elapsed}ms`);
  log(elapsed < 5000, 'A kesleltetes nem tul hosszu (nem kell egy teljes kort/percet varni)', `elapsed=${elapsed}ms`);

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
