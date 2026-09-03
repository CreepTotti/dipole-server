'use strict';

/**
 * DiPole AI modul - a projekt-osszesito "4. AI modul" fejezete alapjan, de
 * egyszerusitett/implementalhato formaban (lasd megjegyzesek lent az egyes
 * elteresekrol).
 *
 * Szandekosan RN-fuggetlen (sima JS), hogy node:test-tel tesztelheto legyen,
 * ugyanugy mint az engine/board.js es a viewport/viewport.js.
 *
 * ELTERESEK A SPEC-TOL (dokumentalva, mert a spec pszeudokod-szintu volt):
 * - A spec kulon tombokkel dolgozik (borderCells, aiCellMap, extendedBorderCells,
 *   minimaxMap). Mi ugyanezt a hatast egyszerubb, fuggveny-alapu formaban erjuk
 *   el (getBorderCells, evaluateBestPairsForMover), mert a celkituzes (jo lepest
 *   valaszto AI, konfiguralhato nehezseggel) igy is teljesul, es igy egyszerubb
 *   tesztelni/karbantartani.
 * - A "checkLine" pontertekeles a spec tablazata szerinti (count/gaps/openEnds),
 *   DE mivel az engine/board.js checkLine-ja szandekosan nem tamogat gap-et
 *   (lasd ott a modul-fejlec 3. megjegyzeset), az AI sajat, gap-tolerans
 *   scanLineForScoring fuggvenyt hasznal - ez KULON logika, nem befolyasolja a
 *   jatek tenyleges gyozelmi szabalyat.
 * - A "Random x2 szorzo" a felhasznalovel utolag pontositott szabaly szerint
 *   MUKODIK (2026-08-28): dontesenkent (egy chooseAiMove hivas = egy dontes)
 *   VELETLENUL kivalasztunk EGY komponenst (A/B/C/D valamelyiket) a
 *   nehezsegnek megfelelo halmazbol, es annak a szorzojat 2-re allitjuk (a
 *   tobbi marad 1) - lasd pickRandomWeights(). Konnyű szinten a celpont
 *   barmelyik a negy komponens kozul lehet, kozepes es nehez szinten viszont
 *   KIZAROLAG A vagy B (tehat a masodlagos lepes C/D "onkarositas"
 *   buntetesei nem kapnak veletlen dupla sulyt magasabb szinteken - ez
 *   tudatosan hagyja, hogy nehez szinten a veletlenszeruseg csak az
 *   offenziva/defenziva (A/B) aranyat mozgassa, ne a masodlagos lepes
 *   mellekhatas-ertekeleset). A korabbi, ITT korabban hasznalt egyetlen
 *   folytonos "jitter"-szorzo (a vegso ertekre alkalmazva) NEM spec-hu volt,
 *   es idovel kiderult, hogy tul "puha"/kiszamithato tavolsagot adott a
 *   nehez szintnek - ezert lecserelodott erre a pontos komponens-alapu
 *   valtozatra.
 * - A minimax "teljes kor" melyseget lepespar-szintu ply-kent ertelmezzuk
 *   (1 ply = egy jatekos egy teljes lepespaja), negamax + alfa-beta metszessel.
 */

const {
  BOARD_SIZE,
  PLAYER_SYMBOLS,
  checkLine,
  neighborsOf,
  getValidPrimary,
  getValidSecondary,
  placePrimary,
  placeSecondary,
} = require('../engine/board');

const WIN_SCORE = 10000000;

// 2026-09-03 (felhasznaloi hibajelzes alapjan, "Online AI teszt" modban
// eszlelt szerver-lefagyas/kapcsolat-megszakadas): a szerver EGYETLEN
// Node-folyamatban, EGY szalon fut - ha egy chooseAiMove hivas (kulonosen
// "hard" szinten, mely negamax-lookahead + fenyegetes-lanc kereses) tul
// sokaig szamol szinkron modon, az BLOKKOLJA az egesz szervert (minden
// szoba, minden kapcsolat socket.io szivveres-kezelese is befagy erre az
// idore). Egy hosszan elhuzodo, kiegyenlitett AI-AI osszecsapasban (sok
// korrel, sok mar lerakott koveel a tablan, senki nem hibazik ki egy
// gyors gyozelmet) ez a szamitasi koltseg alkalmankent tobb masodpercre is
// felszokhet - ez mar meghaladhatja a kliensek szivveres-turelmet, es
// lathato ("a szerver megszakadt") kapcsolat-vesztest okoz MINDEN
// csatlakozott klliensnek, nem csak az erintett szobaban.
// Ez a vedelmi hatarido (wall-clock deadline, NEM csomopont-szamlalo, mint
// a mar meglevo `nodeBudget`) biztositja, hogy egyetlen dontes se tarthasson
// ennel tovabb - ha lejar, a mely kereses (negamax es findForcedWin egyarant)
// egyszeruen leall, es a mar addig ismert legjobb heurisztikus becslesre esik
// vissza, ahelyett hogy a vegtelensegig (vagy csak nagyon sokaig) szamolna.
// Az ertek jóval a dokumentalt tipikus koltseg (~450-860ms "hard" negamax)
// folott van, hogy normal/tipikus allasokon (es egy kicsit lassabb, terhelt
// gepen/CI-n) SOHA ne aktivalodjon - kizarolag a valodi, patologikus
// szelsoertekeket vagja el. Lasd chooseAiMove, negamax, findForcedWin.
const DEFAULT_TIME_BUDGET_MS = 2500;

// A spec "Pontertekelesi tablazata" (checkLine eredmenye alapjan).
// Kulcs: `${count}|${gaps}|${openEnds}`
const SCORE_TABLE = {
  '5|0|0': WIN_SCORE, // mar nyero sor (biztonsagi halo, checkVictory ala kene, hogy elkapja elobb)
  '4|0|2': 100000,
  '4|0|1': 90000,
  '3|0|2': 10000,
  '3|1|2': 8000,
  '3|0|1': 3000,
  '3|1|1': 2000,
  '2|0|2': 1000,
  '2|1|2': 900,
  '2|0|1': 100,
  '3|2|2': 50,
  '1|0|2': 10,
};

/**
 * Tablazatban nem szereplo (count,gaps,openEnds) kombinaciora egy folytonos,
 * de a tablazat szellemevel konzisztens becslest ad (minel nagyobb a count es
 * az openEnds, es minel kevesebb a gaps, annal magasabb).
 */
function estimateScore(count, gaps, openEnds) {
  // FONTOS: csak a SZIGORUAN egybefuggo (gaps===0) 5-os+ sor szamit tenyleges
  // gyozelemnek (lasd engine/board.js checkLine - a valodi checkVictory is
  // csak gaps=0-t fogad el). Egy "reses otos" (pl. X_XXXX) MEG NEM nyert
  // allapot, csak nagyon eros - kulon, alacsonyabb szinten kell ertekelni,
  // kulonben az AI tevesen mar lezartnak hinne a jatekot egy meg hianyos soron.
  //
  // 2026-08-28 javitas: nem csak a count>=5 sorokra igaz ez! Egy "lyukas negyes"
  // (pl. X_XX, count=4,gaps=1) IS pontosan egy lepesre van egy VALODI (gaps=0)
  // 5-os lezarasatol - tehat ugyanolyan surgos fenyegetes/lehetoseg, mint egy
  // reses otos, csak eggyel "kisebb" alapon. A felhasznalo altal jelzett hiba:
  // az AI figyelmen kivul hagyott egy ilyen lyukas, nyitott negyest, mert a
  // regi kod ezt csak az altalanos exponencialis becslovel ertekelte (~106
  // pont), holott 95000 korulinek kellett volna lennie.
  // A `count>=4 && gaps<=1 && (count+gaps)>=5` felteteltel PONTOSAN azokat a
  // mintakat kapjuk el, amik egyetlen (gaps=1 eseten) tovabbi mezovel valodi
  // 5-os gyozelemme valnanak - a `count>=4` also korlat szandekos, hogy a
  // gyengebb, kulon-kulon blokkolhato mintak (pl. tablazatban mar kulon,
  // alacsony ertekre rogzitett '3|2|2':50) ne emelkedjenek tevesen ide.
  if (count >= 4 && gaps <= 1 && count + gaps >= 5) {
    return gaps === 0 ? WIN_SCORE : 95000;
  }
  if (count >= 5) {
    return 40000; // >=2 reses, meg tavoli "otos"-jelolt - tovabbra is figyelemre melto, de nem surgos
  }
  const base = Math.pow(count, 3) * (openEnds + 1);
  const gapPenalty = Math.pow(0.55, gaps);
  return Math.round(base * gapPenalty);
}

function scoreLineResult(count, gaps, openEnds) {
  const exact = SCORE_TABLE[`${count}|${gaps}|${openEnds}`];
  if (exact !== undefined) return exact;
  return estimateScore(count, gaps, openEnds);
}

