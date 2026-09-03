'use strict';

/**
 * DiPole - szerveroldali meccs-/szoba-kezeles (F1 vaz)
 *
 * A tenyleges jatekszabaly-logikat NEM itt, hanem a mar meglevo, kliens-fuggetlen
 * motorban (engine/board.js) tartjuk - ez a modul csak a "ki kivel jatszik,
 * kinek kell-e lepnie, mikor jar le az ido" organizacios reteg korule.
 *
 * FONTOS: ez szandekosan egyetlen Node-folyamat memoriajaban tartja az allapotot
 * (nincs meg adatbazis/perzisztencia - ez kesobbi F1 alfeladat). Ujrainditaskor
 * minden folyamatban levo meccs elveszik. Ez a legelso, tesztelheto vaz.
 */

const crypto = require('crypto');
const engine = require('./engine/board.js');
const ai = require('./ai/ai.js');

const TURN_SECONDS = 60;
const MAX_MISSED_TURNS = 3;
const AI_DIFFICULTY = 'easy';
// 2026-08-31 (felhasznaloi keresre): kulon "Online AI teszt" jatekmod - egy
// KULON matchmaking-sorban var (lasd waitingByMode), es a belole letrejovo
// szobak ezekkel a (a normal online modtol teljesen fuggetlen) beallitasokkal
// futnak - lasd joinQueue. A cel: gyorsan, fejlesztoi/tesztelesi celra
// eljuttatni a partit odaig, hogy mindket oldalt egy-egy ERŐS AI jatssza -
// lasd MAX_MISSED_TURNS fent (ez valtozatlan, 3 marad mindket modban).
const AI_TEST_TURN_SECONDS = 1;
const AI_TEST_AI_DIFFICULTY = 'hard';
// 2026-08-31 (felhasznaloi visszajelzes alapjan, elso elesben tesztelt online
// partibol): a lancolt AI-lepesek (lasd _maybeAutoPlayAiTurns) korabban
// TELJESEN azonnal, az ora barmilyen lathato pergese nelkul tortentek - ez
// szandekos volt (hogy ne kelljen egy teljes percet varni), de a felhasznalo
// visszajelzese szerint zavaro volt latni, hogy az orak "nem szamolnak". Ez a
// mesterseges (dontesen MAR TULJUTOTT, csak a megjelenitest kesleltetŐ)
// varakozas oldja ezt fel: az AI a lepeset valojaban ugyanugy AZONNAL
// kiszamolja, csak a kozlese/megjelenitese kesik ennyit - igy az orak
// lathatoan pergenek nehany masodpercet, de nem kell egy teljes kort varni.
const AI_MOVE_DELAY_MS = 2500;

class RoomManager {
  constructor(io, { turnSeconds = TURN_SECONDS, aiMoveDelayMs = AI_MOVE_DELAY_MS } = {}) {
    this.io = io;
    this.turnSeconds = turnSeconds;
    this.aiMoveDelayMs = aiMoveDelayMs;
    // 2026-08-31 (felhasznaloi visszajelzes alapjan - "x/3 auto-lepes" es "AI
    // - (szint)" kliens-oldali kijelzes): a szerveroldali AI-nehezseg
    // publikusan is olvashato property-kent, hogy a server.js (match:start/
    // rejoin kiuldesekor) es a kliens (App.js) is ugyanazt a forras-erteket
    // lassa, ne kulon hardcode-olt masolatot.
    this.aiDifficulty = AI_DIFFICULTY;
    // Ket FUGGETLEN matchmaking-sor: a normal "online" es a kulon "ai-test"
    // ("Online AI teszt") sor SOHA nem parosodik ossze egymassal - lasd
    // joinQueue. Korabban egyetlen `this.waiting` mezo volt csak.
    this.waitingByMode = { online: null, 'ai-test': null }; // mode -> { socketId, displayName } | null
    this.rooms = new Map(); // roomId -> RoomState
    this.socketToRoom = new Map(); // socketId -> roomId
    this.tokenToRoom = new Map(); // sessionToken -> { roomId, playerNumber }
  }

  /**
   * Mindket jatekos aktualis kihagyott-kor-szamlaloja - a kliens ebbol
   * jeleníti meg az "x/3" auto-lepes jelzest (lasd App.js PlayerPanel
   * `missedTurns` propja). Csak online modban ertelmezett fogalom.
   */
  getMissedTurnsSnapshot(room) {
    return {
      1: room.players[1] ? room.players[1].missedTurns : 0,
      2: room.players[2] ? room.players[2].missedTurns : 0,
    };
  }

