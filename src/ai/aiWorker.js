'use strict';

/**
 * DiPole - AI-szamitas worker_threads "dolgozo" szala (2026-09-03, a
 * felhasznaloi keresre bevezetett aszinkron AI-szamitas resze - lasd
 * aiWorkerPool.js fenti magyarazatat az egesz mechanizmus celjarol).
 *
 * Ez a fajl KIZAROLAG worker szalkent futtathato (uj Worker(__filename) a
 * poolbol) - onmagaban a fo szalon sose toltodik be require()-rel. A
 * feladata szandekosan minimalis: a mar meglevo, tisztan szinkron
 * ai.chooseAiMove()-ot hivja, es Uzenet-alapon (postMessage) adja vissza az
 * eredmenyt. A tenyleges AI-logika (es annak sajat, egyuttmukodo
 * hatarideje - DEFAULT_TIME_BUDGET_MS/deadline, lasd ai.js) VALTOZATLAN
 * marad - ez a fajl csak a "melyik szalon fusson" kerdest oldja meg.
 *
 * FONTOS: mivel egy worker_threads Worker sajat, KULON V8-izolatumban fut
 * (sajat memoriaval, csak strukturalt-masolassal atadhato uzenetekkel a fo
 * szallal), a `state` objektum (a jatektabla allapota) es a `move`
 * visszateresi ertek is EGYSZERU, JSON-szeru adat - nincs benne fuggveny
 * vagy egyeb nem-klonozhato ertek (lasd roomManager.js/ai.js: a `rng` es
 * `weights` opciokat a hivo SOSEM adja at ezen a hataron keresztul, a
 * worker a sajat, beepitett Math.random-jat hasznalja - pontosan úgy, mint
 * korabban a fo szalon).
 */

const { parentPort } = require('worker_threads');
const ai = require('./ai');

if (!parentPort) {
  // Vedelmi hatar: ha valaki veletlenul kozvetlenul require()-elne ezt a
  // fajlt a fo szalon (nem Worker-kent inditva), azonnal es ertelmesen
  // jelezzuk a hibat, ahelyett hogy nesztelenul semmit se tenne.
  throw new Error('aiWorker.js csak worker_threads Worker szalkent futtathato (parentPort hianyzik).');
}

parentPort.on('message', (msg) => {
  const { taskId, state, options } = msg || {};
  try {
    const move = ai.chooseAiMove(state, options || {});
    parentPort.postMessage({ taskId, ok: true, move });
  } catch (err) {
    parentPort.postMessage({ taskId, ok: false, error: (err && err.message) || String(err) });
  }
});
