'use strict';

/**
 * DiPole - ujracsatlakozas + AI-atvetel teszt.
 *
 * Ellenorzi:
 *  A) Ujracsatlakozas ("grace period" alatt, MIELOTT barki 3 kort kihagyna):
 *     egy kliens "eltunese" (close) utan egy UJ kapcsolat, a mentett
 *     sessionTokennel, sikeresen visszakerul ugyanabba a meccsbe (meg aktiv
 *     jatekoskent, nem csak nezokent), es az ellenfel 'opponent:reconnected'
 *     ertesitest kap.
 *  B) 3 egymast koveto kihagyott kor utan a szerver AI-atvetelt jelez az
 *     ELLENFELNEK ('player:ai-takeover'), a hibazo jatekost pedig AZONNAL,
 *     teljesen kizarja a partibol: 'kicked:ai-takeover' esemenyt kap, majd a
 *     szerver bontja is a kapcsolatat - ETTOL KEZDVE MEG UJRACSATLAKOZNI SEM
 *     TUD (meg nezokent/spectator-kent sem) - egy uj kapcsolat ugyanazzal a
 *     tokennel 'rejoin:failed'-et kap 'ai-took-over' hibaval.
 *  C) Attol kezdve a soron levo AI-jatekos azonnal (az ora lejarta nelkul)
 *     lep, amint az ellenfel lep. (Eles/production kornyezetben ehhez van
 *     meg egy rovid, szandekos megjelenitesi kesleltetes is - lasd
 *     roomManager.js AI_MOVE_DELAY_MS -, de ez a teszt aiMoveDelayMs:0-val
 *     fut, hogy gyors es determinisztikus maradjon.)
 *
 * MEGJEGYZES a teszt szerkezeterol: mind C1, mind C2 ugyanazt a szoba-szintu
 * 'state:update' broadcastot kapja MINDEN lepesre (nemcsak a sajatjara), es
 * a ket kliens kulon socket-kapcsolat, ezert az erkezes SORRENDJE/idozitese
 * a ket oldalon nem szinkron. Ezert a nyers `.once(event, cb)` mintat NEM
 * hasznaljuk 'state:update'-re (az konnyen "elcsipne" egy meg le nem
 * zajlott, korabbi korbol erkezo, keso kezbesitesu masolatot) - helyette egy
 * allando listenerrel MINDENT sorba gyujtunk, es a teszt sajat tempojaban,
 * FIFO sorrendben olvassa ki oket.
 *
 * Rovidre allitott (1 mp-es) korido mellett fut, hogy gyors legyen.
 * Futtatas: node test/simulate-ai-takeover.js
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

/** FIFO esemenygyujto: a listenert azonnal, allandoan felakasztjuk, es .next() sorban adja vissza a beerkezett payloadokat - igy nem eshetunk race condition-be a ket kulon kliens-kapcsolat eltero kezbesitesi idozitese miatt. */
function collectEvents(socket, event) {
  const queue = [];
  const waiters = [];
  socket.on(event, (payload) => {
    if (waiters.length > 0) waiters.shift()(payload);
    else queue.push(payload);
  });
  return {
    next() {
      return new Promise((resolve) => {
        if (queue.length > 0) resolve(queue.shift());
        else waiters.push(resolve);
      });
    },
    // Hany, meg ki NEM vett esemeny var a soron - kizarolag "nem erkezett meg
    // semmi" ellenorzesekhez (SOSEM hivjuk itt a next()-et, mert az egy
    // "orokre fuggoben maradt" waiter-t hagyna a sorban, ami elcsipne egy
    // KESOBBI, tenylegesen vart esemenyt).
    pending() {
      return queue.length;
    },
  };
}

/** Az elso ket szomszedos (vizszintesen egymas melletti) ures mezo egy adott allapotban - a tesztkliens "emberi" lepeseihez, mindig a friss allapotbol szamolva, hogy sose utkozzunk mar elfoglalt mezovel. */
function findFreeAdjacentPair(state) {
  for (let r = 0; r < state.size; r++) {
    for (let c = 0; c < state.size - 1; c++) {
      if (state.board[r][c].state === 'empty' && state.board[r][c + 1].state === 'empty') {
        return { primary: { row: r, col: c }, secondary: { row: r, col: c + 1 } };
      }
    }
  }
  return null;
}

