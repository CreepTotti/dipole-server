'use strict';

/**
 * DiPole - AI-szamitas worker-pool (2026-09-03, felhasznaloi keresre: "a
 * rendszerben az aszinkron AI-szamitas kotelezo kovetelmeny").
 *
 * ELOZMENY / MIERT KELL EZ (lasd meg ai.js DEFAULT_TIME_BUDGET_MS fenti
 * magyarazata): a szerver egyetlen Node-folyamatban, EGY szalon (a fo
 * eseményhurkon) fut - MINDEN socket.io kapcsolat kezelese (beleertve a
 * szivveres/ping-pong csomagokat is, amik nelkul a kliens "lecsatlakozottnak"
 * latszik) EZEN AZ EGY SZALON zajlik. A korabbi (2026-09-03, 1. kor) javitas
 * egy 2,5mp-es hatarido-mechanizmust vezetett be az ai.js-ben, ami egy-egy
 * DONTES teljes hosszat korlatozza - ez fontos, de ONMAGABAN NEM ELEG: meg
 * egy 2,5mp-re korlatozott, DE MEGIS SZINKRON modon (a fo szalon, blokkolva)
 * lefuttatott szamitas is 2,5mp-re megbenitja az OSSZES csatlakozast, nem
 * csak azt a partit, amelyiknek eppen lep az AI-ja. Sok, egyidejuleg
 * futo "Online AI teszt" szoba eseten (lasd roomManager.js - ott minden
 * szoba fuggetlenul, masodpercenkent probal AI-t lepetni) ezek a blokkolasok
 * OSSZEADODNAK, es a szerver a felhasznalo altal elvart terheles ("nehany
 * szaz egyideju AI-meccs") alatt tenylegesen hasznalhatatlanna valna MINDEN
 * csatlakozott felhasznalo szamara, nem csak az AI-jatekosoknak.
 *
 * MEGOLDAS (ezt a fajlt): a tenyleges chooseAiMove() hivast Node
 * worker_threads Worker-szalak egy fix meretu "keszlet"-ere (pool) toljuk
 * ki - igy a fo szal (es annak socket.io-hurka) SOHA nem blokkolodik AI-
 * szamitas miatt, meg akkor sem, ha egyszerre sok szoba is lepésre var.
 * Ez a "Tier 1" megoldas (a felhasznalonak bemutatott 3 lehetoseg kozul):
 * NEM novel nyers CPU-kapacitast (a parhuzamosan TENYLEGESEN vegzett
 * szamitasok szama a szerver valodi magszamaig skalazodik, a tobbi feladat
 * sorba all), DE megszunteti a "mindenki lecsatlakozik" tunetet, es a
 * felhasznalo altal kifejezetten kizart uj infrastruktura (Redis, kulon
 * szolgaltatasok) nelkul, egyetlen Render szolgaltatason belul mukodik -
 * lasd a felhasznaloval egyeztetett hatarokat (2026-09-03-i beszelgetes).
 *
 * A meglevo, ai.js-beli hatarido-mechanizmus VALTOZATLANUL fontos marad:
 * az korlatozza, hogy egy-egy worker-szal MEDDIG foglalja el a "helyet" a
 * poolban (egyuttmukodo modon, a szamitason belulrol). Az itt bevezetett
 * HANG_MARGIN_MS egy TOVABBI, KIVULROL ervenyesitett biztonsagi halo arra
 * a (varhatoan sosem bekovetkezo) esetre, ha egy worker mégis vegtelen
 * ciklusba kerulne (pl. egy jovobeli hiba miatt) - enelkul egy ilyen worker
 * orokre "lefoglalva" tartana a pool egy helyet.
 */

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { DEFAULT_TIME_BUDGET_MS } = require('./ai');

const WORKER_SCRIPT = path.join(__dirname, 'aiWorker.js');

// Lasd a fenti fajl-szintu magyarazatot: ez a "vegso" biztonsagi hatarido
// (egyuttmukodo hatarido + bosegs margo), nem az AI tenyleges gondolkodasi
// ideje - annak a hatarat tovabbra is az ai.js DEFAULT_TIME_BUDGET_MS
// (illetve az explicit megadott timeBudgetMs) adja.
const HANG_MARGIN_MS = 8000;

