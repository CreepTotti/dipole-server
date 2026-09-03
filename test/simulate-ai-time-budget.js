'use strict';

/**
 * DiPole - az AI idokeret-vedelmenek (deadline) kozvetlen tesztje.
 *
 * 2026-09-03, felhasznaloi hibajelzes alapjan ("Online AI teszt" modban 2
 * meccs is megszakadt, egyszer "AI atvette a helyed" uzenettel, egyszer
 * befejezetlenul): a diagnozis szerint egy hosszan elhuzodo, kiegyenlitett
 * AI-AI osszecsapasban a "hard" nehezsegu chooseAiMove (negamax-lookahead +
 * fenyegetes-lanc-kereses) alkalmankent tobb masodpercig is szamolhatott
 * SZINKRON modon, ami az egyetlen Node-szal miatt az EGESZ szervert
 * blokkolta - ez okozott latszolagos, minden klienst erinto
 * kapcsolat-vesztest (szivveres-idotullepes).
 *
 * Ez a teszt KOZVETLENUL, socket/szerver nelkul hivja a chooseAiMove-ot egy
 * kozepjatszmai allason, es ellenorzi:
 *  1) hogy egy patologikusan rovid `timeBudgetMs` (1ms) mellett a fuggveny
 *     GYORSAN visszater (nem akad be a teljes melysegu keresesbe), ES meg
 *     mindig egy STRUKTURALISAN ERVENYES lepespart ad vissza (a hatarido nem
 *     teszi "None"-a a dontest, csak sekelyebbe/heurisztikusabba),
 *  2) hogy az ALAPERTELMEZETT idokeret melletti hivas is a dokumentalt
 *     vedelmi hatarido (DEFAULT_TIME_BUDGET_MS=2500ms) alatt/korul marad,
 *     bosseges (de veges) tureshatarral, tehat a vedelem tenylegesen korlat
 *     a szamitasi idore.
 *
 * Futtatas: node test/simulate-ai-time-budget.js
 */

const assert = require('assert');
const engine = require('../src/engine/board');
const ai = require('../src/ai/ai');

let failures = 0;
function log(ok, label, extra) {
  console.log((ok ? 'OK  ' : 'FAIL') + ' - ' + label + (extra ? ' :: ' + extra : ''));
  if (!ok) failures++;
}

function isValidChosenPair(state, mover, chosen) {
  if (!chosen || !chosen.primary || !chosen.secondary) return false;
  const sim = ai.cloneState(state);
  const res = ai.applyPair(sim, mover, chosen.primary, chosen.secondary);
  return res.ok === true;
}

function playOutRandomly(seedRng, targetHalfMoves) {
  const state = engine.createGameState();
  let halfMoves = 0;
  while (state.status === 'playing' && halfMoves < targetHalfMoves) {
    const result = engine.handleTimeout(state, seedRng);
    if (!result.ok) break; // (elvileg nem fordulhat elo ily korai allasban)
    halfMoves++;
  }
  return { state, halfMoves };
}

