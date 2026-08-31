'use strict';

/**
 * DiPole (Dualis) - alap jatéklogika (game engine)
 *
 * Ez a modul a projekt-osszesito "3. Rendszer (jatekfelugyeleti szkript)" fejezete
 * alapjan implementalja a tabla-allapotot es a lepespar-mechanikat.
 * Framework-fuggetlen, sima JS - a React Native + Skia frontend majd erre epul ra.
 *
 * MEGERŐSÍTETT SZABÁLYOK (a felhasználóval tisztázva, 2026-08-27):
 *
 * 1. Szimbolum-alapu gyozelem: a tabla mezoire kerult X/O szimbolum szamit a
 *    sor-kereseskor, FUGGETLENUL attol, hogy melyik jatekos rakta le (mert p1
 *    masodlagos jele O, ami p2 elsodleges jele, es forditva). Ez azt is jelenti,
 *    hogy egy jatekos a SAJAT lepesevel (pl. a kotelezo masodlagos jelevel) az
 *    ELLENFEL soranak befejezeset is elokidezheti - ez szandekos, resze a
 *    jateknak. Lasd 'checkVictory: sajat lepes az ellenfelnek szerez gyozelmet' teszt.
 * 2. A tabla szelen kivuli ("out of bounds") szomszed a checkInactivity soran
 *    "foglaltnak" szamit (mintha fal lenne) - igy a szel menti mezok is tudnak
 *    inaktivva valni, ha a tablan beluli szomszedaik mind foglaltak.
 * 3. checkLine jelenleg csak a szigoruan egybefuggo (gaps=0) esetet szamolja a
 *    gyozelem-ellenorzeshez - ez eleg az 5-os sor eldontesehez. A "lyukas sor"
 *    (gap-tolerans) pontertekeles az AI modul feladata lesz, ott bovitendo.
 * 4. Elsodleges lepes utan MINDIG van legalabb egy szabad szomszed (tehat
 *    validSecondary sosem ures halmaz egy ervenyes primary lepes utan). Ez nem
 *    kulon szabaly, hanem a checkInactivity mukodesenek egyenes kovetkezmenye:
 *    egy mezo csak akkor valhat 'empty'-bol 'inactive'-ba, ha PONTOSAN azon a
 *    lepesen valik korbezartta - tehat egy meg 'empty' allapotu (nem inaktiv)
 *    mezonek garantaltan van szabad szomszedja, kulonben mar inaktiv lenne.
 *    Lasd 'invariants.test.js' - hosszu random jatszmakon at ellenorzi.
 */

const BOARD_SIZE = 25;

const PLAYER_SYMBOLS = {
  1: { primary: 'X', secondary: 'O' },
  2: { primary: 'O', secondary: 'X' },
};

const SYMBOL_TO_PRIMARY_OWNER = { X: 1, O: 2 };

// A 4 iranypar (tengely), mindegyik ket ellentetes egysegvektorral
const AXES = [
  { name: 'horizontal', dirs: [[0, 1], [0, -1]] },
  { name: 'vertical', dirs: [[1, 0], [-1, 0]] },
  { name: 'diag-down', dirs: [[1, 1], [-1, -1]] }, // \
  { name: 'diag-up', dirs: [[1, -1], [-1, 1]] }, // /
];

function inBounds(size, row, col) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

function emptyField() {
  return { state: 'empty', owner: null, role: null, turnIndex: null };
}

function initBoard(size = BOARD_SIZE) {
  const board = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(emptyField());
    board.push(row);
  }
  return board;
}

function createGameState(size = BOARD_SIZE) {
  return {
    board: initBoard(size),
    size,
    currentPlayer: 1,
    phase: 'primary', // 'primary' | 'secondary'
    primaryPos: null,
    validSecondary: [],
    turnIndex: 0,
    timer: 60,
    status: 'playing', // 'playing' | 'won' | 'draw' | 'abandoned'
    debugMode: false,
    winner: null, // null | 1 | 2 | 'draw'
    lastMove: null, // { primary: {row,col}, secondary: {row,col}, player }
    history: [], // { player, primary: {row,col}, secondary: {row,col}|null, turnIndex }
    winningCells: null, // gyozelemkor: { "row,col": 'X'|'O' } - a lezaro (5+) sor(ok) osszes mezoje
  };
}

function key(row, col) {
  return `${row},${col}`;
}

function neighborsOf(size, row, col) {
  const result = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (inBounds(size, r, c)) result.push({ row: r, col: c });
    }
  }
  return result;
}

function getValidPrimary(state) {
  const result = [];
  for (let r = 0; r < state.size; r++) {
    for (let c = 0; c < state.size; c++) {
      if (state.board[r][c].state === 'empty') result.push({ row: r, col: c });
    }
  }
  return result;
}