function inBounds(size, row, col) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

const AXES = [
  { dirs: [[0, 1], [0, -1]] },
  { dirs: [[1, 0], [-1, 0]] },
  { dirs: [[1, 1], [-1, -1]] },
  { dirs: [[1, -1], [-1, 1]] },
];

const MAX_GAPS_TOTAL = 2;

/**
 * Gap-tolerans iranyszkennelo: `symbol`-lal egybefuggo (max `maxGaps` db 1-mezos
 * lyukkal athidalt) szakaszt mer fel egy iranyban `pos`-tol. A vegen levo,
 * "nem igazolt" (tovabbi szimbolum altal meg nem indokolt) lyukakat az
 * openEnd-be forditjuk vissza, hogy ne szamoljunk elhamarkodott lyukat.
 */
function scanDirection(board, size, row, col, dr, dc, symbol, maxGaps) {
  let count = 0;
  let gapsUsed = 0;
  let trailingGaps = 0;
  let openEnd = false;
  let step = 1;

  while (true) {
    const r = row + dr * step;
    const c = col + dc * step;
    if (!inBounds(size, r, c)) break; // fal -> zart veg
    const cell = board[r][c];
    if (cell.state === symbol) {
      count++;
      trailingGaps = 0;
      step++;
      continue;
    }
    if (cell.state === 'empty') {
      if (gapsUsed < maxGaps) {
        gapsUsed++;
        trailingGaps++;
        step++;
        continue;
      }
      openEnd = true;
      break;
    }
    break; // ellenfel jel vagy inaktiv -> zart veg
  }

  if (trailingGaps > 0) {
    gapsUsed -= trailingGaps;
    openEnd = true;
  }
  return { count, gapsUsed, openEnd };
}

/**
 * Egy tengely (2 irany) menten `pos` korul meri a `symbol` sor erosseget,
 * MINTHA `pos`-on mar `symbol` allna (a hivo dolga eldonteni, hogy ez egy
 * mar lerakott jelre vagy egy hipotetikus/jelolt mezore vonatkozik-e).
 */
function scoreAxisAt(board, size, pos, axisDirs, symbol) {
  const [[dr1, dc1], [dr2, dc2]] = axisDirs;
  const a = scanDirection(board, size, pos.row, pos.col, dr1, dc1, symbol, MAX_GAPS_TOTAL);
  const b = scanDirection(board, size, pos.row, pos.col, dr2, dc2, symbol, MAX_GAPS_TOTAL - a.gapsUsed);
  const count = 1 + a.count + b.count;
  const gaps = a.gapsUsed + b.gapsUsed;
  const openEnds = (a.openEnd ? 1 : 0) + (b.openEnd ? 1 : 0);
  return { count, gaps, openEnds };
}

/**
 * `pos` erteke `symbol` szempontjabol, HA ott `symbol` allna - a 4 tengely
 * legjobb (legmagasabb pontszamu) sorat veve (nem osszegezve, mert egy mezo
 * egyszerre tobb tengelyen is resze lehet egy mar eros sornak, es a
 * legerosebb fenyegetes/lehetoseg a mervado).
 */
function cellAxisScores(board, size, pos, symbol) {
  return AXES.map((axis) => {
    const { count, gaps, openEnds } = scoreAxisAt(board, size, pos, axis.dirs, symbol);
    return scoreLineResult(count, gaps, openEnds);
  });
}

function cellValueFor(board, size, pos, symbol) {
  const scores = cellAxisScores(board, size, pos, symbol);
  let best = 0;
  for (const s of scores) if (s > best) best = s;
  return best;
}

// 2026-08-28 javitas (negyedik kor - "villa-figyeles"): Totti tobb vesztes
// nehez-AI parti exportjat elemezve (lasd a "Parti mentese elemzeshez"
// funkciot) kiderult, hogy MINDEGYIK vereseg ugyanarra a jelensegre vezetheto
// vissza: az ellenfel 2 (vagy tobb) FUGGETLEN tengely-iranyban (sor/oszlop/2
// atlo) egyszerre epit fel legalabb "eleven" (nyitott ketes vagy erosebb)
// vonalat, es az AI - mivel egy koreben csak EGY elsodleges mezot rakhat le -
// szerkezetileg csak az egyiket tudja kezelni. A masik 1-2 korrel kesobb mar
// vedhetetlen nyitott negyesse erik. Ez a klasszikus Gomoku "dupla harmas"/
// villa-jelenseg.
// Ennek felismerese NEM igenyel plusz keresest: a cellValueFor amugy is
// kiszamolja mind a 4 tengely erteket, csak eddig a legerosebbet leszamitva
// eldobtuk a tobbit. A `FORK_WATCH_THRESHOLD` annal jóval alacsonyabb, mint a
// "harmas szintu" MANDATORY_DEFENSE_THRESHOLD - szandekosan: a cel, hogy MAR
// a masodik vonal "eleven ketes" (score>=800, lasd SCORE_TABLE '2|1|2':900,
// '2|0|2':1000) fazisaban eszrevegyuk a tobb-frontos veszelyt, meg mielott
// barmelyik vonal onmagaban surgosse valna - lasd a reszletes elemzest a
// projekt-jegyzetekben (4 exportalt vesztes parti, mindegyiknel ugyanez a
// mintazat volt kimutathato tengelyenkenti bontassal).
const FORK_WATCH_THRESHOLD = 800;

// 2026-08-29 javitas ("konvergencia-pont" hiba): Totti egy TOVABBI vesztes
// nehez-AI partit ("game9") elemezve talalt egy harmadik, a fentiektol
// KULONBOZO gyengeseget - ez nem egy bizonyitasi (soundness) hiba, hanem a
// jeloltertekeles egyik vakfoltja. A `cellValueFor` SZANDEKOSAN a 4 tengely
// KOZUL A LEGEROSEBBET veszi (lasd ott a dokumentaciot) - ez helyes es
// szukseges ALTALABAN, DE van egy specialis eset, amit emiatt nem lat: ha
// egy KONKRET (meg ures) mezo egyszerre KET FUGGETLEN ellenfel-vonalnak IS
// resze (pl. egy sor ES egy oszlop metszespontja, ahol mindket iranyban mar
// "eleven ketes" all), akkor ANNAK a mezonek az elfoglalasa (barmelyik fel
// reszerol) EGYSZERRE semlegesiti/epiti mindket vonalat - ez sokkal tobbet
// er, mint egy tisztan egytengelyu mezo, MEG AKKOR IS, ha a sima (max-alapu)
// cellValueFor ertekuk veletlenul egyenlo. A game9-ben pontosan ez tortent:
// az AI sajat korabbi (a masodlagos-valasztas soran mar elore nem lathato)
// lepesei ES az ellenfel kesobbi lepesei egyutt ket, egy KOZOS mezon (9,12)
// athalado nyitott ketest hoztak letre - az AI ezt a kozos mezot ugyanolyan
// erteku "sima" blokknak latta, mint egy tavolabbi, csak EGY vonalat erinto
// mezot, es vegul MASHOVA lepett - a ket vonal ezutan egymastol fuggetlenul
// nyitott harmassa, majd vedhetetlen nyitott negyesse erett.
// Javitas: CSAK a blokkolasi (B) ertekeleshez bevezetunk egy kulon
// `cellBlockValue` fuggvenyt, ami - a `cellValueFor`-tol elteroen - eszreveszi,
// ha egy mezon KET tengelyen is legalabb FORK_WATCH_THRESHOLD szintu az
// ellenfel vonala, es ilyenkor a ket legerosebb tengely OSSZEGET adja vissza
// (a sima maximum helyett). A `cellValueFor`-t magat SZANDEKOSAN nem
// modositjuk (azt tovabbra is minden mas hasznalata - sajat ajanlat 'a',
// masodlagos-valasztas 'c'/'d', findWinCompletions, findForcedWin - a regi,
// jol tesztelt max-alapu logikaval hasznalja), igy ez a javitas KIZAROLAG az
// evaluateBestPairsForMover 'b' (blokkolasi) komponensere hat.
function cellBlockValue(board, size, pos, symbol) {
  const scores = cellAxisScores(board, size, pos, symbol).slice().sort((x, y) => y - x);
  const top = scores[0];
  if (top >= WIN_SCORE) return top; // mar ugyis nyero/nyero-megelozo - a bonusznak itt nincs ertelme
  const second = scores[1];
  if (second >= FORK_WATCH_THRESHOLD) {
    return top + second; // "konvergencia-bonusz": ez a mezo KET vonalat blokkolna egyszerre
  }
  return top;
}