  /**
   * Belepes a matchmaking sorba. Ha mar var valaki UGYANEBBEN a sorban
   * (`mode`), azonnal parositunk - a ket sor ('online' es 'ai-test')
   * teljesen fuggetlen, egymassal SOHA nem parosodnak (lasd waitingByMode).
   */
  joinQueue(socket, displayName, mode) {
    const normalizedMode = mode === 'ai-test' ? 'ai-test' : 'online';
    if (this.socketToRoom.has(socket.id)) {
      return { ok: false, error: 'already-in-match' };
    }

    const waitingSlot = this.waitingByMode[normalizedMode];
    if (!waitingSlot) {
      this.waitingByMode[normalizedMode] = { socketId: socket.id, displayName: displayName || 'Jatekos 1' };
      return { ok: true, status: 'waiting' };
    }

    if (waitingSlot.socketId === socket.id) {
      return { ok: false, error: 'already-waiting' };
    }

    const p1 = waitingSlot;
    this.waitingByMode[normalizedMode] = null;
    const roomId = crypto.randomUUID();
    const isTestMode = normalizedMode === 'ai-test';

    const state = engine.createGameState();
    const room = {
      roomId,
      mode: normalizedMode,
      testMode: isTestMode,
      // 2026-08-31 (felhasznaloi keresre, "Online AI teszt"): ezek a
      // beallitasok SZOBANKENT rogzulnek a letrehozaskor, fuggetlenul a
      // szerver egyeb (normal online) szobaitol - lasd _startTurnTimer/
      // _onTick/_maybeAutoPlayAiTurns, amik mar `room.turnSeconds`/
      // `room.aiDifficulty`-t hasznaljak `this.turnSeconds`/`this.aiDifficulty`
      // helyett.
      turnSeconds: isTestMode ? AI_TEST_TURN_SECONDS : this.turnSeconds,
      aiDifficulty: isTestMode ? AI_TEST_AI_DIFFICULTY : this.aiDifficulty,
      state,
      players: {
        1: {
          socketId: p1.socketId,
          displayName: p1.displayName,
          sessionToken: crypto.randomUUID(),
          missedTurns: 0,
          aiControlled: false,
          disconnected: false,
        },
        2: {
          socketId: socket.id,
          displayName: displayName || 'Jatekos 2',
          sessionToken: crypto.randomUUID(),
          missedTurns: 0,
          aiControlled: false,
          disconnected: false,
        },
      },
      timerHandle: null,
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    this.socketToRoom.set(p1.socketId, roomId);
    this.socketToRoom.set(socket.id, roomId);
    this.tokenToRoom.set(room.players[1].sessionToken, { roomId, playerNumber: 1 });
    this.tokenToRoom.set(room.players[2].sessionToken, { roomId, playerNumber: 2 });

    this._startTurnTimer(room);
    return { ok: true, status: 'matched', room };
  }

  /**
   * Ujracsatlakozas egy korabban kapott sessionToken alapjan. Csak akkor
   * sikeres, ha a token ismert ES a meccs meg 'playing' allapotban van
   * (ha idokozben veget ert, a tokent mar amugy is toroltuk - lasd _endMatch).
   */
  rejoin(socket, sessionToken) {
    const entry = sessionToken ? this.tokenToRoom.get(sessionToken) : null;
    if (!entry) return { ok: false, error: 'unknown-session' };
    const room = this.rooms.get(entry.roomId);
    if (!room || room.state.status !== 'playing') {
      this.tokenToRoom.delete(sessionToken);
      return { ok: false, error: 'match-ended' };
    }

    const { playerNumber } = entry;
    const player = room.players[playerNumber];

    // Ha a gep mar atvette ezt az oldalt (3 kihagyott kor), a token mar
    // ervenytelen kellene legyen (lasd _evictAiControlledPlayer - onnan
    // szandekosan toroljuk), de vedelmi retegkent itt is ellenorizzuk: ilyen
    // jatekos SEM aktiv reszvevokent, SEM nezokent nem terhet vissza ehhez a
    // partihoz - kikerul a "lobbyba" (a hivo/kliens friss sorbaallast indit).
    if (player.aiControlled) {
      this.tokenToRoom.delete(sessionToken);
      return { ok: false, error: 'ai-took-over' };
    }

    const oldSocketId = player.socketId;

    // Ha a regi socketId meg mindig masra mutatna a terkepben, takaritsunk.
    if (oldSocketId && this.socketToRoom.get(oldSocketId) === room.roomId) {
      this.socketToRoom.delete(oldSocketId);
    }

    player.socketId = socket.id;
    player.disconnected = false;
    this.socketToRoom.set(socket.id, room.roomId);

    return { ok: true, room, playerNumber, aiControlled: player.aiControlled };
  }

  getRoomBySocket(socketId) {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  playerNumberOf(room, socketId) {
    if (room.players[1].socketId === socketId) return 1;
    if (room.players[2].socketId === socketId) return 2;
    return null;
  }

  /** Kozponti belepesi pont minden lepes-tipushoz - a hivo kod (server.js) ezt hasznalja. */
  applyMove(room, playerNumber, action, payload) {
    const { state } = room;

    if (state.status !== 'playing') return { ok: false, error: 'game-not-playing' };
    // Vedelmi reteg: ha ezt a jatekost mar atvette a gep, EGYETLEN lepest
    // (meg a feladast/resign-t sem) fogadunk el tole tobbe - lasd
    // _evictAiControlledPlayer: a gyakorlatban ez a kliens mar amugy sem
    // erheti el a szobat (kikerult belole), de ez a plusz reteg akkor is
    // vedelmet ad, ha valamiert megis idejutna egy keses/regi kerelem.
    // Szandekos: az AI-atvett jatszma kimenetele (pl. a masik jatekos
    // "AI-jatszma" statisztikaja/jutalma) nem befolyasolhato tobbe attol,
    // akit ledobott a halozat, vagy aki nem lepett idoben.
    if (room.players[playerNumber] && room.players[playerNumber].aiControlled) {
      return { ok: false, error: 'player-is-ai-controlled' };
    }
    // A korellenorzes csak a tenyleges lepesekre (primary/secondary/retract)
    // vonatkozik - feladni (resign) barmelyik felnek barmikor lehet, fuggetlenul
    // attol, ki van eppen soron (kulonben az eppen NEM soron levo fel egyaltalan
    // nem tudna feladni a partit).
    if (action !== 'resign' && playerNumber !== state.currentPlayer) {
      return { ok: false, error: 'not-your-turn' };
    }

    let result;
    if (action === 'primary') {
      result = engine.placePrimary(state, payload.row, payload.col);
    } else if (action === 'secondary') {
      result = engine.placeSecondary(state, payload.row, payload.col);
    } else if (action === 'retract') {
      result = engine.retractPrimary(state);
    } else if (action === 'resign') {
      result = engine.surrender(state, playerNumber);
    } else {
      return { ok: false, error: 'unknown-action' };
    }

    if (result.ok) {
      // Sikeres lepes utan a lepo jatekos kihagyott-kor-szamlaloja nullazodik
      // (o eppen most lepett, tehat nem hagyott ki semmit).
      if (room.players[playerNumber]) room.players[playerNumber].missedTurns = 0;
      // FONTOS (2026-08-31, felhasznaloi visszajelzes alapjan): az ora
      // ujrainditasa (es az esetleges lancolt AI-lepes ellenorzese) KIZAROLAG
      // akkor tortenhet, ha a kor TENYLEGESEN atvaltott a masik jatekosra -
      // ez csakis a lepespart LEZARO 'secondary' akcio utan all fenn (az
      // engine ilyenkor mar meghivta a switchPlayer-t). Egy onmagaban levo
      // 'primary' lepes (meg csak a fele lepespar!) vagy annak visszavonasa
      // ('retract') NEM jelent korvaltast - a jatekos meg mindig ugyanabban
      // a korben van. Korabban ITT FELTETEL NELKUL futott le az ora-ujrainditas
      // minden sikeres akcio utan, ami azt a (nem szandekolt) hibat okozta,
      // hogy mar a puszta elsodleges lepes lerakasa is visszaallitotta az
      // orat a teljes koridore - a jatekos igy a masodlagos lepesre effektive
      // duplajat idot kapott. A retractPrimary() az engine-ben kifejezetten
      // szandekosan NEM allitja vissza az orat ("ne lehessen idot lopni") -
      // ezt a szandekot itt korabban felulirtuk.
      if (state.status === 'playing' && action === 'secondary') {
        this._resetTurnTimer(room);
        // Ha az uj soron levo jatekost mar korabban atvette a gep, azonnal
        // (nem varva az orara) lepjen. Ezt kovetkezo tick-re (setImmediate)
        // halasztjuk, hogy a hivo (server.js) elobb kikuldhesse a SAJAT
        // (emberi lepesrol szolo) state:update esemenyet - igy az esemenyek
        // sorrendje a vezetekene a valos tortenessel egyezik.
        setImmediate(() => this._maybeAutoPlayAiTurns(room));
      }
      // Ha a lepes veget vetette a meccsnek, a match:end kikuldeset (mint
      // eddig is) a hivo (server.js) vegzi a visszaadott result/room.state
      // alapjan - itt nem duplikaljuk.
    }

    return result;
  }

  /**
   * A jatekos kilepesekor (disconnect) ertesitjuk az ellenfelet, es
   * megjeloljuk a jatekost 'disconnected'-kent (az ujracsatlakozas addig
   * lehetseges, amig a meccs veget nem er - lasd rejoin()). A szobat magat
   * nem zarjuk be es a tokent sem toroljuk itt.
   */
  handleDisconnect(socketId) {
    for (const modeKey of Object.keys(this.waitingByMode)) {
      if (this.waitingByMode[modeKey] && this.waitingByMode[modeKey].socketId === socketId) {
        this.waitingByMode[modeKey] = null;
        return null;
      }
    }
    const room = this.getRoomBySocket(socketId);
    if (!room) return null;
    const playerNumber = this.playerNumberOf(room, socketId);
    if (playerNumber && room.players[playerNumber]) {
      room.players[playerNumber].disconnected = true;
    }
    return room;
  }

  _startTurnTimer(room) {
    room.state.timer = room.turnSeconds;
    room.timerHandle = setInterval(() => this._onTick(room), 1000);
  }

  _resetTurnTimer(room) {
    room.state.timer = room.turnSeconds;
  }

  _onTick(room) {
    if (room.state.status !== 'playing') {
      clearInterval(room.timerHandle);
      return;
    }
    const remaining = engine.tickTimer(room.state);
    if (remaining > 0) {
      this.io.to(room.roomId).emit('timer:tick', { timer: remaining });
      return;
    }

    const state = room.state;
    const expiredPlayerNumber = state.currentPlayer;
    const expiredPlayer = room.players[expiredPlayerNumber];
    const phaseAtExpiry = state.phase;

    if (expiredPlayer && !expiredPlayer.aiControlled) {
      // A kihagyott-kor-szamlalot SZANDEKOSAN csak addig noveljuk, amig a
      // jatekos meg NEM AI-vezerelt - miutan atvette a gep, ez a szamlalo
      // mar nem jelent semmit (a szamlalasnak a "3 kihagyott kor -> atvetel"
      // dontes volt a celja). 2026-08-31 (az "Online AI teszt" mod
      // bevezetesekor feltart, korabban rejtve maradt aprosag): korabban ez
      // FELTETEL NELKUL, minden lejart kornel novekedett, meg akkor is, ha a
      // jatekos mar regen AI-vezerelt volt - normal (60mp-es) modban ez
      // ritkan tunt fel (egy AI-atvett oldal nem sok tovabbi kort er meg egy
      // 60mp-es partiban), de az uj, 1mp-es koridovel futo teszt-modban
      // percek alatt ertelmetlenul magasra (pl. "47/3") futott volna fel a
      // kliens "⏭ x/3" kijelzese - lasd App.js PlayerPanel.
      expiredPlayer.missedTurns += 1;
      if (expiredPlayer.missedTurns >= MAX_MISSED_TURNS) {
        expiredPlayer.aiControlled = true;
        if (!room.testMode) {
          // FONTOS (csak NORMAL online modban): az atvett jatekost AZONNAL,
          // teljesen ki kell zarni a partibol - meg nezokent (spectator) sem
          // terhet vissza, es semmit nem kattinthat (meg a feladast sem). Ez
          // azert szandekos ilyen szigoru, mert a masik jatekos szamara az
          // AI-jatszma gyozelme (kesobbi funkciokent) jutalmat/statisztikat
          // old fel - ezt nem akadalyozhatja meg az, akit ledobott a halozat
          // vagy nem lepett idoben. Ezert a kiutasitas MEGELOZI a
          // szoba-szintu ertesitest, hogy o mar ne is kapja meg azt.
          this._evictAiControlledPlayer(room, expiredPlayerNumber);
        }
        // 2026-08-31 (felhasznaloi keresre, "Online AI teszt"): teszt modban
        // a fenti kiutasitas ELMARAD, tehat az erintett jatekos szocketje
        // BENNMARAD a szobaban - ez az esemeny ekkor MINDKET oldalhoz eljut
        // (a sajat magat erinto atvetelrol is ertesul, lasd App.js
        // `player:ai-takeover` kezelojet), es o maga tovabbra is nezokent
        // (spectator) folytathatja a mar folyamatban levo (vagy hamarosan
        // mindket oldalon gep altal jatszott) partit.
        this.io.to(room.roomId).emit('player:ai-takeover', {
          playerNumber: expiredPlayerNumber,
          displayName: expiredPlayer.displayName,
          aiDifficulty: room.aiDifficulty,
        });
      }
    }

    // Lejart az ido. Ha a lejaro fel mar AI-vezerelt (vagy eppen most valt
    // azza) ES a primary fazisban jart le az ido (tehat egy teljes
    // lepespart kell valasztani), az AI dont a random helyett - igy a
    // gep altal atvett jatekos nem "vaktaban" jatszik tovabb. Masodlagos
    // fazisban lejaro ido (ritka szelso eset - az elsodleges mar lerakva)
    // egyszerusitesbol marad a regi, veletlenszeru viselkedes.
    let result;
    let usedAiChoice = false;
    if (expiredPlayer && expiredPlayer.aiControlled && phaseAtExpiry === 'primary') {
      const move = ai.chooseAiMove(state, { difficulty: room.aiDifficulty });
      if (move && move.primary && move.secondary) {
        result = this._applyPair(state, move.primary, move.secondary);
        usedAiChoice = true;
      }
    }
    if (!usedAiChoice) {
      result = engine.handleTimeout(state);
    }

    // 2026-09-03 (az "Online AI teszt" mod hibakeresesekor feltart, korabban
    // rejtve maradt hiba): a fenti handleTimeout/_applyPair mar meghivta az
    // engine belso switchPlayer()-jet, ami a `state.timer`-t egy SAJAT,
    // fixen bedrotozott 60-ra allitja (ez az engine altalanos, szoba-fuggetlen
    // alapertelmezese - lasd engine/board.js switchPlayer). Normal (60mp-es)
    // modban ez veletlenul egybeesik a szoba tenyleges koridovel, tehat
    // eszrevehetetlen volt - DE az uj, 1mp-es "Online AI teszt" modban ez azt
    // okozta, hogy minden egyes lejart kor utan a klienseknek kikuldott
    // 'state:update' PILLANATNYILAG (tevesen) "60"-at mutatott a tenyleges
    // 1 helyett, egeszen a legkozelebbi 'timer:tick'-ig - ami 1mp-es
    // koridonel SOHA nem jott meg (minden egyes tick azonnal ujra lejar, egy
    // ujabb 'state:update'-et valtva ki, ugyanezzel a hibaval). A javitas:
    // a szoba-specifikus koridot MAR AZ EMITTALAS ELOTT visszaallitjuk, hogy
    // a kliensek altal latott `state.timer` mindig a tenyleges (`room.
    // turnSeconds`) erteket tukrozze, ne az engine altalanos alapertelmezeset.
    if (state.status === 'playing') {
      this._resetTurnTimer(room);
    }

    this.io.to(room.roomId).emit('state:update', {
      state: room.state,
      cause: 'timeout',
      result,
      missedTurns: this.getMissedTurnsSnapshot(room),
    });

    if (state.status !== 'playing') {
      this._endMatch(room);
      return;
    }
    // Ha az idokorlat lejarta utan soron kovetkezo fel is mar AI-vezerelt
    // (pl. mindket oldal atadva a gepnek), a lanc azonnal folytatodjon.
    this._maybeAutoPlayAiTurns(room);
  }

  /**
   * Egy jatekost, aki eppen most valt AI-vezereltte (3 kihagyott kor), teljesen
   * kizar a mar folyamatban levo partibol: a sessionToken-je azonnal
   * ervenytelenne valik (a rejoin() ezutan mindig elutasitja - meg
   * nezokent/spectator-kent sem terhet vissza), es ha eppen csatlakozva van,
   * a szobabol is kikerul (leave), a socketToRoom terkepbol torlodik (innentol
   * BARMILYEN lepese/kerese 'not-in-a-match'-kent utasitodik el), es egy
   * celzott 'kicked:ai-takeover' esemenyt kap, majd (kovetkezo tick-re
   * halasztva, hogy az esemeny biztosan celba erjen) a szerver bontja is a
   * kapcsolatot. Szandekos: az AI-jatszma kimenetelet (pl. a masik jatekos
   * jovobeli "AI-jatszma"-jutalma/statisztikaja) nem befolyasolhatja tobbe
   * az, akit ledobott a halozat vagy nem lepett idoben.
   */
  _evictAiControlledPlayer(room, playerNumber) {
    const player = room.players[playerNumber];
    if (!player) return;

    // FONTOS: a sessionToken bejegyzeset SZANDEKOSAN nem toroljuk itt ki a
    // tokenToRoom-bol - igy egy kesobbi match:rejoin-probalkozas eljut a
    // rejoin() metodus aiControlled-ellenorzeseig, ami az ertelmesebb
    // 'ai-took-over' hibat adja vissza (nem a generikus 'unknown-session'-t),
    // es CSAK OTT (a tenyleges probalkozaskor) torli a tokent.

    const socketId = player.socketId;
    const sock = socketId ? this.io.sockets.sockets.get(socketId) : null;

    if (socketId && this.socketToRoom.get(socketId) === room.roomId) {
      this.socketToRoom.delete(socketId);
    }

    if (sock) {
      sock.emit('kicked:ai-takeover', { playerNumber, displayName: player.displayName });
      sock.leave(room.roomId);
      setImmediate(() => {
        if (sock.connected) sock.disconnect(true);
      });
    }
  }

  /** Egy {primary, secondary} lepespar alkalmazasa (AI-dontes vegrehajtasahoz). */
  _applyPair(state, primary, secondary) {
    const primaryResult = engine.placePrimary(state, primary.row, primary.col);
    if (!primaryResult.ok) return primaryResult;
    return engine.placeSecondary(state, secondary.row, secondary.col);
  }

  /**
   * Amig a soron levo jatekos AI-vezerelt es a meccs meg tart, lejatssza az
   * AI lepeset (nem varva a teljes korido lejartat), es kozvetiti az
   * eredmenyt - igy ha mindket oldalt atvette mar a gep, a partit nem kell
   * vegigvarni idokorlatonkent. A lepes megjelenitese elott (a dontes maga
   * mar kesz) `aiMoveDelayMs`-nyit szandekosan var - lasd AI_MOVE_DELAY_MS
   * fenti magyarazata -, hogy az ora lathatoan is pergjen egy kicsit, ne
   * tunjon ugy, mintha "nem szamolna". Tesztekben `aiMoveDelayMs: 0`-val
   * hivhato, ekkor teljesen szinkron/azonnal marad (a korabbi viselkedes).
   */
  _maybeAutoPlayAiTurns(room, guard = 0) {
    // 2026-08-31 (felhasznaloi keresre, "Online AI teszt"): teszt modban ez
    // a lanc-optimalizacio SZANDEKOSAN nem fut - az itt hasznalt
    // `aiMoveDelayMs`-es kesleltetes fuggetlen a szoba sajat, nagyon rovid
    // (1mp-es) koridojatol, es a ket idozito versenyezne egymassal (ugyanazt
    // a lepest ketszer probalna meg alkalmazni). Teszt modban emiatt
    // KIZAROLAG az _onTick sajat, koridohoz kotott utja jatssza le az AI
    // lepeseit - ez egyben pontosan a kivant, "vegig kovetheto" (kb.
    // masodpercenkent egy lepes) temp ot is adja az AI-AI osszecsapashoz,
    // nem egy szempillantas alatt lezajlo, kovethetetlen lancot.
    if (room.testMode) return;

    const state = room.state;
    if (
      state.status !== 'playing' ||
      !room.players[state.currentPlayer] ||
      !room.players[state.currentPlayer].aiControlled ||
      guard >= 200
    ) {
      return;
    }

    const playAndContinue = () => {
      // A kesleltetes alatt a meccs allapota megvaltozhatott (pl. az ellenfel
      // barmikor feladhatja a partit, fuggetlenul attol, ki van soron - lasd
      // applyMove resign-kivetele) - ekkor itt mar nincs mit tenni.
      const current = room.players[room.state.currentPlayer];
      if (room.state.status !== 'playing' || !current || !current.aiControlled) return;

      const move = ai.chooseAiMove(state, { difficulty: room.aiDifficulty });
      let result;
      if (move && move.primary && move.secondary) {
        result = this._applyPair(state, move.primary, move.secondary);
      } else {
        result = engine.handleTimeout(state);
      }
      if (!result || !result.ok) return; // nem tortenhet meg 'playing' allapotban - biztonsagi halo

      // Lasd a fenti (2026-09-03) megjegyzest az _onTick-ben - ugyanaz az
      // engine switchPlayer() altal okozott, korabban rejtve maradt hiba:
      // az ora-ujrainditasnak MEG AZ EMITTALAS ELOTT meg kell tortennie.
      if (state.status === 'playing') {
        this._resetTurnTimer(room);
      }

      this.io.to(room.roomId).emit('state:update', {
        state: room.state,
        cause: 'ai-move',
        result,
        missedTurns: this.getMissedTurnsSnapshot(room),
      });
      if (state.status !== 'playing') {
        this._endMatch(room);
        return;
      }
      this._maybeAutoPlayAiTurns(room, guard + 1);
    };

    if (this.aiMoveDelayMs > 0) {
      setTimeout(playAndContinue, this.aiMoveDelayMs);
    } else {
      playAndContinue();
    }
  }

  /**
   * Meccs veget kozponti helyen kezeli: broadcast, idozito leallitasa, ES
   * TELJES takaritas (sessionToken-ek, socketToRoom-terkep, maga a szoba is
   * torlodik a `rooms` terkepbol). 2026-08-31 (felhasznaloi visszajelzes
   * alapjan, "mi tortenik, ha mindket jatekost kidobja a rendszer" kerdesre
   * vizsgalodva): korabban ez a fuggveny CSAK a sessionToken-eket torolte -
   * a szoba maga es a socketToRoom-bejegyzesek soha, EGYETLEN veget ert
   * meccsnel sem torlodtek, igy egy hosszan futo szerveren (pl. ingyenes
   * Render-instance-on) minden lejatszott (vagy AI-vs-AI-ra fajult, majd
   * vegigjatszodott) parti vegleg memoriaban maradt - lassu, de valodi
   * memoriaszivargas. Mostantol MINDEN meccs-lezarasi utvonal (idokorlat,
   * lancolt AI-lepes, ES egy ember sajat lepese altal okozott gyozelem/
   * dontetlen/feladas is - lasd applyMove/server.js) ezen a kozponti ponton
   * megy at, ugyanugy, mint a korabban is csak itt hasznalt destroyRoom().
   */
  _endMatch(room) {
    if (room.timerHandle) {
      clearInterval(room.timerHandle);
      room.timerHandle = null;
    }
    this.io.to(room.roomId).emit('match:end', {
      status: room.state.status,
      winner: room.state.winner,
    });
    for (const pNum of [1, 2]) {
      const p = room.players[pNum];
      if (!p) continue;
      if (p.sessionToken) this.tokenToRoom.delete(p.sessionToken);
      if (p.socketId && this.socketToRoom.get(p.socketId) === room.roomId) {
        this.socketToRoom.delete(p.socketId);
      }
    }
    this.rooms.delete(room.roomId);
  }

  /**
   * Publikus wrapper az _endMatch korul - ezt hivja a server.js akkor, ha egy
   * ember altal kezdemenyezett lepes (gyozelem/dontetlen/feladas) veget vetett
   * a meccsnek, MIUTAN mar kikuldte a sajat state:update esemenyet (fontos a
   * sorrend: a kliens eloszor a vegso allapotot lassa, utana a match:end-et -
   * ugyanez a sorrend, mint az idokorlat- es AI-lancolt lezarasi utvonalon).
   */
  endMatch(room) {
    this._endMatch(room);
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.timerHandle) clearInterval(room.timerHandle);
    this.socketToRoom.delete(room.players[1].socketId);
    this.socketToRoom.delete(room.players[2].socketId);
    for (const pNum of [1, 2]) {
      const p = room.players[pNum];
      if (p && p.sessionToken) this.tokenToRoom.delete(p.sessionToken);
    }
    this.rooms.delete(roomId);
  }
}

module.exports = { RoomManager, TURN_SECONDS };