function buildMidGameState(rng) {
  // ~30 felig-lepes (fel-lepes = egyetlen placePrimary VAGY placeSecondary
  // hivas) automatikus, veletlenszeru vegrehajtasa a handleTimeout()
  // segitsegevel, hogy egy realisztikus, mar sok kovel teli kozepjatszmai
  // allashoz jussunk (nem ures tabla, ahol a kereses trivialisan gyors
  // lenne amugy is). A teljesen veletlen jatek gyakran korabban (nyeressel)
  // veget er, mielott a celzott felig-lepes-szamot elerne - ilyenkor egy UJ
  // (kovetkezo rng-allapotbol inditott) probalkozassal probalkozunk ujra,
  // amig nem talalunk egy, a celzott hosszon meg 'playing' allapotban levo
  // partit (a fenti empirikus merese szerint ez tobbnyire nehany
  // probalkozason belul sikerul).
  const TARGET_HALF_MOVES = 30;
  const MAX_ATTEMPTS = 60;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { state, halfMoves } = playOutRandomly(rng, TARGET_HALF_MOVES);
    if (state.status === 'playing' && halfMoves === TARGET_HALF_MOVES) {
      return { state, halfMoves, attempts: attempt + 1 };
    }
  }
  // Vegso visszaeses (nagyon valoszinutlen ennyi probalkozas utan): adjuk
  // vissza az utolso probalkozas eredmenyet, barmi is legyen az allapota -
  // a hivo fel ekkor jelzi, hogy az elokeszites nem sikerult.
  const fallback = playOutRandomly(rng, TARGET_HALF_MOVES);
  return { state: fallback.state, halfMoves: fallback.halfMoves, attempts: MAX_ATTEMPTS + 1 };
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const rng = mulberry32(20260903);
  const { state, halfMoves } = buildMidGameState(rng);
  log(
    state.status === 'playing' && halfMoves > 0,
    'Sikerult egy jatszasban levo, kozepjatszmai allast eloallitani a teszthez',
    `halfMoves=${halfMoves} status=${state.status}`
  );
  if (state.status !== 'playing') {
    console.log('\nA teszt-allas elokeszitese nem sikerult - a tobbi ellenorzes kihagyva.');
    process.exit(1);
  }

  const mover = state.currentPlayer;

  // ========== 1) Patologikusan rovid hatarido (1ms): gyors visszateres, DE meg mindig ervenyes lepes ==========
  const shortState = ai.cloneState(state);
  const t0 = Date.now();
  const shortChoice = ai.chooseAiMove(shortState, { difficulty: 'hard', rng, timeBudgetMs: 1 });
  const shortElapsedMs = Date.now() - t0;

  log(
    shortElapsedMs < 500,
    'timeBudgetMs=1 mellett a chooseAiMove GYORSAN (a teljes melysegu keresest megszakitva) visszater',
    `elapsedMs=${shortElapsedMs}`
  );
  log(
    isValidChosenPair(state, mover, shortChoice),
    'timeBudgetMs=1 mellett is STRUKTURALISAN ERVENYES lepespart ad vissza (nem null, nem illegalis lepes)',
    JSON.stringify(shortChoice)
  );

  // ========== 2) Alapertelmezett idokeret: a dokumentalt vedelmi hatarido korul/alatt marad ==========
  // A DEFAULT_TIME_BUDGET_MS erteket (2500ms) nem exportalja a modul - itt
  // csak azt ellenorizzuk, hogy a hivas veges idon (a doksi szerinti
  // hatarido + bosseges, ~2mp-es tureshatar - lassabb/terhelt gepen/CI-n is
  // biztosan atfer) belul, ERVENYES lepessel ter vissza "hard" szinten,
  // tehat a vedelem tenylegesen aktivan korlatozza a szamitasi idot,
  // ahelyett hogy a vegtelensegig (vagy csak "nagyon sokaig") futna.
  const defaultState = ai.cloneState(state);
  const t1 = Date.now();
  const defaultChoice = ai.chooseAiMove(defaultState, { difficulty: 'hard', rng });
  const defaultElapsedMs = Date.now() - t1;

  log(
    defaultElapsedMs < 4500,
    'Az alapertelmezett idokeret melletti "hard" dontes VEGES idon (a 2500ms-es vedelmi hatarido + bosseges tures) belul lezajlik',
    `elapsedMs=${defaultElapsedMs}`
  );
  log(
    isValidChosenPair(state, mover, defaultChoice),
    'Az alapertelmezett idokeret melletti dontes is STRUKTURALISAN ERVENYES lepespart ad vissza',
    JSON.stringify(defaultChoice)
  );

  // ========== 3) A hatarido NEM valtoztatja meg a hivas alapveto szerzodeset (jatszasban levo allasra sosem null) ==========
  assert.ok(shortChoice !== null, 'timeBudgetMs=1 mellett sem szabadna null-t adnia jatszasban levo allasra');
  assert.ok(defaultChoice !== null, 'alapertelmezett idokeret mellett sem szabadna null-t adnia jatszasban levo allasra');
  log(true, 'Egyik hivas sem adott null-t egy meg jatszasban levo allasra (a hatarido lejarta sosem "nincs lepes"-t eredmenyez)');

  console.log(`\n${failures === 0 ? 'Osszes' : failures + ' HIBAS'} ellenorzes lefutott.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