/**
 * Tengelyironyonkenti (0=vizszintes,1=fuggoleges,2=\,3=/) globalis maximum
 * `symbol`-ra, a TABLAN MAR TENYLEGESEN ALLO `symbol`-mezok alapjan (NEM
 * hipotetikus/ures jelolt-cellak!). FONTOS: ha ures jelolt-cellakon hivnank
 * meg a cellAxisScores-t, ABBAN MINDIG szerepelne egy +1 a hipotetikus
 * mezoert - emiatt egy teljesen magányos, egyetlen mar lerakott `symbol`-ko
 * is trivialisan "ketest" (score=1000/900) mutatna barmelyik szomszedos ures
 * mezorol nezve MINDEN tengelyen, holott ez nem valodi, fuggetlen
 * fenyegetes, csak a szamitas mellekhatasa (2026-08-28: ez okozott egy
 * regresszios teszthibat az elso implementacios probalkozasnal - lasd
 * test/ai.test.js "duplazott A sullyal..." teszt). A tenyleges mar lerakott
 * kovekre valo szukites ezt kikuszoboli: egy magányos ko csak a SAJAT
 * tengelyen (amin mas azonos szimbolumu koveket talal) ad valodi ertéket, a
 * tobbi (rajta at haladó, de ures korulotte) tengelyen alacsony (~1-10)
 * marad.
 */
function opponentOrientationDanger(board, size, symbol) {
  const best = [0, 0, 0, 0];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c].state !== symbol) continue;
      const scores = cellAxisScores(board, size, { row: r, col: c }, symbol);
      for (let i = 0; i < scores.length; i++) {
        if (scores[i] > best[i]) best[i] = scores[i];
      }
    }
  }
  return best;
}

/**
 * "Perem" (border) cellak: ures mezok, amelyeknek van legalabb egy nem-ures
 * szomszedja `radius` tavolsagon belul. Ures tabla eseten a kozeppontot adja
 * vissza. Ez a jelolt-lista, amit a minimax/pontozas tovabb szukit (Top N).
 */
function getBorderCells(state, radius = 1) {
  if (state.history.length === 0) {
    const mid = Math.floor(state.size / 2);
    return [{ row: mid, col: mid }];
  }

  const seen = new Set();
  const result = [];
  for (let r = 0; r < state.size; r++) {
    for (let c = 0; c < state.size; c++) {
      if (state.board[r][c].state === 'empty') continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (!inBounds(state.size, nr, nc)) continue;
          if (state.board[nr][nc].state !== 'empty') continue;
          const k = `${nr},${nc}`;
          if (seen.has(k)) continue;
          seen.add(k);
          result.push({ row: nr, col: nc });
        }
      }
    }
  }
  return result;
}

function otherPlayer(player) {
  return player === 1 ? 2 : 1;
}

function cloneState(state) {
  return {
    ...state,
    board: state.board.map((row) => row.map((f) => ({ ...f }))),
    validSecondary: state.validSecondary.map((p) => ({ ...p })),
    primaryPos: state.primaryPos ? { ...state.primaryPos } : null,
    lastMove: state.lastMove
      ? { ...state.lastMove, primary: { ...state.lastMove.primary }, secondary: { ...state.lastMove.secondary } }
      : null,
    history: state.history.map((h) => ({ ...h, primary: { ...h.primary }, secondary: { ...h.secondary } })),
  };
}

/**
 * Egy `mover` jatekos szamara ertekeli az osszes ervenyes lepespar-jeloltet
 * (primary a `primaryCandidates`-bol, hozza a legjobb masodlagos szomszed),
 * es csokkeno pontszam szerint rendezve adja vissza (lasd spec "aiCellMap"
 * es "4 ertekelesi komponens" - A/B a primary, C/D a (kenyszeru) secondary
 * hatasat merik).
 */
// Teljesitmeny-korlat: a draga (masodlagos-kereso, C/D-t is szamolo) ertekeles
// csak az olcso A+B alapjan legjobbnak tuno jeloltekre fut le, hogy sok
// perem-cella eseten (kesobbi jatekfazis) se robbanjon fel a szamitasi ido.
const EXPENSIVE_EVAL_LIMIT = 24;

// 2026-08-28 javitas (masodik kor): a "Random x2 szorzo" NEM alkalmazhato
// valtozatlanul egy mar WIN_SCORE-magassagu (tenyleges nyero/nyero-megelozo)
// ertekre! Ha pl. egy blokkolando cella b-erteke mar maga WIN_SCORE (mert az
// ellenfel epp ezzel a mezovel zarna le a jatekot), es a veletlen eppen B-t
// duplazza, akkor b*2 = 20 000 000 > WIN_SCORE(10 000 000) - ez ATTORI a
// negamax +-WIN_SCORE terminal-ertekeivel valo osszehasonlithatosagot: egy
// olyan lepesag, ami utan a jatekos TENYLEGESEN veszit, a kivonasos
// visszaterjesztes soran megis nagyobb vegertéket kaphat, mint egy valodi
// gyozelem, pusztan mert a köztes heurisztika szamszeruen a WIN_SCORE fole
// duzzadt. (Felhasznaloi hibajelzes: a nehez AI egy ket vegen nyitott
// harmast nem kozvetlenul zart le, hanem egy "kihagyos" mezot valasztott,
// ami vedhetetlen nyitott negyeshez vezetett - a nyomkovetes ezt a
// tulszorzast azonositotta okkent.)
// Megoldas: a WIN_SCORE-t elero (vagy azt meghalado) komponens-ertekek
// ABSZOLUT ertekek - nem stiluskerdes, nem skalazando a veletlen/nehezsegi
// sullyal -, ezert azokat valtozatlanul hagyjuk, csak az ez ALATTI ertekeket
// szorozzuk a megfelelo sullyal.
// 2026-08-28 javitas (harmadik kor): a felhasznalo visszajelzese szerint meg
// a WIN_SCORE-tulcsordulas javitasa (lasd lent) UTAN is elofordult, hogy a
// nehez AI nem a nyitott/lyukas harmas (_XXX_ tipusu) KOZVETLEN lezarasat
// valasztotta, hanem egy masik, veletlenul megduplazott komponens altal
// felertekelt, gyengebb lepest reszesitett elonyben. A felhasznalo kifejezett
// kerese: a nyitott/lyukas harmas VEDEKEZESE legyen MINDIG elsodleges
// prioritas, MINDEN nehezsegi szinten - a mar meglevo A/B/C/D veletlen x2
// szorzas csak EZ ALATT (tehat a harmas-szintnel gyengebb mintak kozotti
// dontesnel) ervenyesuljon.
//
// Megvalositas: a B (blokkolas/vedekezes erteke) komponens, ha mar legalabb
// "harmas-szintu" fenyegetest jelent (lasd SCORE_TABLE: a leggyengebb ilyen
// '3|1|1'=2000 - a meg ennel is gyengebb, szandekosan alacsony erteku
// ketszeresen-lyukas harmas, '3|2|2'=50, NEM szamit ide), garantaltan
// legalabb 2x sullyal szamit - DE CSAK AKKOR, ha a mozgatonak (mover) NINCS
// SEHOL a tablan mar most is legalabb ugyanilyen szintu SAJAT ajanlata (lasd
// `hasComparableOwnOffense` lent)! Ez a felteteles korlatozas kulcsfontossagu:
// ha felteteltelenul mindig floorolnank B-t, azzal egy MEG SULYOSABB hibat
// vezetnenk be, es szetrombolnank egy MAR MEGLEVO, szandekosan tesztelt
// viselkedest (lasd test/ai.test.js "duplazott A/B" teszt): ha az AI-nak MAR
// VAN egy ugyanolyan sulyu SAJAT fenyegetese/lehetosege (pl. egy mar meglevo
// nyitott harmasa, amit negyesse zarhatna - ami surgosebb es gyorsabb
// gyozelmi ut, mint egy masik harmas blokkolasa!), akkor a szandekos A/B
// veletlen valasztasnak KELL eldontenie, melyik domináljon - ez pontosan a
// "Random x2 celzas" eredeti celja. A feltetel nelkuli (minden komponensre
// vagy csak B-re felteteltelenul alkalmazott) floor mindket esetben
// sajat tesztekkel igazoltan hibas eredmenyt adott, mielott erre a
// felteteles valtozatra all tunk.
const MANDATORY_DEFENSE_THRESHOLD = 2000; // a leggyengebb "harmas-szintu" pontszam (lasd '3|1|1')
const MANDATORY_DEFENSE_FLOOR = 2;