class AiWorkerPool {
  constructor({ size } = {}) {
    const envSize = Number(process.env.AI_WORKER_POOL_SIZE);
    this.size =
      size || (Number.isFinite(envSize) && envSize > 0 ? envSize : Math.max(1, os.cpus().length));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map(); // Worker -> { taskId, resolve, reject, timer }
    this.nextTaskId = 1;
    this.closed = false;
    for (let i = 0; i < this.size; i++) this._spawnWorker();
  }

  _spawnWorker() {
    const worker = new Worker(WORKER_SCRIPT);
    // A worker-szalaknak sose kell eleve elettben tartaniuk a Node-folyamatot
    // - a fo szal socket.io-kiszolgalasa (ill. a teszt-scriptek sajat
    // process.exit()-je) donti el, mikor all le a folyamat, nem az, hogy
    // eppen var-e egy uresjarat worker.
    worker.unref();
    worker.on('message', (msg) => this._onWorkerMessage(worker, msg));
    worker.on('error', (err) => this._onWorkerFailure(worker, err));
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) this._onWorkerFailure(worker, new Error(`AI worker vaartlanul leallt (kod: ${code})`));
    });
    this.workers.push(worker);
    this.idle.push(worker);
    return worker;
  }

  _onWorkerMessage(worker, msg) {
    const task = this.pending.get(worker);
    if (!task || !msg || task.taskId !== msg.taskId) return; // elavult/nem vart valasz - figyelmen kivul
    clearTimeout(task.timer);
    this.pending.delete(worker);
    if (!this.closed) this.idle.push(worker);
    if (msg.ok) task.resolve(msg.move);
    else task.reject(new Error(msg.error || 'ismeretlen AI worker hiba'));
    this._pump();
  }

  _onWorkerFailure(worker, err) {
    const task = this.pending.get(worker);
    if (task) {
      clearTimeout(task.timer);
      this.pending.delete(worker);
      task.reject(err);
    }
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    try {
      worker.terminate();
    } catch (e) {
      // mar amugy is leallt/leallo felben van - nincs teendo
    }
    if (!this.closed) this._spawnWorker();
    this._pump();
  }

  _pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      this._dispatch(worker, job);
    }
  }

  _dispatch(worker, job) {
    const taskId = this.nextTaskId++;
    const timeBudgetMs = (job.options && job.options.timeBudgetMs) ?? DEFAULT_TIME_BUDGET_MS;
    const timer = setTimeout(() => {
      // Lasd fenti HANG_MARGIN_MS magyarazat - ez csak akkor sul el, ha a
      // worker az egyuttmukodo hatarideje ELLENERE sem valaszolt idoben.
      this._onWorkerFailure(worker, new Error('AI worker nem valaszolt idoben (lefagyasnak feltetelezve)'));
    }, timeBudgetMs + HANG_MARGIN_MS);
    this.pending.set(worker, { taskId, resolve: job.resolve, reject: job.reject, timer });
    worker.postMessage({ taskId, state: job.state, options: job.options });
  }

  /**
   * Egy AI-dontes kiszamitasat keri a pooltol. Visszaadott Promise a
   * chooseAiMove() eredetivel EGYEZO alaku `move` ertekkel teljesul (vagy
   * `null`-lal, ha az AI-nak nincs lepese - lasd ai.js chooseAiMove), illetve
   * elutasitodik, ha a szamitas maga hibazna (worker-hiba/lefagyas - ezt a
   * hivo felnek ugyanugy kell kezelnie, mint egy vaaratlan kivetelt).
   */
  computeMove(state, options) {
    if (this.closed) return Promise.reject(new Error('AI worker pool mar le van allitva'));
    return new Promise((resolve, reject) => {
      const job = { state, options, resolve, reject };
      if (this.idle.length > 0) {
        const worker = this.idle.pop();
        this._dispatch(worker, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  /** Osszes worker-szal leallitasa - szerver-leallaskor/tesztek vegen hivando. */
  shutdown() {
    this.closed = true;
    for (const [, task] of this.pending) {
      clearTimeout(task.timer);
      task.reject(new Error('AI worker pool leallitva a szamitas befejezese elott'));
    }
    this.pending.clear();
    this.queue.forEach((job) => job.reject(new Error('AI worker pool leallitva a szamitas megkezdese elott')));
    this.queue = [];
    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (e) {
        // mar amugy is leallt - nincs teendo
      }
    }
    this.workers = [];
    this.idle = [];
  }
}

module.exports = { AiWorkerPool, HANG_MARGIN_MS };