function getValidSecondary(state, pos) {
  if (!pos) return [];
  return neighborsOf(state.size, pos.row, pos.col).filter(
    ({ row, col }) => state.board[row][col].state === 'empty'
  );
}

function isValidSecondaryChoice(state, row, col) {
  return state.validSecondary.some((p) => p.row === row && p.col === col);
}

/**
 * Elsodleges jel lerakasa. Visszaadja: { ok: boolean, error?: string }
 */
function placePrimary(state, row, col) {
  if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };
  if (state.phase !== 'primary') return { ok: false, error: 'wrong-phase' };
  if (!inBounds(state.size, row, col)) return { ok: false, error: 'out-of-bounds' };
  if (state.board[row][col].state !== 'empty') return { ok: false, error: 'cell-not-empty' };

  const symbol = PLAYER_SYMBOLS[state.currentPlayer].primary;
  state.board[row][col] = {
    state: symbol,
    owner: state.currentPlayer,
    role: 'primary',
    turnIndex: state.turnIndex,
  };
  state.primaryPos = { row, col };
  state.phase = 'secondary';
  state.validSecondary = getValidSecondary(state, state.primaryPos);
  return { ok: true };
}

/**
 * Elsodleges lepes visszavonasa: a jatekos veletlen erintes ellen vedve, ha a
 * masodlagos-valasztas fazisban NEM egy felkinalt (ervenyes masodlagos)
 * mezore koppint, az elsodleges jelet visszavonhatja - ugy, mintha meg nem is
 * lepett volna ebben a korben. Az ido (timer) SZANDEKOSAN nem all vissza,
 * hogy ne lehessen ezzel idot "lopni".
 * Visszaadja: { ok: boolean, error?: string }
 */
function retractPrimary(state) {
  if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };
  if (state.phase !== 'secondary') return { ok: false, error: 'wrong-phase' };
  const { row, col } = state.primaryPos;
  state.board[row][col] = emptyField();
  state.phase = 'primary';
  state.primaryPos = null;
  state.validSecondary = [];
  return { ok: true };
}

/**
 * Masodlagos jel lerakasa. Ez futtatja az inaktivitas- es gyozelem-ellenorzest,
 * majd jatekosvaltast (vagy jatekveget) is.
 * Visszaadja: { ok, error?, inactivated?: [...], result?: {player1Wins, player2Wins} }
 */
function placeSecondary(state, row, col) {
  if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };
  if (state.phase !== 'secondary') return { ok: false, error: 'wrong-phase' };
  if (!isValidSecondaryChoice(state, row, col)) {
    return { ok: false, error: 'invalid-secondary-choice' };
  }

  const symbol = PLAYER_SYMBOLS[state.currentPlayer].secondary;
  state.board[row][col] = {
    state: symbol,
    owner: state.currentPlayer,
    role: 'secondary',
    turnIndex: state.turnIndex,
  };

  const positions = [state.primaryPos, { row, col }];
  const inactivated = checkInactivity(state, positions);
  const result = checkVictory(state, positions);

  // A gyoztes sor(ok) osszes mezoje - a UI ezzel emeli ki inverz szinezessel
  // ("row,col" -> lezaro szimbolum). Dontetlennel (mindket jatekos lezarja a
  // soret egyszerre) mindket sor bekerul, sajat szimboluma szerint.
  if (result.winningLines.length > 0) {
    const winningCells = {};
    for (const line of result.winningLines) {
      for (const c of line.cells) winningCells[key(c.row, c.col)] = line.symbol;
    }
    state.winningCells = winningCells;
  }

  state.lastMove = { primary: state.primaryPos, secondary: { row, col }, player: state.currentPlayer };
  state.history.push({
    player: state.currentPlayer,
    primary: state.primaryPos,
    secondary: { row, col },
    turnIndex: state.turnIndex,
  });

  if (result.player1Wins && result.player2Wins) {
    state.status = 'draw';
    state.winner = 'draw';
  } else if (result.player1Wins) {
    state.status = 'won';
    state.winner = 1;
  } else if (result.player2Wins) {
    state.status = 'won';
    state.winner = 2;
  } else {
    switchPlayer(state);
  }

  return { ok: true, inactivated, result };
}

/**
 * Inaktivita-ellenorzes: az uj mezok (max 2) szomszedai kozul (max 16, dedupelve)
 * azok valnak inaktivva, amelyeknek mind a 8 szomszedja foglalt (X/O/inactive),
 * VAGY a tabla szelen kivul esik (lasd modul-tetejei 2. feltetelezes).
 */