// 2026-08-28 javitas (masodik kor): a "Random x2 szorzo" NEM alkalmazhato
// valtozatlanul egy mar WIN_SCORE-magassagu (tenyleges nyero/nyero-megelozo)
// ertekre! Ha pl. egy blokkolando cella b-erteke mar maga WIN_SCORE (mert az
// ellenfel epp ezzel a mezovel zarna le a jatekot), es a veletlen eppen ezt
// duplazza, akkor 2xWIN_SCORE > WIN_SCORE - ez ATTORI a negamax +-WIN_SCORE
// terminal-ertekeivel valo osszehasonlithatosagot. Ezert a WIN_SCORE-t elero
// (vagy azt meghalado) ertekek ABSZOLUTAK - nem stiluskerdes, nem skalazando
// semmilyen sullyal.
function weighted(value, weight) {
  if (value >= WIN_SCORE) return value;
  return value * weight;
}

// Csak a B (blokkolo) komponensre alkalmazando, a fenti vedelmi minimummal
// kiegeszitve - lasd a `MANDATORY_DEFENSE_THRESHOLD` fenti magyarazatat.
function weightedBlockValue(value, weight, hasComparableOwnOffense) {
  if (value >= WIN_SCORE) return value;
  if (!hasComparableOwnOffense && value >= MANDATORY_DEFENSE_THRESHOLD) {
    return value * Math.max(weight, MANDATORY_DEFENSE_FLOOR);
  }
  return value * weight;
}

function evaluateBestPairsForMover(state, mover, primaryCandidates, weights) {
  const mySymbols = PLAYER_SYMBOLS[mover]; // { primary, secondary }
  const oppSymbols = PLAYER_SYMBOLS[otherPlayer(mover)];

  const cheapScored = [];
  for (const primary of primaryCandidates) {
    if (state.board[primary.row][primary.col].state !== 'empty') continue;
    const a = cellValueFor(state.board, state.size, primary, mySymbols.primary);
    // Lasd a fenti "konvergencia-pont" javitas magyarazata: a blokkolasi (b)
    // ertekeles kulon `cellBlockValue`-t hasznal, ami eszreveszi, ha ez a mezo
    // KET fuggetlen ellenfel-vonalat blokkolna egyszerre - a sajat ajanlat
    // (a) es a masodlagos-valasztas (c/d) tovabbra is a sima cellValueFor-t
    // hasznalja, valtozatlanul.
    const b = cellBlockValue(state.board, state.size, primary, oppSymbols.primary);
    cheapScored.push({ primary, a, b });
  }
  // "Villa-figyeles" (lasd FORK_WATCH_THRESHOLD es opponentOrientationDanger
  // fenti magyarazata): a MAR TENYLEGESEN a tablan allo ellenfel-kovek
  // alapjan (nem a jelolt-cellakbol!) allapitjuk meg, hany KULONBOZO
  // tengely-iranyban van legalabb FORK_WATCH_THRESHOLD szintu elo vonala -
  // ha 2 vagy tobb, az mar tobb-frontos veszelyt jelez, meg akkor is, ha
  // egyik sem eri el (meg) a "harmas szintet".
  const oppOrientationMax = opponentOrientationDanger(state.board, state.size, oppSymbols.primary);
  const sortedOrientationMax = [...oppOrientationMax].sort((x, y) => y - x);
  const forkWatchActive = sortedOrientationMax[1] >= FORK_WATCH_THRESHOLD;

  // Van-e BARHOL a jelolt-listaban egy legalabb "harmas-szintu" SAJAT (a)
  // ajanlat? Ha nincs, a mover-nek nincs mit szembeallitania egy harmas-
  // szintu ellenfel-fenyegetessel - ekkor a B vedelmi minimuma feltetel
  // nelkul ervenyesul (lasd `weightedBlockValue`). `forkWatchActive` eseten ezt
  // a "sajat-tamadásra hivatkozó menekulo utat" is lezarjuk: tobb-frontos
  // veszely eseten a vedekezes prioritasa nem engedheto a sajat ajanlat ala.
  const hasComparableOwnOffense = !forkWatchActive && cheapScored.some((c) => c.a >= MANDATORY_DEFENSE_THRESHOLD);

  cheapScored.sort((x, y) => (weighted(y.a, weights.A) + weightedBlockValue(y.b, weights.B, hasComparableOwnOffense)) - (weighted(x.a, weights.A) + weightedBlockValue(x.b, weights.B, hasComparableOwnOffense)));
  const shortlist = cheapScored.slice(0, EXPENSIVE_EVAL_LIMIT);

  const results = [];

  for (const { primary, a, b } of shortlist) {
    const picked = pickBestSecondary(state, mover, primary, weights);
    if (!picked) continue; // nem tortenhet meg (lasd engine invariants), de biztonsagbol

    const { secondary: bestSecondary, c: bestC, d: bestD } = picked;
    const score = weighted(a, weights.A) + weightedBlockValue(b, weights.B, hasComparableOwnOffense) - weighted(bestC, weights.C) - weighted(bestD, weights.D);
    results.push({ primary, secondary: bestSecondary, score, components: { a, b, c: bestC, d: bestD } });
  }

  results.sort((x, y) => y.score - x.score);
  return results;
}

/**
 * Egy adott `mover`-hez es `primary` jelolthoz kivalasztja a legjobb (legkisebb
 * C+D koltsegu) masodlagos szomszedot - ez a logika korabban az
 * evaluateBestPairsForMover belsejeben elt, ide lett kiemelve, hogy a
 * fenyegetes-lanc kereses (threatSearch.js) is ujra tudja hasznalni, amikor
 * egy VALODI (nem csak pontozott) lepesparhoz kell secondary-t valasztania.
 * Nem modositja a `state`-et. Visszaadja: { secondary, c, d } vagy null, ha
 * nincs ervenyes szomszed (nem tortenhet meg egy ervenyes primary utan).
 */
function pickBestSecondary(state, mover, primary, weights) {
  const mySymbols = PLAYER_SYMBOLS[mover];
  const oppSymbols = PLAYER_SYMBOLS[otherPlayer(mover)];

  // Ideiglenesen lerakjuk a primary-t (csak egy tabla-masolaton, a state-et
  // nem piszkaljuk), hogy a masodlagos jeloltek mar egy konzisztens
  // tabla-allapotot lassanak (a masodlagos mindig az elsodleges szomszedja
  // kell legyen).
  const afterPrimaryBoard = state.board.map((row) => row.map((f) => ({ ...f })));
  afterPrimaryBoard[primary.row][primary.col] = {
    state: mySymbols.primary,
    owner: mover,
    role: 'primary',
    turnIndex: state.turnIndex,
  };

  const secondaryCandidates = neighborsOf(state.size, primary.row, primary.col).filter(
    (p) => afterPrimaryBoard[p.row][p.col].state === 'empty'
  );
  if (secondaryCandidates.length === 0) return null;

  let bestSecondary = null;
  let bestCost = Infinity; // C + D, minimalizalando
  let bestC = 0;
  let bestD = 0;
  for (const secondary of secondaryCandidates) {
    // D: a kenyszeru masodlagos (O, ami az ELLENFEL primary szimboluma nem,
    // hanem a MI sajat masodlagos szimbolunk) mennyire rontja a SAJAT
    // (primary szimbolumu) sorunkat azzal, hogy elfoglalja ezt a mezot.
    const d = cellValueFor(afterPrimaryBoard, state.size, secondary, mySymbols.primary);
    // C: a masodlagos szimbolum (=ellenfel primary szimboluma!) mennyire
    // segiti most MAR odarakva az ellenfel sorat.
    const afterSecondaryBoard = afterPrimaryBoard.map((row) => row.map((f) => ({ ...f })));
    afterSecondaryBoard[secondary.row][secondary.col] = {
      state: mySymbols.secondary,
      owner: mover,
      role: 'secondary',
      turnIndex: state.turnIndex,
    };
    const c = cellValueFor(afterSecondaryBoard, state.size, secondary, oppSymbols.primary);

    const cost = weighted(c, weights.C) + weighted(d, weights.D);
    if (cost < bestCost) {
      bestCost = cost;
      bestSecondary = secondary;
      bestC = c;
      bestD = d;
    }
  }

  return { secondary: bestSecondary, c: bestC, d: bestD };
}

function applyPair(state, mover, primary, secondary) {
  // Biztonsagi ellenorzes: a lepespar-alkalmazas csak akkor ertelmes, ha
  // `mover` van soron (a hivo felelossege ezt garantalni szimulacio kozben).
  if (state.currentPlayer !== mover) return { ok: false, error: 'wrong-mover' };
  const p = placePrimary(state, primary.row, primary.col);
  if (!p.ok) return p;
  return placeSecondary(state, secondary.row, secondary.col);
}

const DIFFICULTY_SETTINGS = {
  easy: { depthPlies: 1, topN: 7, extendedRadius: 1 },
  medium: { depthPlies: 4, topN: 5, extendedRadius: 1 },
  hard: { depthPlies: 7, topN: 3, extendedRadius: 2 },
};

const DEFAULT_WEIGHTS = { A: 1, B: 1, C: 1, D: 1 };

