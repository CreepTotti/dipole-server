'use strict';

/**
 * DiPole - F1 backend-vaz demonstracios/ellenorzo szkript.
 *
 * Nem automatizalt unit teszt (nincs test-runner kotve hozza), hanem egy
 * vegponttol-vegpontig fuggo demo: elinditja a szervert helyben, ket valodi
 * socket.io kliensel csatlakozik, es vegigjatszik egy teljes, 1. jatekos
 * gyozelmevel zarulo partit - kozben szandekosan ervenytelen lepesekkel is
 * probalkozik, hogy lassuk: a szerver tenyleg elutasitja oket.
 *
 * Futtatas: node test/simulate-match.js
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
  const PORT = 4111;
  const { httpServer, rooms } = createServer({ port: PORT, aiMoveDelayMs: 0 });

  const url = `http://localhost:${PORT}`;
  let c1 = ioClient(url, { transports: ['websocket'] }); // 'let': lasd lent, mid-game disconnect+rejoin teszt uj sockettel folytatja
  const c2 = ioClient(url, { transports: ['websocket'] });

  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  // ---------- Matchmaking: ket kliens -> egy szoba ----------
  const c2StartP = waitFor(c2, 'match:start');
  c1.emit('queue:join', { displayName: 'Alice' });
  const waitingP = waitFor(c1, 'queue:waiting');
  await waitingP;
  c2.emit('queue:join', { displayName: 'Bob' });
  const c1Start = await waitFor(c1, 'match:start');
  const c2Start = await c2StartP;

  log(c1Start.playerNumber === 1 && c2Start.playerNumber === 2, 'Matchmaking: ket kliens automatikusan parositva, helyes jatekos-szamokkal', `p1=${c1Start.playerNumber} p2=${c2Start.playerNumber}`);
  log(c1Start.roomId === c2Start.roomId, 'Mindket kliens ugyanabba a szobaba kerult');
  log(c1Start.opponentName === 'Bob' && c2Start.opponentName === 'Alice', 'Az ellenfel neve helyesen atadva mindket oldalon');

  const players = { 1: c1, 2: c2 };

  // ---------- Ervenytelen lepes: nem-soron-levo jatekos probalkozik ----------
  {
    const rejectedP = waitFor(c2, 'move:rejected');
    c2.emit('move:primary', { row: 10, col: 10 }); // c2 = player 2, de player 1 kovetkezik
    const rej = await rejectedP;
    log(rej.error === 'not-your-turn', 'A szerver elutasitja a lepest, ha nem az adott jatekos van soron', JSON.stringify(rej));
  }

  // ---------- Az ellenfel nem lat "fuggoben levo" elsodleges lepest, meg annak visszavonasat sem ----------
  {
    let c2SawUpdate = false;
    const c2Listener = () => { c2SawUpdate = true; };
    c2.on('state:update', c2Listener);

    const c1PrimaryUpdateP = waitFor(c1, 'state:update');
    c1.emit('move:primary', { row: 0, col: 0 });
    await c1PrimaryUpdateP; // c1 (a lepo fel) sajat maga azonnal latja a sajat lepeset

    const c1RetractUpdateP = waitFor(c1, 'state:update');
    c1.emit('move:retract'); // "veletlen erintes" szimulalasa - visszavonja, hogy a fo szekvenciat ne zavarja
    await c1RetractUpdateP;

    await new Promise((resolve) => setTimeout(resolve, 200));
    log(!c2SawUpdate, 'Az ellenfel (C2) semmilyen ertesitest nem kap egy fuggoben levo elsodleges lepesrol, meg annak visszavonasarol sem');
    c2.off('state:update', c2Listener);
  }

  // ---------- Disconnect meg folyamatban levo partinal: az ellenfel valos idejű ertesitest kap ----------
  // FONTOS: ezt SZANDEKOSAN itt, meg a parti kozepen teszteljuk, nem a vege
  // utan - 2026-08-31 utan (lasd RoomManager._endMatch) a meccs lezarasakor a
  // szerver mar teljesen takarit (szoba + socket-terkepek + tokenek), igy egy
  // MECCS UTANI kilepes mar nem eredmenyez ertesitest (nincs mit "kilepni"-
  // rol jelezni) - ezt kulon, lentebb, a lezart parti utan ellenorizzuk.
  {
    const disconnectedP = waitFor(c2, 'opponent:disconnected');
    c1.close();
    await disconnectedP;
    log(true, 'Meg folyamatban levo partinal az egyik fel kilepesekor a masik fel valos idejű ertesitest kap');

    // Ujracsatlakozas ugyanazzal a sessionTokennel - innentol egy UJ socket
    // (c1b) folytatja a tesztet c1 helyett (ugyanugy, mint egy valodi
    // oldal-ujratoltes/rovid net-kimaradas utan).
    const c1b = ioClient(url, { transports: ['websocket'] });
    await waitFor(c1b, 'connect');
    const rejoinedP = waitFor(c1b, 'match:start');
    c1b.emit('match:rejoin', { sessionToken: c1Start.sessionToken });
    const rejoinResult = await rejoinedP;
    log(
      rejoinResult.rejoined === true && rejoinResult.playerNumber === 1,
      'Az ujracsatlakozas sikeres, ugyanazzal a jatekosszammal, a parti folytathato',
      JSON.stringify({ rejoined: rejoinResult.rejoined, playerNumber: rejoinResult.playerNumber })
    );
    c1 = c1b;
    players[1] = c1b;
  }

  // ---------- Egy teljes, 1. jatekos gyozelmevel zarulo parti lejatszasa ----------
  // Ugyanaz a "gapelt" lepesszekvencia-logika, amit korabban a demo_animations.js
  // is hasznalt a kliens-oldali animacio-demohoz - itt most szerver-oldali
  // hitelesitessel jatsszuk le, es azt ellenorizzuk, hogy MINDKET kliens
  // szinkronban latja a vegeredmenyt.
  const row = 12;
  const startCol = 2;
  const p2Row = row - 3;

  async function pair(playerNum, pRow, pCol, sRow, sCol) {
    const otherNum = playerNum === 1 ? 2 : 1;
    // Az elsodleges lepest SZANDEKOSAN csak a lepo fel sajat socketje kapja
    // meg (lasd fenti kulon teszt-blokk) - az ellenfelre itt nem varunk.
    players[playerNum].emit('move:primary', { row: pRow, col: pCol });
    await waitFor(players[playerNum], 'state:update');

    const otherUpdateP2 = waitFor(players[otherNum], 'state:update');
    players[playerNum].emit('move:secondary', { row: sRow, col: sCol });
    const finalUpdate = await waitFor(players[playerNum], 'state:update');
    await otherUpdateP2;
    return finalUpdate;
  }

  let lastUpdate;
  for (let i = 0; i < 4; i++) {
    const col = startCol + i;
    const secRow = i % 2 === 0 ? row + 1 : row - 1;
    lastUpdate = await pair(1, row, col, secRow, col);

    const p2Col = startCol + i * 2;
    const p2SecRow = i % 2 === 0 ? p2Row - 1 : p2Row + 1;
    lastUpdate = await pair(2, p2Row, p2Col, p2SecRow, p2Col);
  }

  const lastCol = startCol + 4;
  const lastSecRow = row - 1;
  const c2EndP = waitFor(c2, 'match:end');
  const c1EndP = waitFor(c1, 'match:end');
  c1.emit('move:primary', { row, col: lastCol });
  await waitFor(c1, 'state:update');
  c1.emit('move:secondary', { row: lastSecRow, col: lastCol });
  const [c1End, c2End] = await Promise.all([c1EndP, c2EndP]);

  log(c1End.status === 'won' && c1End.winner === 1, 'A parti tenylegesen gyozelemmel zarul, es a gyoztes az 1. jatekos', JSON.stringify(c1End));
  log(c1End.status === c2End.status && c1End.winner === c2End.winner, 'Mindket kliens UGYANAZT a vegeredmenyt kapja (szinkronban vannak)');

  // ---------- Jatek vege utan tovabbi lepes mar nem fogadhato el ----------
  // 2026-08-31 utan (lasd RoomManager._endMatch) a meccs lezarasakor a szerver
  // AZONNAL torli a szoba- es socket-terkep-bejegyzeseket is (nem csak a
  // sessionToken-eket, mint korabban) - egy ilyen keses lepes-kiserlet ezert
  // mar a "nincs is aktiv meccsed" hibat kapja ('not-in-a-match'), nem a
  // korabbi 'game-not-playing'-et (az utobbihoz meg tenylegesen meg kellene
  // talalnia a mar lezart szobat - de az mar nem letezik).
  {
    const rejectedP = waitFor(c1, 'move:rejected');
    c1.emit('move:primary', { row: 0, col: 0 });
    const rej = await rejectedP;
    log(rej.error === 'not-in-a-match', 'Lezart parti utan a szerver mar nem fogad el tovabbi lepest', JSON.stringify(rej));
  }

  // ---------- Lezart parti utan a kilepes MAR NEM eredmenyez ertesitest ----------
  // (A szoba es a socket-terkep mar torolve a meccs vegen - lasd fent - igy
  // nincs mit "ellenfel kilepett"-kent jelezni. Ez a memoriaszivargas-javitas
  // regresszios teszjte: ha valaha visszaterne a regi, "a szoba orokre
  // memoriaban marad" viselkedes, ez a teszt PASS-szal terne vissza, de a
  // gyakorlatban a szerver memoriahasznalata korlatlanul nott volna hosszan
  // futo (pl. ingyenes Render) peldanyon minden lejatszott meccsel.)
  {
    let c2Notified = false;
    const listener = () => { c2Notified = true; };
    c2.on('opponent:disconnected', listener);
    c1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    log(!c2Notified, 'Mar lezart parti utan a masik fel kilepese nem eredmenyez tobbe ertesitest (a szoba mar takaritva van)');
    c2.off('opponent:disconnected', listener);
  }

  c2.close();
  httpServer.close();
  console.log('\nOsszes ellenorzes lefutott.');
  process.exit(0);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