function checkInactivity(state, positions) {
  const candidates = new Map();
  for (const pos of positions) {
    if (!pos) continue;
    for (const n of neighborsOf(state.size, pos.row, pos.col)) {
      candidates.set(key(n.row, n.col), n);
    }
  }

  const newlyInactive = [];
  for (const { row, col } of candidates.values()) {
    const field = state.board[row][col];
    if (field.state !== 'empty') continue; // csak szabad mezo valhat inaktivva

    let allBlocked = true;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        if (!inBounds(state.size, r, c)) continue; // fal, szamit foglaltnak
        if (state.board[r][c].state === 'empty') {
          allBlocked = false;
          break;
        }
      }
      if (!allBlocked) break;
    }

    if (allBlocked) {
      state.board[row][col] = { state: 'inactive', owner: null, role: null, turnIndex: state.turnIndex };
      newlyInactive.push({ row, col });
    }
  }
  return newlyInactive;
}

/**
 * Egy tengely (2 ellentetes irany) menten megszamolja a pos-on athalado,
 * `symbol`-lal egybefuggo sor hosszat, es hogy a ket vege nyitott-e.
 * (lasd modul-tetejei 3. feltetelezes a gaps mezorol)
 */
function checkLine(state, pos, axisDirs, symbol) {
  let count = 1;
  let openEnds = 0;
  const gaps = 0;
  const cells = [{ row: pos.row, col: pos.col }]; // az egybefuggo sor tenyleges mezoi (gyozelem-kiemeleshez)

  for (const [dr, dc] of axisDirs) {
    let step = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = pos.row + dr * step;
      const c = pos.col + dc * step;
      if (!inBounds(state.size, r, c)) break; // fal -> zart veg
      const cell = state.board[r][c];
      if (cell.state === symbol) {
        count++;
        cells.push({ row: r, col: c });
        step++;
        continue;
      }
      if (cell.state === 'empty') openEnds++; // nyitott veg
      break; // barmi mas (ellenfel jel vagy inactive) -> zart veg
    }
  }

  return { count, gaps, openEnds, cells };
}

/**
 * A ket ujonnan lerakott mezo korul (mindket mezobol, mind a 4 tengelyen)
 * megnezi, kialakult-e 5-os (vagy tobb) egybefuggo sor valamelyik szimbolumbol.
 */
function checkVictory(state, positions) {
  let player1Wins = false;
  let player2Wins = false;
  const winningLines = [];

  for (const pos of positions) {
    if (!pos) continue;
    const symbol = state.board[pos.row][pos.col].state;
    const owningPlayer = SYMBOL_TO_PRIMARY_OWNER[symbol];
    if (!owningPlayer) continue; // biztonsagi ellenorzes

    for (const axis of AXES) {
      const { count, cells } = checkLine(state, pos, axis.dirs, symbol);
      if (count >= 5) {
        if (owningPlayer === 1) player1Wins = true;
        else player2Wins = true;
        winningLines.push({ pos, axis: axis.name, symbol, count, cells });
      }
    }
  }

  return { player1Wins, player2Wins, winningLines };
}

/**
 * Feladas: a megadott jatekos feladja, a masik azonnal nyer.
 * A tenyleges "AI atveszi" logika (multiplayer, disconnect-kezeles) kesobbi
 * feladat - ez a helyi (hotseat) mod egyszerű, azonnali valtozata.
 */
function surrender(state, player) {
  if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };
  if (![1, 2].includes(player)) return { ok: false, error: 'invalid-player' };
  state.status = 'won';
  state.winner = player === 1 ? 2 : 1;
  state.surrenderedBy = player;
  return { ok: true, winner: state.winner };
}

/**
 * Egy masodperccel csokkenti az aktualis lepespar hatralevo idejet (0-nal megall).
 * A tenyleges "mi tortenik lejaratkor" logikat a handleTimeout vegzi - ezt a
 * hivo (UI/idozito) donti el, mikor hivja meg (pl. tickTimer utan, ha timer===0).
 */
function tickTimer(state) {
  state.timer = Math.max(0, state.timer - 1);
  return state.timer;
}

/**
 * Az eddig lerakott osszes jel (primary+secondary) befoglalo teglalapja.
 * Ez a viewport/zoom rendszer "foglalt terulethez igazitas" (⊕ gomb, auto-fit)
 * funkciojahoz kell - null, ha meg egyetlen lepes sem tortent.
 */
function getMovesBoundingBox(state) {
  if (state.history.length === 0) return null;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const turn of state.history) {
    for (const pos of [turn.primary, turn.secondary]) {
      if (!pos) continue;
      if (pos.row < minRow) minRow = pos.row;
      if (pos.row > maxRow) maxRow = pos.row;
      if (pos.col < minCol) minCol = pos.col;
      if (pos.col > maxCol) maxCol = pos.col;
    }
  }
  return { minRow, maxRow, minCol, maxCol };
}

function switchPlayer(state) {
  state.currentPlayer = state.currentPlayer === 1 ? 2 : 1;
  state.phase = 'primary';
  state.primaryPos = null;
  state.validSecondary = [];
  state.timer = 60;
  state.turnIndex++;
}