// "Random x2 szorzo célpontja" nehezsegenkent (a felhasznalotol pontositott
// szabaly): konnyű szinten barmelyik komponens celpont lehet, kozepes/nehez
// szinten KIZAROLAG A vagy B (az offenziva/defenziva aranya mozog, a
// masodlagos-lepes C/D buntetesei nem kapnak veletlen dupla sulyt).
const RANDOM_DOUBLE_TARGETS = {
  easy: ['A', 'B', 'C', 'D'],
  medium: ['A', 'B'],
  hard: ['A', 'B'],
};

/**
 * Egy DONTESHEZ (egy chooseAiMove hivashoz) tartozo sulyokat allitja elo: a
 * `difficulty`-nek megfelelo celpont-halmazbol veletlenul kivalaszt EGY
 * komponenst, annak szorzojat 2-re allitja, a tobbi 1 marad. Ugyanaz a
 * sulyhalmaz ervenyes a dontes teljes kiertekelese soran (a gyoker-szintu
 * evaluateBestPairsForMover-re ES a negamax-lookahead minden szintjere is) -
 * igy egy "dontes" konzisztensen ugyanazt az offenziv/defenziv torzitast
 * kovetit vegig, nem valtozik lepesenkent a keresesi fan belul.
 */
function pickRandomWeights(difficulty, rng) {
  const targets = RANDOM_DOUBLE_TARGETS[difficulty] || RANDOM_DOUBLE_TARGETS.medium;
  const target = targets[Math.floor(rng() * targets.length)];
  const weights = { A: 1, B: 1, C: 1, D: 1 };
  weights[target] = 2;
  return weights;
}

/**
 * Negamax alfa-beta metszessel, lepespar-szintu ply-okkal. `depth` a meg
 * hatralevo ply-ok szama. A visszaadott ertek MINDIG a `mover` szempontjabol
 * ertendo (minel nagyobb, annal jobb `mover`-nek).
 */
function negamax(state, mover, depth, alpha, beta, settings, weights) {
  if (state.status !== 'playing' || depth === 0) return 0;
  // Lasd DEFAULT_TIME_BUDGET_MS fenti magyarazata: ha a dontesre szant
  // idokeret mar lejart, itt is ugyanugy leallunk, mintha elertuk volna a
  // keresesi melyseg aljat (0-t adva vissza) - a hivo a mar addig ismert
  // heurisztikus (mely-kereses nelkuli) ertekre esik vissza.
  if (settings.deadline && Date.now() > settings.deadline) return 0;

  const candidates = getBorderCells(state, settings.extendedRadius);
  const pairs = evaluateBestPairsForMover(state, mover, candidates, weights);
  if (pairs.length === 0) return 0;

  let best = -Infinity;
  for (const cand of pairs.slice(0, settings.topN)) {
    const sim = cloneState(state);
    const res = applyPair(sim, mover, cand.primary, cand.secondary);
    if (!res.ok) continue;

    let value;
    if (sim.status !== 'playing') {
      if (sim.status === 'draw') value = 0;
      else value = sim.winner === mover ? WIN_SCORE : -WIN_SCORE;
    } else {
      value = cand.score - negamax(sim, otherPlayer(mover), depth - 1, -beta, -alpha, settings, weights);
    }

    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // alfa-beta metszes
  }
  return best;
}

/**
 * FENYEGETES-LANC (VCF-szeru) KERESES
 * ===================================
 * Lasd a fejlesztes soran vegzett elemzest: az eddig megvizsgalt vesztes
 * partik mindegyike ugyanarra a jelensegre vezethetok vissza - az ellenfel
 * ugy epit fel 2 (vagy tobb) fenyegetest, hogy azok egy lepesen belul nem
 * mind kezelhetok. A `opponentOrientationDanger` ("villa-figyeles") ezt
 * ALTALANOS PONTOZASSAL probalja megsejteni - segit, de nem BIZONYIT semmit.
 *
 * Az itt kovetkezo `findForcedWin` ehelyett egy SZUK, de MELY, BIZONYITO
 * erejű keresest vegez: kizarolag "negyest" (mar csak 1 lepesre levo
 * gyozelmi fenyegetest) letrehozo lepesekre szukitve, a tenyleges
 * engine-mechanikan (placePrimary/placeSecondary, a kenyszeru masodlagos
 * lepest is figyelembe veve mindket felnel) vegiglejatssza a kikenyszeritett
 * valaszsorozatot. Ha talal ilyet, az nem valoszinuseg, hanem bizonyitek: a
 * pozicio onnantol objektive eldolt. Mert a kenyszerito lepesekre attalaban
 * csak 0-2 valasz letezik, ez a kereses SOKKAL melyebbre tud menni, mint az
 * altalanos negamax, elfogadhato koltseggel (lasd meres: kb. 10-280ms az
 * eddig vizsgalt allasokon, szemben a nehez negamax ~450-860ms-es
 * alapkoltsegevel).
 *
 * HATOKOR (szandekosan): tiszta VCF (csak "negyes"-lancokat keres), nem VCT
 * (altalanosabb "harmas"-szintu lancok). Ez mar lefedi az eddig elemzett
 * esetek nagy reszet (a vegzetes lepes mindig egy negyes/nyitott-negyes
 * volt), es lenyegesen egyszerubb helyesen implementalni.
 */

const THREAT_SEARCH_OPTS = { maxPly: 8, nodeBudget: 30000, candidateRadius: 2 };

/**
 * Megkeresi az OSSZES ures mezot, ahol `symbol` lerakasa AZONNAL 5-os (vagy
 * tobb) egybefuggo sort zarna le (tehat valodi gyozelmi lepes lenne). A
 * jelolt-mezoket a mar lerakott kovek melletti (radius=1) ures mezokre
 * szukiti (egy 5-os sort lezaro mezo mindig szomszedos legalabb egy, a
 * sorhoz tartozo mar lerakott koveel - ez garantalt, nem heurisztika).
 *
 * A `state`-et NEM modositja tartosan (a hipotetikus lerakast minden
 * jelolt-mezon visszavonja).
 */
function findWinCompletions(state, symbol) {
  const candidates = getBorderCells(state, 1);
  const completions = [];

  for (const pos of candidates) {
    const original = state.board[pos.row][pos.col];
    if (original.state !== 'empty') continue;

    state.board[pos.row][pos.col] = { state: symbol, owner: null, role: 'hypothetical', turnIndex: -1 };
    let wins = false;
    for (const axis of AXES) {
      const { count } = checkLine(state, pos, axis.dirs, symbol);
      if (count >= 5) {
        wins = true;
        break;
      }
    }
    state.board[pos.row][pos.col] = original; // visszaallitas

    if (wins) completions.push(pos);
  }

  return completions;
}

const THREAT_SEARCH_NEUTRAL_WEIGHTS = { A: 1, B: 1, C: 1, D: 1 };

/**
 * Egy `mover`-hez tartozo, `primary` mezore epulo TELJES lepespar (elsodleges
 * + a hozza valasztott legjobb masodlagos) tenyleges lejatszasa egy `state`
 * MASOLATAN (a bemenetet nem modositja). Visszaadja: { ok, sim, primary,
 * secondary } - `sim` a lepes utani allapot, vagy { ok: false } ha a lepes
 * barmilyen okbol ervenytelen.
 */
function applyBestPairForThreatSearch(state, mover, primary) {
  const picked = pickBestSecondary(state, mover, primary, THREAT_SEARCH_NEUTRAL_WEIGHTS);
  if (!picked) return { ok: false };

  const sim = cloneState(state);
  const applied = applyPair(sim, mover, primary, picked.secondary);
  if (!applied.ok) return { ok: false };

  return { ok: true, sim, primary, secondary: picked.secondary };
}

