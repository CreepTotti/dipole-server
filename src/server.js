'use strict';

/**
 * DiPole - multiplayer szerver belepesi pont (F1 vaz)
 *
 * Ez a legelso, tesztelheto reteg: WebSocket (Socket.io) alapu 1v1 matchmaking
 * es szerveroldali, hiteles lepesvalidacio a mar meglevo motorra (engine/board.js)
 * epitve. Meg NINCS benne: fiok/azonositas, adatbazis/perzisztencia, ujracsatlakozas
 * (ezek a F1 kesobbi alfeladatai - lasd a Roadmap F1 kartyajat).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const { RoomManager } = require('./roomManager');

function createServer({
  port = 4000,
  corsOrigin = '*',
  turnSeconds,
  aiMoveDelayMs,
  tlsKeyPath,
  tlsCertPath,
  pingInterval,
  pingTimeout,
} = {}) {
  let httpServer;
  if (tlsKeyPath && tlsCertPath && fs.existsSync(tlsKeyPath) && fs.existsSync(tlsCertPath)) {
    httpServer = https.createServer({
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath),
    });
    // eslint-disable-next-line no-console
    console.log('TLS tanusitvany betoltve, titkositott (wss) mod aktiv.');
  } else {
    httpServer = http.createServer();
  }
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    // Opcionalis, csak tesztekhez: rovidebb szivveres-idozites, hogy egy
    // szimulalt halozat-kimaradas gyorsabban eszlelheto legyen (production-ban
    // nincs megadva, marad a socket.io alapertelmezese).
    ...(pingInterval ? { pingInterval } : {}),
    ...(pingTimeout ? { pingTimeout } : {}),
  });

  const rooms = new RoomManager(io, {
    ...(turnSeconds !== undefined ? { turnSeconds } : {}),
    ...(aiMoveDelayMs !== undefined ? { aiMoveDelayMs } : {}),
  });

  io.on('connection', (socket) => {
    socket.on('queue:join', ({ displayName } = {}) => {
      const result = rooms.joinQueue(socket, displayName);
      if (!result.ok) {
        socket.emit('queue:error', { error: result.error });
        return;
      }
      if (result.status === 'waiting') {
        socket.emit('queue:waiting');
        return;
      }
      const { room } = result;
      socket.join(room.roomId);
      const opponentSocket = io.sockets.sockets.get(
        room.players[1].socketId === socket.id ? room.players[2].socketId : room.players[1].socketId
      );
      if (opponentSocket) opponentSocket.join(room.roomId);

      for (const pNum of [1, 2]) {
        const s = io.sockets.sockets.get(room.players[pNum].socketId);
        if (s) {
          const opponentNum = pNum === 1 ? 2 : 1;
          s.emit('match:start', {
            roomId: room.roomId,
            playerNumber: pNum,
            opponentName: room.players[opponentNum].displayName,
            state: room.state,
            sessionToken: room.players[pNum].sessionToken,
            aiControlled: room.players[pNum].aiControlled,
            opponentAiControlled: room.players[opponentNum].aiControlled,
          });
        }
      }
    });

    socket.on('match:rejoin', ({ sessionToken } = {}) => {
      const result = rooms.rejoin(socket, sessionToken);
      if (!result.ok) {
        socket.emit('rejoin:failed', { error: result.error });
        return;
      }
      const { room, playerNumber, aiControlled } = result;
      socket.join(room.roomId);
      const opponentNum = playerNumber === 1 ? 2 : 1;
      socket.emit('match:start', {
        roomId: room.roomId,
        playerNumber,
        opponentName: room.players[opponentNum].displayName,
        state: room.state,
        sessionToken: room.players[playerNumber].sessionToken,
        aiControlled,
        opponentAiControlled: room.players[opponentNum].aiControlled,
        rejoined: true,
      });
      const opponentSocket = io.sockets.sockets.get(room.players[opponentNum].socketId);
      if (opponentSocket) opponentSocket.emit('opponent:reconnected');
    });

    function handleAction(action) {
      return (payload = {}) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) {
          socket.emit('move:rejected', { error: 'not-in-a-match' });
          return;
        }
        const playerNumber = rooms.playerNumberOf(room, socket.id);
        const result = rooms.applyMove(room, playerNumber, action, payload);
        if (!result.ok) {
          socket.emit('move:rejected', { error: result.error });
          return;
        }
        // Az elsodleges lepes lerakasat ES annak visszavonasat SZANDEKOSAN
        // csak magának a lepo felnek kuldjuk el, nem az egesz szobanak: az
        // ellenfel csak akkor ertesuljon barmirol, ha a teljes lepespar
        // (elsodleges+masodlagos) mar lezarult. Igy az ellenfel sem egy meg
        // "fuggoben levo" elsodleges jelet, sem egy esetleges visszavonast nem
        // lat elore - csak a kesz lepespart, egyszerre. (Felhasznaloi
        // visszajelzes alapjan, elso elesben tesztelt online partibol.)
        if (action === 'primary' || action === 'retract') {
          socket.emit('state:update', { state: room.state, cause: action, result });
          return;
        }
        io.to(room.roomId).emit('state:update', { state: room.state, cause: action, result });
        if (room.state.status !== 'playing') {
          io.to(room.roomId).emit('match:end', {
            status: room.state.status,
            winner: room.state.winner,
          });
        }
      };
    }

    socket.on('move:primary', handleAction('primary'));
    socket.on('move:secondary', handleAction('secondary'));
    socket.on('move:retract', handleAction('retract'));
    socket.on('resign', handleAction('resign'));

    socket.on('disconnect', () => {
      const room = rooms.handleDisconnect(socket.id);
      if (!room) return;
      const opponentNum = rooms.playerNumberOf(room, socket.id) === 1 ? 2 : 1;
      const opponentSocket = io.sockets.sockets.get(room.players[opponentNum].socketId);
      if (opponentSocket) opponentSocket.emit('opponent:disconnected');
    });
  });

  httpServer.listen(port, () => {
    const scheme = httpServer instanceof https.Server ? 'wss' : 'ws';
    // eslint-disable-next-line no-console
    console.log(`DiPole multiplayer szerver fut: ${scheme}://localhost:${port}`);
  });

  return { httpServer, io, rooms };
}

if (require.main === module) {
  createServer({
    port: process.env.PORT ? Number(process.env.PORT) : 4000,
    tlsKeyPath: process.env.TLS_KEY_PATH,
    tlsCertPath: process.env.TLS_CERT_PATH,
  });
}

module.exports = { createServer };
