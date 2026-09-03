'use strict';

/**
 * DiPole - az uj "Online AI teszt" jatekmod szerveroldali viselkedese
 * (felhasznaloi keresre, 2026-08-31): ez egy KULON matchmaking-sorban var
 * ('ai-test', a `queue:join` `mode` mezoje alapjan - lasd server.js/
 * roomManager.js), es a belole letrejovo szoba a normal "online" modtol
 * teljesen fuggetlen beallitasokkal fut:
 *  - 60mp helyett 1mp-es korido,
 *  - 3-3 kihagyott kor utan mindket oldalt egy-egy 'hard' (nem 'easy') AI
 *    veszi at,
 *  - az atvett oldal(ak) SOSEM kerulnek kizarasra (nincs 'kicked:ai-takeover')
 *    - a szocket bennmarad a szobaban, tehat a jatekosok (mint nezok)
 *    tovabb figyelhetik a ket AI osszecsapasat egeszen a meccs vegeig,
 *  - a kihagyott-kor-szamlalo NEM fut el a vegtelenbe, miutan valakit mar
 *    atvett a gep,
 *  - ES a masik, PARHUZAMOSAN futo normal "online" sor ezzel semmilyen
 *    formaban nem keveredik (egy normal sorban varakozo kliens nem parosodik
 *    egy ai-test sorban varokoval).
 *
 * Futtatas: node test/simulate-ai-test-mode.js
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
  // A createServer-nek atadott turnSeconds/aiMoveDelayMs csak a NORMAL
  // "online" sorbol szuleto szobakra vonatkozik - az "ai-test" sor sajat,
  // beepitett (1mp/hard) beallitasait hasznalja, fuggetlenul ettol.
  const { httpServer, rooms } = createServer({ port: PORT, turnSeconds: 60, aiMoveDelayMs: 0 });
  const url = `http://localhost:${PORT}`;

  // ========== 1) A KET SOR SOSEM keveredik ==========
  const normalWaiter = ioClient(url, { transports: ['websocket'] });
  let t1 = ioClient(url, { transports: ['websocket'] });
  const t2 = ioClient(url, { transports: ['websocket'] });
  await Promise.all([waitFor(normalWaiter, 'connect'), waitFor(t1, 'connect'), waitFor(t2, 'connect')]);

  normalWaiter.emit('queue:join', { displayName: 'Normal-var', mode: 'online' });
  await waitFor(normalWaiter, 'queue:waiting');

  const t1StartP = waitFor(t1, 'match:start');
  t1.emit('queue:join', { displayName: 'Teszt-Alice', mode: 'ai-test' });
  await waitFor(t1, 'queue:waiting');
  const t2StartP = waitFor(t2, 'match:start');
  t2.emit('queue:join', { displayName: 'Teszt-Bob', mode: 'ai-test' });
  const t1Start = await t1StartP;
  const t2Start = await t2StartP;

  log(
    t1Start.mode === 'ai-test' && t2Start.mode === 'ai-test',
    'A ket "ai-test" sorban varakozo kliens EGYMASSAL parosodott, a match:start "ai-test" modot jelez',
    `t1.mode=${t1Start.mode} t2.mode=${t2Start.mode}`
  );

  // A normal sorban varakozo kliens meg mindig egyedul var - nem parosodott
  // ossze egyik "ai-test" klienssel sem.
  await sleep(200);
  log(
    rooms.waitingByMode.online && rooms.waitingByMode.online.socketId === normalWaiter.id,
    'A normal "online" sorban varakozo kliens VALTOZATLANUL egyedul var - nem keveredett ossze az "ai-test" sorral'
  );

  // Parositsuk most mar a normal-varot is egy negyedik klienssel, hogy
  // takaritsunk (ne maradjon orokre varakozo szoba-nelkuli kapcsolat).
  const normalPartner = ioClient(url, { transports: ['websocket'] });
  await waitFor(normalPartner, 'connect');
  const normalWaiterStartP = waitFor(normalWaiter, 'match:start');
  normalPartner.emit('queue:join', { displayName: 'Normal-tars', mode: 'online' });
  const normalWaiterStart = await normalWaiterStartP;
  log(
    normalWaiterStart.mode === 'online' && normalWaiterStart.state.timer === 60,
    'A normal sor tovabbra is a MEGADOTT (60mp-es) koridovel parosit, "online" modjelzessel',
    `mode=${normalWaiterStart.mode} timer=${normalWaiterStart.state.timer}`
  );
  normalWaiter.close();
  normalPartner.close();

  // ========== 2) Az "ai-test" szoba tenylegesen 1mp-es koridovel es 'hard' AI-val fut ==========
  log(t1Start.state.timer === 1, 'Az "ai-test" szoba 1mp-es koridovel indul (nem a szerver alapertelmezett 60mp-evel)', `timer=${t1Start.state.timer}`);

  // ========== 3) Egyik kliens SEM lep - mindket oldalt at kell vegye a gep, KIZARAS NELKUL ==========
  let t1Kicked = false;
  let t2Kicked = false;
  t1.on('kicked:ai-takeover', () => { t1Kicked = true; });
  t2.on('kicked:ai-takeover', () => { t2Kicked = true; });

  const t1TakeoverP = waitFor(t1, 'player:ai-takeover'); // barmelyik oldal elso atvetele - mindket kliens latja
  const t2TakeoverP = waitFor(t2, 'player:ai-takeover');
  const [firstTakeoverAtT1, firstTakeoverAtT2] = await Promise.all([t1TakeoverP, t2TakeoverP]);

  log(
    firstTakeoverAtT1.playerNumber === firstTakeoverAtT2.playerNumber,
    'Az elso AI-atvetel esemenye MINDKET klienshez eljut, ugyanazzal a jatekossal (a szoba nem hagyta el senki)',
    `t1 latta=${firstTakeoverAtT1.playerNumber} t2 latta=${firstTakeoverAtT2.playerNumber}`
  );
  log(
    firstTakeoverAtT1.aiDifficulty === 'hard',
    'Az AI-atvetel "hard" (ERŐS) nehezseget jelent, nem a normal mod alapertelmezett "easy"-jet',
    `aiDifficulty=${firstTakeoverAtT1.aiDifficulty}`
  );

  // Varjuk meg a MASODIK oldal atvetelet is - EGYIK KLIENS SEM kaphat
  // 'kicked:ai-takeover'-t kozben (ez a legfontosabb, korabban minden ilyen
  // atvetel egyben teljes kizarast is jelentett).
  const secondTakeoverP = Promise.race([waitFor(t1, 'player:ai-takeover'), waitFor(t2, 'player:ai-takeover')]);
  const secondTakeover = await secondTakeoverP;
  log(
    secondTakeover.playerNumber !== firstTakeoverAtT1.playerNumber,
    'A MASODIK oldalt is atveszi a gep (mindket fel AI-vezerelt lesz)',
    `masodik atvett jatekos=${secondTakeover.playerNumber}`
  );

  await sleep(300);
  log(
    !t1Kicked && !t2Kicked,
    'EGYIK kliens SEM kapott "kicked:ai-takeover"-t - "Online AI teszt" modban senkit nem zarunk ki, nezokent bennmaradhatnak',
    `t1Kicked=${t1Kicked} t2Kicked=${t2Kicked}`
  );

  const roomId = t1Start.roomId;
  log(
    rooms.socketToRoom.get(t1.id) === roomId && rooms.socketToRoom.get(t2.id) === roomId,
    'Mindket socket TOVABBRA is a szoba tagja (nincs eltavolitva a szocketToRoom terkepbol)'
  );

  // ========== 4) Egy MAR AI-atvett oldal is sikeresen visszacsatlakozhat ==========
  // 2026-09-03, felhasznaloi hibajelzes alapjan: a roomManager.rejoin()
  // korabban FELTETEL NELKUL elutasitotta az ujracsatlakozast, ha az adott
  // oldalt mar atvette a gep - meg "ai-test" modban is, pedig ennek a
  // modnak eppen az a lenyege, hogy a jatekosok (mar AI-vezerelt oldalkent
  // is) nezokent bennmaradhassanak es vegignezhessek a ket AI osszecsapasat.
  // A valos hiba ugy jelentkezett, hogy egy hosszu ('hard') AI-szamitas
  // idejere a szerver event loopja annyira leallt, hogy a szocket
  // szivveres-idozitese lejart -> a kliens ujracsatlakozott -> a fenti
  // (akkor meg feltetlen) elutasitas miatt "AI atvette a helyed" uzenetet
  // kapott es a meccs onnantol nezo nelkul, "befejezetlenul" maradt a
  // felhasznalo szamara. Ez a teszt EPPEN ezt a forgatokonyvet jatssza le:
  // egy mar AI-atvett t1 kapcsolat megszakad, majd egy UJ socketen
  // match:rejoin-nal visszater ugyanazzal a sessionToken-nel - ennek
  // SIKERREL kell jarnia (match:start, rejoined:true, aiControlled:true),
  // NEM szabad rejoin:failed-et kapnia.
  const t1SessionToken = t1Start.sessionToken;
  t1.close();
  await sleep(150);
  const t1Rejoined = ioClient(url, { transports: ['websocket'] });
  await waitFor(t1Rejoined, 'connect');
  const t1RejoinStartP = waitFor(t1Rejoined, 'match:start');
  const t1RejoinFailedP = waitFor(t1Rejoined, 'rejoin:failed');
  t1Rejoined.emit('match:rejoin', { sessionToken: t1SessionToken });
  const t1RejoinResult = await Promise.race([
    t1RejoinStartP.then((p) => ({ kind: 'match:start', payload: p })),
    t1RejoinFailedP.then((p) => ({ kind: 'rejoin:failed', payload: p })),
  ]);
  log(
    t1RejoinResult.kind === 'match:start' && t1RejoinResult.payload.rejoined === true && t1RejoinResult.payload.aiControlled === true,
    '"ai-test" modban egy MAR AI-atvett oldal is sikeresen visszacsatlakozhat (nem rejoin:failed-et kap)',
    JSON.stringify(t1RejoinResult)
  );
  t1 = t1Rejoined;

  // ========== 5) A kihagyott-kor-szamlalo NEM fut el a vegtelenbe ==========
  // Varjunk meg meg par kort (mindket oldal mar AI-vezerelt, 1mp-es koridoval
  // gyorsan peregnek a korok), majd ellenorizzuk a legutobbi allapotot.
  let lastMissedTurns = null;
  const missedTurnsListener = (payload) => {
    if (payload.missedTurns) lastMissedTurns = payload.missedTurns;
  };
  t1.on('state:update', missedTurnsListener);
  await sleep(4000);
  log(
    Boolean(lastMissedTurns) && lastMissedTurns[1] <= 3 && lastMissedTurns[2] <= 3,
    'A kihagyott-kor-szamlalo BEFAGY 3-nal, miutan az adott oldalt mar atvette a gep (nem no tovabb minden lejaro korrel)',
    JSON.stringify(lastMissedTurns)
  );
  t1.off('state:update', missedTurnsListener);

  // ========== 6) A meccs valoban vegigfut, ES mindket ("nezo") kliens megkapja a match:end-et ==========
  // A tenyleges idotartam valtozekony (~20-55mp mert ebben a sandboxban,
  // attol fuggoen, hany kor kell a "hard" AI-knak a partit lezarni) - 90mp-es
  // hataridovel szamolunk, hogy ne legyen indokolatlanul flaky a teszt.
  const t1EndP = waitFor(t1, 'match:end');
  const t2EndP = waitFor(t2, 'match:end');
  const deadline = sleep(90000).then(() => null);
  const [t1End] = await Promise.race([Promise.all([t1EndP, t2EndP]), deadline.then(() => [null])]);

  log(
    Boolean(t1End) && (t1End.status === 'won' || t1End.status === 'draw'),
    'A ket "hard" AI VEGIGJATSSZA a partit - mindket (nezokent bennmaradt) kliens megkapja a match:end-et',
    JSON.stringify(t1End)
  );

  await sleep(150);
  log(!rooms.rooms.has(roomId), 'A meccs veget erese utan a szoba takaritva lett (nincs memoriaszivargas ebben a modban sem)');

  t1.close();
  t2.close();
  httpServer.close();

  console.log(`\n${failures === 0 ? 'Osszes' : failures + ' HIBAS'} ellenorzes lefutott.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