/**
 * 2026-08-29 javitas ("lyukas otos" hiba): Totti egy vesztes nehez-AI partit
 * elemezve talalt egy VALODI, megerositett hibat a findForcedWin
 * bizonyitasaban. A kereses eddig azt feltetelezte, hogy ha a mover-nek
 * PONTOSAN 1 befejezo mezoje (`completions.length===1`) van, az ellenfel
 * egyetlen lehetseges vedekezese a befejezo mezo KOZVETLEN elfoglalasa
 * (`applyBestPairForThreatSearch(sim, oppPlayer, blockCell)`). Ez klasszikus
 * Gomokuban igaz is lenne, DE a DiPole-ban van egy MASODIK, a keresestol
 * eddig eszrevetlen vedekezesi ut: az ellenfel a befejezo mezot ANELKUL is
 * hasznalhatatlanna teheti, hogy kozvetlenul elfoglalna - ha az adott mezo
 * MAR MOST is csak 1-2 ures szomszeddal rendelkezik, egyetlen (akar teljesen
 * MASHOVA iranyulo, a sajat ajanlatat is szolgalo) lepesparral inaktivalhatja
 * azt (lasd engine/board.js checkInactivity). A konkret esetben az AI egy
 * "lyukas negyest" hozott letre (pl. O O _ O O), a lyuknak MAR csak 1 ures
 * szomszedja volt - az ellenfel epp ezt a szomszedot toltotte ki egy MASIK,
 * sajat celra is hasznos lepessel, ami a lyukat mellekesen inaktivalta. A
 * kereses ezt nem latta elore, ezert TEVESEN `viaForcedWin:true` cimkevel,
 * teljes "bizonyossaggal" jatszotta le a vesztes lepest.
 * Javitas: mielott a kod egyetlen befejezo mezot kenyszeritonek fogadna el,
 * ellenorizzuk, hogy az ellenfel egy lepesparral inaktivalhatja-e azt anelkul,
 * hogy kozvetlenul elfoglalna - ha igen, ez NEM valodi kenyszerito lepes,
 * a keresesnek tovabb kell probalkoznia mas jelolttel.
 * HATOKOR (szandekosan korlatozott, dokumentalva): ez a javitas csak az
 * EGYETLEN befejezo mezos ("negyes") esetre vonatkozik. Nyitott negyesnel
 * (`completions.length>=2`) elviekben elkepzelheto, hogy az ellenfel EGYETLEN
 * lepesparral MINDKET befejezo mezot inaktivalja - ez lenyegesen ritkabb es
 * bonyolultabb eset (ket kulon mezo egyideju inaktivalasat kovetelne meg egy
 * lepesparbol), ezert egyelore nem kezeljuk kulon - a nyitott negyes tovabbra
 * is felteteel nelkul kenyszeritonek szamit, ahogy eddig.
 */
function emptyNeighborsOf(state, pos) {
  return neighborsOf(state.size, pos.row, pos.col).filter(
    (p) => state.board[p.row][p.col].state === 'empty'
  );
}

function canNeutralizeByInactivation(state, cell) {
  const emptyNbrs = emptyNeighborsOf(state, cell);
  if (emptyNbrs.length === 1) return true; // barmilyen sajat primary oda teve trivialisan inaktivalja `cell`-t
  if (emptyNbrs.length === 2) {
    // Csak akkor todtomheto be MINDKETTO egyetlen lepesparral, ha a ket ures
    // szomszed egymasnak is szomszedja (a masodlagosnak az elsodleges
    // szomszedjanak kell lennie).
    const [a, b] = emptyNbrs;
    return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
  }
  return false;
}

/**
 * A fo belepesi pont. Megprobal talalni egy BIZONYITOTTAN kenyszeritett
 * gyozelmi lepesszekvenciat `mover` szamara, `state`-bol kiindulva (ahol
 * `mover` van soron). Lasd a fenti modul-fejlec magyarazatat.
 *
 * Visszaado ertek: { found: boolean, line?: [{primary,secondary}, ...],
 * nodesUsed: number, timedOut?: boolean }.
 */
function findForcedWin(state, mover, opts = {}) {
  const maxPly = opts.maxPly ?? THREAT_SEARCH_OPTS.maxPly;
  const nodeBudget = opts.nodeBudget ?? THREAT_SEARCH_OPTS.nodeBudget;
  const candidateRadius = opts.candidateRadius ?? THREAT_SEARCH_OPTS.candidateRadius;
  // Lasd DEFAULT_TIME_BUDGET_MS fenti magyarazata - opcionalis, abszolut
  // (Date.now()-hoz viszonyitott) wall-clock hatarido, a mar meglevo
  // `nodeBudget`-tol fuggetlenul.
  const deadline = opts.deadline;

  const moverSymbols = PLAYER_SYMBOLS[mover];
  const oppPlayer = otherPlayer(mover);
  const oppSymbols = PLAYER_SYMBOLS[oppPlayer];

  let nodesUsed = 0;
  let timedOut = false;

  function search(s, plyBudget) {
    if (timedOut) return { found: false };
    nodesUsed++;
    if (nodesUsed > nodeBudget || (deadline && Date.now() > deadline)) {
      timedOut = true;
      return { found: false };
    }
    if (plyBudget <= 0) return { found: false };

    // Ha a mover-nek MAR MOST (barmilyen uj lepes nelkul) van kesz befejezo
    // mezoje, azt kell egyszeruen lejatszania - ez mindig kozvetlenebb es
    // gyorsabb, mint barmilyen "negyest teremto" korulmenyes jelolt. Enelkul
    // a lenti altalanos kereses egy MAR MEGLEVO (a jelolttol fuggetlen)
    // fenyegetest tevesen egy oda nem tartozo, veletlenszeru jelolthoz
    // kotne (mert a jelolt utani findWinCompletions ezt is latna).
    const existingCompletions = findWinCompletions(s, moverSymbols.primary);
    if (existingCompletions.length > 0) {
      const direct = applyBestPairForThreatSearch(s, mover, existingCompletions[0]);
      if (direct.ok && direct.sim.status === 'won' && direct.sim.winner === mover) {
        return { found: true, line: [{ primary: existingCompletions[0], secondary: direct.secondary }] };
      }
    }

    const candidates = getBorderCells(s, candidateRadius);
    for (const primary of candidates) {
      if (s.board[primary.row][primary.col].state !== 'empty') continue;

      const result = applyBestPairForThreatSearch(s, mover, primary);
      if (!result.ok) continue;
      const { sim, secondary } = result;

      if (sim.status === 'won' && sim.winner === mover) {
        return { found: true, line: [{ primary, secondary }] };
      }
      if (sim.status !== 'playing') continue; // dontetlen, vagy a sajat kenyszeru masodlagos miatt az ellenfel nyert

      const completions = findWinCompletions(sim, moverSymbols.primary);
      if (completions.length === 0) continue; // nem negyes -> tiszta VCF-ben nem vizsgaljuk tovabb

      const oppImmediateWins = findWinCompletions(sim, oppSymbols.primary);
      if (oppImmediateWins.length > 0) continue; // az ellenfelnek gyorsabb sajat gyozelme van - nem valodi kenyszer

      if (completions.length >= 2) {
        // 2026-08-29 javitas ("hianyos bizonyitas" - kisebb, mellekesen
        // talalt hiba, Totti egy "game10" partit elemezve vetette fel a
        // kettos fenyegetes kapcsan): a DONTES itt valtozatlan - egy nyitott
        // negyes (2+ befejezo mezo) VALODI kenyszerito lepes marad,
        // FELTETEL NELKUL, hiszen az ellenfel egyetlen kozvetlen elsodleges
        // lepessel legfeljebb az EGYIK befejezo mezot foglalhatja el, a
        // masik garantaltan nyitva marad (a "lyukas otos"-fele inaktivalasi
        // ellenlepest itt SZANDEKOSAN nem vizsgaljuk - lasd a fenti modul-
        // fejlec dokumentaciojat a korlatozott hatokorrol: ket, egymastol
        // FUGGETLEN/tavoli befejezo mezo EGYSZERRE tortenő inaktivalasa
        // strukturalisan mas, nehezebb eset, amit egyelore nem oldunk meg).
        // Korabban a visszaadott `line` csak EZT az egy lepest tartalmazta,
        // holott a tenyleges gyozelemhez meg legalabb egy tovabbi lepes
        // kell (az egyik nyitva maradt befejezo mezo elfoglalasa) - ez NEM
        // befolyasolta a chooseAiMove tenyleges dontesehez hasznalt `.found`
        // erteket (mindig `true` maradt), csak a bemutatott bizonyito
        // lepéssor volt informacio-hianyos. Itt egy illusztrativ (nem a
        // dontest befolyasolo) folytatast probalunk hozzafuzni: az ellenfel
        // megprobalja blokkolni az egyik befejezo mezot, a masik garantaltan
        // nyitva marad, es a mover azt lezarja. Ha ez az illusztracio
        // barmilyen okbol nem all ossze, a regi (rovidebb, de tovabbra is
        // `found:true`) visszateres marad a biztonsagos alapertelmezes.
        const oppDefends = applyBestPairForThreatSearch(sim, oppPlayer, completions[0]);
        if (
          oppDefends.ok &&
          oppDefends.sim.status === 'playing' &&
          !(oppDefends.sim.status === 'won' && oppDefends.sim.winner === oppPlayer)
        ) {
          const stillOpen = findWinCompletions(oppDefends.sim, moverSymbols.primary);
          if (stillOpen.length > 0) {
            const finalMove = applyBestPairForThreatSearch(oppDefends.sim, mover, stillOpen[0]);
            if (finalMove.ok && finalMove.sim.status === 'won' && finalMove.sim.winner === mover) {
              return {
                found: true,
                line: [
                  { primary, secondary },
                  { primary: completions[0], secondary: oppDefends.secondary },
                  { primary: stillOpen[0], secondary: finalMove.secondary },
                ],
              };
            }
          }
        }
        return { found: true, line: [{ primary, secondary }] }; // biztonsagi visszaeses - a dontes ekkor is valtozatlan
      }

      const blockCell = completions[0];
      // Lasd a fenti "lyukas otos" javitas magyarazata: ha az ellenfel a
      // befejezo mezot INAKTIVALASSAL is semlegesitheti (anelkul, hogy
      // kozvetlenul elfoglalna), ez NEM valodi kenyszerito lepes - probaljuk
      // a kovetkezo jeloltet.
      if (canNeutralizeByInactivation(sim, blockCell)) continue;

      // 2026-08-29 (2. javitas, "szabad masodlagos" hiba): az ellenfel
      // ELSODLEGES lepese a blockCell-re kenyszerul (ez az egyetlen mod a
      // kozvetlen blokkolasra), DE a MASODLAGOS lepese SZABADON valaszthato
      // a blockCell akkori ures szomszedai kozul (lasd engine/board.js
      // getValidSecondary - a masodlagos valasztast semmi sem koti egy
      // adott heurisztikahoz, csak a szomszedsaghoz). A korabbi kod itt
      // `applyBestPairForThreatSearch`-t hasznalt, ami csak EGY (a
      // tamado sulyokkal "legjobbnak" velt) masodlagost probalt ki az
      // ellenfel neveben, es tevesen feltetelezte: ha EZ az egy valasztas
      // a mover gyozelmehez vezet, akkor MINDEN valasztas az. Totti egy
      // valos vesztes partiban ("game8", 2026-08-29) talalta: az ellenfel
      // a valosagban egy MASIK, a keresestol ki nem probalt masodlagos
      // mezot valasztott, es ez megmentette a partit - a kereses ezt nem
      // latta elore, ezert tevesen `viaForcedWin:true` cimkevel jatszotta
      // le a lepest, ami vegul vesztes partihoz vezetett.
      // Javitas: VEGIG KELL probalni az ellenfel osszes lehetseges
      // masodlagos valasztasat - a jelolt csak akkor valodi kenyszerito
      // lepes, ha VALAMENNYI ilyen valasztas utan is bizonyithato a mover
      // gyozelme (a search() eleve konzervativ: ha barmelyik ellenfeles
      // valasztas kiszabadulast tesz lehetove, a jelolt elesik).
      const oppSecondaryOptions = emptyNeighborsOf(sim, blockCell);
      let allOppDefensesStillLoseForOpponent = true;
      let exampleContinuation = null;
      for (const oppSecondary of oppSecondaryOptions) {
        const afterBlock = cloneState(sim);
        const applied = applyPair(afterBlock, oppPlayer, blockCell, oppSecondary);
        if (!applied.ok) continue; // nem kellene elofordulnia (szomszedsagi ellenorzes mar megtortent)

        if (afterBlock.status === 'won' && afterBlock.winner === mover) {
          exampleContinuation = exampleContinuation || { secondary: oppSecondary, subLine: [] };
          continue;
        }
        if (afterBlock.status !== 'playing') {
          // dontetlen, vagy ez a masodlagos-valasztas epp az ellenfelnek
          // szerez gyozelmet - a jelolt tehat NEM valodi kenyszerito lepes.
          allOppDefensesStillLoseForOpponent = false;
          break;
        }

        const sub = search(afterBlock, plyBudget - 2);
        if (!sub.found) {
          allOppDefensesStillLoseForOpponent = false;
          break;
        }
        exampleContinuation = exampleContinuation || { secondary: oppSecondary, subLine: sub.line };
      }

      if (!allOppDefensesStillLoseForOpponent || !exampleContinuation) continue;

      return {
        found: true,
        line: [
          { primary, secondary },
          { primary: blockCell, secondary: exampleContinuation.secondary },
          ...exampleContinuation.subLine,
        ],
      };
    }

    return { found: false };
  }

  const outcome = search(state, maxPly);
  return { ...outcome, nodesUsed, timedOut };
}