async function main() {
  const PORT = 4113;
  // aiMoveDelayMs: 0 - ez a teszt kifejezetten a lancolt AI-lepes SEBESSEGET
  // vizsgalja (lasd C) resz), es a rovid (1 mp-es) turnSeconds mellett egy
  // eles-kornyezeti mesterseges kesleltetes (lasd AI_MOVE_DELAY_MS a
  // roomManager.js-ben) versenyhelyzetbe kerulne a rendes ora-lejarattal.
  const { httpServer } = createServer({ port: PORT, turnSeconds: 1, aiMoveDelayMs: 0 });
  const url = `http://localhost:${PORT}`;

  // ========== A) UJRACSATLAKOZAS a "grace period" alatt (meg senki nem hagyott ki 3 kort) ==========
  {
    const d1 = ioClient(url, { transports: ['websocket'] });
    const d2 = ioClient(url, { transports: ['websocket'] });
    await Promise.all([waitFor(d1, 'connect'), waitFor(d2, 'connect')]);

    const d2StartP = waitFor(d2, 'match:start');
    d1.emit('queue:join', { displayName: 'Alice' });
    await waitFor(d1, 'queue:waiting');
    d2.emit('queue:join', { displayName: 'Bob' });
    const d1Start = await waitFor(d1, 'match:start');
    await d2StartP;

    const d1Token = d1Start.sessionToken;
    const d1PlayerNumber = d1Start.playerNumber;

    const opponentReconnectedP = waitFor(d2, 'opponent:reconnected');
    d1.close();
    await new Promise((r) => setTimeout(r, 150)); // rovid vartatas a disconnect feldolgozasara

    const d1b = ioClient(url, { transports: ['websocket'] });
    await waitFor(d1b, 'connect');
    const rejoinStartP = waitFor(d1b, 'match:start');
    d1b.emit('match:rejoin', { sessionToken: d1Token });
    const rejoinStart = await rejoinStartP;

    log(rejoinStart.rejoined === true, 'A) Grace period alatti ujracsatlakozas match:start-ot ad vissza rejoined:true jelzessel');
    log(rejoinStart.playerNumber === d1PlayerNumber, 'A) Az ujracsatlakozott kliens ugyanazt a jatekosszamot kapja vissza', `playerNumber=${rejoinStart.playerNumber}`);
    log(rejoinStart.aiControlled === false, 'A) Grace period alatt az ujracsatlakozott oldalt meg NEM vezeti a gep', `aiControlled=${rejoinStart.aiControlled}`);

    await opponentReconnectedP;
    log(true, 'A) Az ellenfel opponent:reconnected ertesitest kapott az ujracsatlakozaskor');

    d1b.close();
    d2.close();
  }

  // ========== B+C) AI-ATVETEL: 3 kihagyott kor utan teljes kizaras ==========
  const c1 = ioClient(url, { transports: ['websocket'] });
  const c2 = ioClient(url, { transports: ['websocket'] });
  await Promise.all([waitFor(c1, 'connect'), waitFor(c2, 'connect')]);

  const c2StartP = waitFor(c2, 'match:start');
  c1.emit('queue:join', { displayName: 'Alice' });
  await waitFor(c1, 'queue:waiting');
  c2.emit('queue:join', { displayName: 'Bob' });
  const c1Start = await waitFor(c1, 'match:start');
  await c2StartP;

  const c1Updates = collectEvents(c1, 'state:update');
  const c2Updates = collectEvents(c2, 'state:update');

  log(!!c1Start.sessionToken, 'A match:start tartalmaz sessionToken-t', `token=${c1Start.sessionToken}`);
  log(c1Start.aiControlled === false && c1Start.opponentAiControlled === false, 'Meccs indulaskor egyik oldal sem AI-vezerelt');

  const c1Token = c1Start.sessionToken;
  const c1PlayerNumber = c1Start.playerNumber; // varhatoan 1 (elsokent csatlakozott)
  log(c1PlayerNumber === 1, 'C1 (elsokent csatlakozo) player1-kent indul', `playerNumber=${c1PlayerNumber}`);

  // C1 (player1) sosem lep -> minden korebeli fordulot lejar az ido. C2
  // viszont MINDIG azonnal, manualisan lep, amint sorra kerul - igy a
  // "hibazo" fel minden korben ugyanaz (player1) marad. Az elso 2 ciklusban
  // C2 vissza is lep utana (missedTurns 1 -> 2), a 3. (donto) lejaratot
  // viszont KULON, C2 valaszlepese NELKUL vizsgaljuk.
  const takeoverP = waitFor(c2, 'player:ai-takeover');
  const kickedP = waitFor(c1, 'kicked:ai-takeover');
  const c1DisconnectP = waitFor(c1, 'disconnect');

  let latestState = c1Start.state;
  for (let i = 0; i < 2; i++) {
    const timeoutUpdate = await c1Updates.next();
    if (timeoutUpdate.cause !== 'timeout' || timeoutUpdate.state.currentPlayer !== 2) {
      throw new Error(`Varatlan allapot a(z) ${i + 1}. ciklusban: cause=${timeoutUpdate.cause} currentPlayer=${timeoutUpdate.state.currentPlayer}`);
    }
    latestState = timeoutUpdate.state;
    await c2Updates.next(); // ugyanaz a broadcast c2-n is megerkezik

    const pair = findFreeAdjacentPair(latestState);
    c2.emit('move:primary', pair.primary);
    const primaryUpdate = await c2Updates.next();
    // C1 (a fuggoben levo kor "hibazo" fele) SZANDEKOSAN nem kap ertesitest
    // C2 meg le nem zart elsodleges lepeserol - csak a teljes lepespar utan.
    // (lasd server.js: 'primary'/'retract' okot csak a lepo fel sajat
    // socketje kapja meg, nem az egesz szoba.)
    await new Promise((r) => setTimeout(r, 150));
    log(c1Updates.pending() === 0, `C1 nem kap ertesitest C2 meg fuggoben levo elsodleges lepeserol (${i + 1}. ciklus)`);
    latestState = primaryUpdate.state;

    c2.emit('move:secondary', pair.secondary);
    const secondaryUpdate = await c2Updates.next();
    await c1Updates.next(); // a teljes lepespar utan C1 is megkapja a frissitest
    latestState = secondaryUpdate.state;
  }

  // 3. (donto) lejarat: itt eri el player1 a 3 kihagyott kort -> AI-atvetel
  // + teljes kizaras. Ezt a broadcastot C1 mar NEM kapja meg (idokozben
  // kikerult a szobabol), ezert csak C2-n olvassuk ki.
  const finalTimeoutUpdate = await c2Updates.next();
  if (finalTimeoutUpdate.cause !== 'timeout' || finalTimeoutUpdate.state.currentPlayer !== 2) {
    throw new Error(`Varatlan allapot a donto ciklusban: cause=${finalTimeoutUpdate.cause} currentPlayer=${finalTimeoutUpdate.state.currentPlayer}`);
  }
  latestState = finalTimeoutUpdate.state;

  const takeover = await takeoverP;
  log(takeover.playerNumber === c1PlayerNumber, 'B) 3 kihagyott kor utan a szerver AI-atvetelt jelez az ellenfelnek a hibazo jatekosra', `playerNumber=${takeover.playerNumber}`);

  const kicked = await kickedP;
  log(kicked.playerNumber === c1PlayerNumber, 'B) A hibazo jatekos (C1) sajat maga "kicked:ai-takeover" ertesitest kap', `playerNumber=${kicked.playerNumber}`);

  await c1DisconnectP;
  log(true, 'B) A szerver ezutan tenylegesen bontja is a hibazo jatekos kapcsolatat');

  // C1 megprobal ujra csatlakozni (akar aktiv jatekoskent, akar csak
  // nezokent) - ennek EL KELL BUKNIA, 'ai-took-over' hibaval.
  {
    const c1b = ioClient(url, { transports: ['websocket'] });
    await waitFor(c1b, 'connect');
    const rejoinFailedP = waitFor(c1b, 'rejoin:failed');
    c1b.emit('match:rejoin', { sessionToken: c1Token });
    const rejoinFailed = await rejoinFailedP;
    log(rejoinFailed.error === 'ai-took-over', 'B) AI-atvetel utan a rejoin MINDIG elutasitasra kerul (meg nezokent sem terhet vissza)', `error=${rejoinFailed.error}`);
    c1b.close();
  }

  // --- C) C2 (meg ember) lep - erre valaszul az AI (player1) azonnal, az
  //     ora lejarta nelkul lepjen, es a kor visszakerul C2-hoz. ---
  const freePair = findFreeAdjacentPair(latestState);
  c2.emit('move:primary', freePair.primary);
  const ownPrimaryUpdate = await c2Updates.next();
  log(ownPrimaryUpdate.cause === 'primary', 'C2 sajat elsodleges lepese visszaigazolodik', `cause=${ownPrimaryUpdate.cause}`);

  c2.emit('move:secondary', freePair.secondary);
  const ownSecondaryUpdate = await c2Updates.next();
  log(ownSecondaryUpdate.cause === 'secondary', 'C2 masodlagos lepese is visszaigazolodik', `cause=${ownSecondaryUpdate.cause}`);

  const aiAutoUpdate = await c2Updates.next();
  log(aiAutoUpdate.cause === 'ai-move', 'C) C2 lepese utan az AI (player1) azonnal, az ora lejarta nelkul lep', `cause=${aiAutoUpdate.cause}`);
  log(aiAutoUpdate.state.currentPlayer === 2, 'C) Az AI lepese utan ismet C2 (ember) kovetkezik', `currentPlayer=${aiAutoUpdate.state.currentPlayer}`);

  c2.close();
  httpServer.close();

  console.log(`\n${failures === 0 ? 'Osszes' : failures + ' HIBAS'} ellenorzes lefutott.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