/**
 * Random valasztas egy tombbol - kulon fuggvenyben, hogy tesztekben
 * determinisztikus rng-t lehessen injektalni.
 */
function pickRandom(list, rng = Math.random) {
  if (list.length === 0) return null;
  return list[Math.floor(rng() * list.length)];
}

/**
 * Rendszer altal valasztott elsodleges pozicio, az ellenfel elozo lepese
 * koruli teruletbol (spec: "az ellenfel elozo lepese koruli teruleten").
 * Ha nincs meg elozo lepes (elso kor), vagy a koruli teruleten nincs szabad
 * mezo, a teljes ervenyes-elsodleges listabol valaszt.
 */
function autoPlacePrimary(state, rng = Math.random, radius = 4) {
  const validPrimary = getValidPrimary(state);
  if (validPrimary.length === 0) return null;

  const lastOpponentMove = [...state.history].reverse().find((h) => h.player !== state.currentPlayer);
  let candidates = validPrimary;

  if (lastOpponentMove) {
    const center = lastOpponentMove.primary;
    const nearby = validPrimary.filter(
      (p) => Math.abs(p.row - center.row) <= radius && Math.abs(p.col - center.col) <= radius
    );
    if (nearby.length > 0) candidates = nearby;
  }

  return pickRandom(candidates, rng);
}

function autoPlaceSecondary(state, rng = Math.random) {
  const candidates = getValidSecondary(state, state.primaryPos);
  return pickRandom(candidates, rng);
}

/**
 * Idokorlat lejarta. A fazistol fuggoen:
 *  - 'primary' fazisban: a rendszer mindket lepest megteszi (elsodleges + masodlagos)
 *  - 'secondary' fazisban: csak a masodlagos lepest teszi meg (random)
 * Visszaadja ugyanazt, amit a placeSecondary (ill. null-t, ha nem volt eleg szabad mezo).
 */
function handleTimeout(state, rng = Math.random) {
  if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };

  if (state.phase === 'primary') {
    const pos = autoPlacePrimary(state, rng);
    if (!pos) return { ok: false, error: 'no-valid-primary' };
    const primaryResult = placePrimary(state, pos.row, pos.col);
    if (!primaryResult.ok) return primaryResult;
  }

  const secPos = autoPlaceSecondary(state, rng);
  if (!secPos) return { ok: false, error: 'no-valid-secondary' };
  return placeSecondary(state, secPos.row, secPos.col);
}

/**
 * Debug konzisztencia-ellenorzo. Hibalistat ad vissza (ures = rendben).
 * debugMode-ban erdemes minden lepes utan meghivni.
 */
function validateBoard(state) {
  const errors = [];
  for (let r = 0; r < state.size; r++) {
    for (let c = 0; c < state.size; c++) {
      const f = state.board[r][c];
      if (!['empty', 'X', 'O', 'inactive'].includes(f.state)) {
        errors.push(`Ervenytelen state (${r},${c}): ${f.state}`);
      }
      if ((f.state === 'X' || f.state === 'O') && ![1, 2].includes(f.owner)) {
        errors.push(`Foglalt mezonek ervenyes owner kell (${r},${c})`);
      }
      if ((f.state === 'X' || f.state === 'O') && !['primary', 'secondary'].includes(f.role)) {
        errors.push(`Foglalt mezonek ervenyes role kell (${r},${c})`);
      }
      if ((f.state === 'empty' || f.state === 'inactive') && (f.owner !== null || f.role !== null)) {
        errors.push(`Szabad/inaktiv mezonek owner/role=null kell (${r},${c})`);
      }
      if (f.state === 'inactive') {
        const hasFreeNeighbor = neighborsOf(state.size, r, c).some((n) => state.board[n.row][n.col].state === 'empty');
        if (hasFreeNeighbor) errors.push(`Inaktiv mezonek nem lenne szabad szomszedja (${r},${c})`);
      }
    }
  }
  if (!['primary', 'secondary'].includes(state.phase)) errors.push(`Ervenytelen phase: ${state.phase}`);
  if (state.phase === 'secondary' && !state.primaryPos) errors.push('secondary fazisban primaryPos nem lehet null');
  return errors;
}

module.exports = {
  BOARD_SIZE,
  PLAYER_SYMBOLS,
  AXES,
  initBoard,
  createGameState,
  neighborsOf,
  getValidPrimary,
  getValidSecondary,
  placePrimary,
  placeSecondary,
  retractPrimary,
  checkInactivity,
  checkLine,
  checkVictory,
  getMovesBoundingBox,
  switchPlayer,
  surrender,
  tickTimer,
  handleTimeout,
  autoPlacePrimary,
  autoPlaceSecondary,
  validateBoard,
};