// 2026-08-29 javitas ("unalmas nyitas"): Totti visszajelzese szerint nehez
// szinten az AI 1-2. sajat lepese (a parti 2. es 4. lepese) szinte mindig
// ugyanaz, mert a nyitasban a jelolt lepesek erteke a tabla szimmetriaja
// miatt gyakran PONTOSAN egyenlo, es az addigi kod a lista elso (mindig
// ugyanugy elonyben reszesitett) tagjat valasztotta determinisztikusan - a
// mar meglevo "veletlen x2 suly" (pickRandomWeights) ezen nem segit, mert
// szimmetrikus jeloltekre BARMELYIK komponens felsulyozasa egyformán hat,
// a dontetlen megmarad.
// Egyeztetett megoldas (AskUserQuestion-menet, 2026-08-29): amíg EGYIK
// felnek SINCS meg "harmas-szintu" (>=MANDATORY_DEFENSE_THRESHOLD) sajat
// vonala a tablan - tehat tenylegesen "meg nem dolt el semmi" -, a
// chooseAiMove a pontosan azonos ertekű legjobb jeloltek KOZUL veletlenul
// valaszt, nem csak az elsot. Amint barmelyik fel eler egy harmas-szintu
// fenyegetest, visszaall a teljesen determinisztikus legjobb-lepes-
// valasztasra - a valodi tetek mellett a variete tovabbra sem
// kockaztathatja a jatek minoseget. Mindharom nehezsegi szinten aktiv
// (a felhasznalo kifejezett kerese szerint).
function strongestLineOnBoard(board, size, symbol) {
  return Math.max(...opponentOrientationDanger(board, size, symbol));
}

function isEarlyUndecidedPosition(state) {
  return (
    strongestLineOnBoard(state.board, state.size, 'X') < MANDATORY_DEFENSE_THRESHOLD &&
    strongestLineOnBoard(state.board, state.size, 'O') < MANDATORY_DEFENSE_THRESHOLD
  );
}

// 2026-08-29 (folytatas): kiderult meresekkel (lasd fejlesztoi jegyzet), hogy
// a MELY (negamax-szal korrigalt) `value` szinte SOHA nem ad valodi
// egyenlosegetakkor sem, ha a GYOKER-szintu (nem-mely) heurisztikus `score`
// pontosan egyenlo tobb jelolt kozott: mar egyetlen (a human masodlagos
// lepesebol szarmazo) aszimmetrikus ko is elegendo ahhoz, hogy a mely kereses
// hatarozottan (nem csak "veletlenszeruen tortent hogy elsokent talalta")
// elonyben reszesitsen egyet - ezert a dontetlen-detektalast a GYOKER `score`-ra
// (evaluateBestPairsForMover eredmenye, MEG a mely negamax-lookahead elott)
// kell alapozni, nem a vegso `value`-ra. Ez pontosan azt ragadja meg, amit a
// felhasznalo "majdnem azonos legjobb valasztas" alatt ertett: a KOZVETLEN
// (nem tavoli, hipotetikus jovobeli) taktikai ertek alapjan egyenrangu
// jeloltek kozotti valasztas - a tavoli kulonbsegeket a "meg nem dolt el
// semmi" fazisban szandekosan figyelmen kivul hagyjuk.
function pickVariedOpeningPair(state, mover, pairs, rng, deadline) {
  const topScore = pairs[0].score;
  const tieGroup = pairs.filter((p) => p.score === topScore);
  if (tieGroup.length < 2) return null; // nincs valodi dontetlen - marad a szokasos, mely kereses

  // Biztonsagi szuro: "ne lepjen visszafordithatatlant" (felhasznaloi kerese) -
  // egy dontetlen-tag SEM valaszthato, ha (a) kozvetlenul a sajat vesztéhez
  // vezetne, vagy (b) utana bizonyitottan kikenyszerithetu gyozelmet hagyna az
  // ellenfelnek (lasd findForcedWin). Ez a szuro FUGGETLEN a nehezsegi
  // szinttol (mindharomra fut) - szigorubb, mint a jatek soran altalaban
  // alkalmazott, csak "hard"-ra korlatozott vedekezo ellenorzes, DE csak ezen
  // a szuk (dontetlen-)halmazon fut, igy nem valtoztatja meg a jatek altalanos
  // nehezseg-erzetet, csak a nyitas biztonsagat garantalja.
  const safeCandidates = [];
  for (const cand of tieGroup) {
    const sim = cloneState(state);
    const res = applyPair(sim, mover, cand.primary, cand.secondary);
    if (!res.ok) continue;
    if (sim.status !== 'playing') {
      if (sim.status === 'won' && sim.winner !== mover) continue; // sajat vesztes - kizarva
      safeCandidates.push(cand);
      continue;
    }
    const leavesOpponentForcedWin = findForcedWin(sim, otherPlayer(mover), { ...THREAT_SEARCH_OPTS, deadline }).found;
    if (!leavesOpponentForcedWin) safeCandidates.push(cand);
  }

  if (safeCandidates.length < 2) return null; // nincs eleg biztonsagos alternativa - marad a szokasos ut
  return safeCandidates[Math.floor(rng() * safeCandidates.length)];
}

/**
 * Fo belepesi pont: kivalasztja az AI (mint `aiPlayer`) legjobb lepesparjat
 * `state`-ben, `difficulty` (`'easy'|'medium'|'hard'`) szerinti melyseggel es
 * jelolt-szukitessel. `rng` injektalhato a determinisztikus teszteleshez.
 *
 * A sulyokat (A/B/C/D) - hacsak nincs kulon `weights` megadva (pl. tesztekhez)
 * - a `pickRandomWeights` hatarozza meg: dontesenkent EGYSZER veletlenul
 * kivalasztott komponens kap 2x szorzot (lasd RANDOM_DOUBLE_TARGETS), a tobbi
 * marad 1x - ez a spec "Random x2 szorzo" szabalyanak pontos megvalositasa.
 *
 * Visszaadja: { primary: {row,col}, secondary: {row,col} } vagy null, ha
 * nincs ervenyes lepes (nem tortenhet meg jatek kozben, lasd engine invariants).
 */
function chooseAiMove(state, { difficulty = 'medium', rng = Math.random, weights, timeBudgetMs } = {}) {
  if (state.status !== 'playing') return null;
  const settings = DIFFICULTY_SETTINGS[difficulty] || DIFFICULTY_SETTINGS.medium;
  const mover = state.currentPlayer;
  const effectiveWeights = weights || pickRandomWeights(difficulty, rng);
  // Lasd DEFAULT_TIME_BUDGET_MS fenti magyarazata: EGYETLEN, abszolut
  // (Date.now()-hoz viszonyitott) hatarido ervenyes a dontes TELJES
  // kiertekelesere (sajat kenyszerito-gyozelem-ellenorzes + negamax-lookahead
  // + nyitasi/vedekezo biztonsagi ellenorzesek egyutt) - minden alkeresesnek
  // UGYANAZT az erteket adjuk at, hogy azok osszesitett ideje se lephesse at
  // a korlatot. `timeBudgetMs` kivulrol is felulirhato (pl. tesztekhez).
  const deadline = Date.now() + (timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const searchSettings = { ...settings, deadline };

  // TAMADO FENYEGETES-ELLENORZES (mindharom nehezsegen): ha MAR MOST van
  // bizonyitottan kikenyszerithetu gyozelme a mover-nek, azt vegyuk el -
  // ezt nem szabad a heurisztikus pontozasra/topN-vagasra bizni, mert az
  // (kulonosen konnyű/kozepes szinten) egy valodi nyero lepest is
  // athagyhat. Lasd findForcedWin fenti magyarazata.
  const ownForcedWin = findForcedWin(state, mover, { ...THREAT_SEARCH_OPTS, deadline });
  if (ownForcedWin.found) {
    const first = ownForcedWin.line[0];
    return { primary: first.primary, secondary: first.secondary, weightsUsed: effectiveWeights, viaForcedWin: true };
  }

  const candidates = getBorderCells(state, settings.extendedRadius);
  const pairs = evaluateBestPairsForMover(state, mover, candidates, effectiveWeights);
  if (pairs.length === 0) return null;

  // "UNALMAS NYITAS" JAVITAS (mindharom nehezsegen, felhasznaloi kerese):
  // amíg a poziciō meg tenylegesen nyitott (lasd isEarlyUndecidedPosition),
  // es van legalabb 2, a GYOKER-szintu heurisztika szerint pontosan
  // egyenrangu ES biztonsagos jelolt, ezek kozul veletlenul valasztunk -
  // igy a nyitas nem ismetli mindig ugyanazt a lepest. Lasd
  // pickVariedOpeningPair fenti magyarazata arrol, hogy miert a gyoker
  // `score`-on, nem a mely `value`-n alapul a dontetlen-detektalas.
  if (isEarlyUndecidedPosition(state)) {
    const variedChoice = pickVariedOpeningPair(state, mover, pairs, rng, deadline);
    if (variedChoice) {
      return { primary: variedChoice.primary, secondary: variedChoice.secondary, weightsUsed: effectiveWeights };
    }
  }

  const top = pairs.slice(0, settings.topN);
  let bestPair = null;
  let bestValue = -Infinity;
  // VEDEKEZO FENYEGETES-ELLENORZES: egyelore csak "hard"-on (lasd a
  // felhasznaloval egyeztetett scope - lasd modul-fejlec). Ha egy jelolt
  // UTAN bizonyitottan kikenyszerithetu gyozelme lenne az ellenfelnek, azt a
  // jeloltet kerulni kell, HA van masik, biztonsagos valasztas - kulonben
  // (mar objektive vesztes allas) a heurisztikus legjobbra esunk vissza.
  const checkDefensiveThreat = difficulty === 'hard';
  let bestSafePair = null;
  let bestSafeValue = -Infinity;

  for (const cand of top) {
    const sim = cloneState(state);
    const res = applyPair(sim, mover, cand.primary, cand.secondary);
    if (!res.ok) continue;

    let value;
    let leavesOpponentForcedWin = false;
    if (sim.status !== 'playing') {
      if (sim.status === 'draw') value = 0;
      else value = sim.winner === mover ? WIN_SCORE : -WIN_SCORE;
    } else {
      value = cand.score - negamax(sim, otherPlayer(mover), settings.depthPlies - 1, -Infinity, Infinity, searchSettings, effectiveWeights);
      if (checkDefensiveThreat) {
        leavesOpponentForcedWin = findForcedWin(sim, otherPlayer(mover), { ...THREAT_SEARCH_OPTS, deadline }).found;
      }
    }

    if (value > bestValue) {
      bestValue = value;
      bestPair = cand;
    }
    if (!leavesOpponentForcedWin && value > bestSafeValue) {
      bestSafeValue = value;
      bestSafePair = cand;
    }
  }

  // Ha van biztonsagos jelolt (nem hagy bizonyitott kenyszeritett gyozelmet
  // az ellenfelnek), azt reszesitjuk elonyben - mashogy a topN-en beluli
  // legjobb heurisztikus pontszamu jelolt marad (ami akar mar objektive
  // vesztes allas is lehet, ha MINDEN jelolt ilyen).
  const chosen = bestSafePair || bestPair;
  if (!chosen) return null;
  // `weightsUsed` mellekelve: a hivo (App.js) ezt elmentheti a parti
  // elemezheto naplojahoz (lasd "Parti mentese elemzeshez" funkcio) - igy
  // utolag pontosan visszaallithato, melyik veletlen A/B/C/D-szorzas
  // (pickRandomWeights) volt ervenyben pont EHHEZ a dontesehez, nem csak a
  // vegso lepes.
  return { primary: chosen.primary, secondary: chosen.secondary, weightsUsed: effectiveWeights };
}

module.exports = {
  DIFFICULTY_SETTINGS,
  // A 2026-09 worker-pool (lasd aiWorkerPool.js) ezt hasznalja a "worker
  // lefagyott" biztonsagi-halo idozitesehez (a tenyleges egyuttmukodo
  // hataridon FELUL, annak margojaval) - lasd ott a HANG_MARGIN_MS mellett.
  DEFAULT_TIME_BUDGET_MS,
  scoreLineResult,
  cellValueFor,
  // "Konvergencia-pont" javitas - kulon exportalva, hogy onmagaban is
  // tesztelheto legyen (lasd test/ai.test.js).
  cellBlockValue,
  opponentOrientationDanger,
  getBorderCells,
  evaluateBestPairsForMover,
  pickRandomWeights,
  chooseAiMove,
  // Fenyegetes-lanc (VCF-szeru) kereses - lasd a findForcedWin fenti
  // magyarazatat. Kulon exportalva, hogy tesztelheto/merheto legyen
  // onmagaban is (lasd test/threatSearch.test.js, measure_threats.js).
  findWinCompletions,
  findForcedWin,
  // "Lyukas otos" javitas - kulon exportalva, hogy onmagaban is tesztelheto
  // legyen (lasd test/threatSearch.test.js).
  canNeutralizeByInactivation,
  // A tobbi belso epitoelem, ujrafelhasznalasra exportalva.
  cloneState,
  applyPair,
  otherPlayer,
  pickBestSecondary,
  // "Unalmas nyitas" javitas - kulon exportalva, hogy onmagaban is
  // tesztelheto legyen (lasd test/ai.test.js).
  isEarlyUndecidedPosition,
  pickVariedOpeningPair,
};
