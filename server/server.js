import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const candidateDirs = [
  path.resolve(__dirname, 'client/dist'),
  path.resolve(__dirname, '../client/dist'),
  path.resolve(__dirname, 'client'),
  path.resolve(__dirname, '../client')
];
const clientDir = candidateDirs.find(d => fs.existsSync(d) && fs.existsSync(path.join(d, 'index.html'))) || candidateDirs[0];

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  let safePath = path.normalize(path.join(clientDir, reqPath));
  if (!safePath.startsWith(clientDir) || !fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    // SPA fallback to index.html
    const indexPath = path.join(clientDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      safePath = indexPath;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
  }

  const ext = path.extname(safePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(safePath).pipe(res);
});

const wss = new WebSocketServer({ server });

// Map<roomId, Map<peerId, WebSocket>>
const rooms = new Map();

function log(level, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOtherPeers(roomId, excludePeerId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const peers = [];
  for (const [peerId, clientWs] of room.entries()) {
    if (peerId !== excludePeerId && clientWs.readyState === WebSocket.OPEN) {
      peers.push({ peerId, ws: clientWs });
    }
  }
  return peers;
}

function leaveRoom(ws) {
  const { roomId, peerId } = ws;
  if (!roomId || !peerId) return;

  const room = rooms.get(roomId);
  // A peer that reconnected replaced this (stale) socket: the old socket closing must not
  // remove the live one or tell the room it left
  if (room && room.get(peerId) !== ws) {
    ws.roomId = null;
    return;
  }
  if (room) {
    room.delete(peerId);
    log('INFO', `Peer ${peerId} left room "${roomId}" (${room.size} remaining)`);

    // Notify other peers in the room
    for (const [, clientWs] of room.entries()) {
      safeSend(clientWs, {
        type: 'peer-left',
        peerId
      });
    }

    if (room.size === 0) {
      rooms.delete(roomId);
      log('INFO', `Room "${roomId}" closed (empty)`);
    }
  }

  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomUUID();
  ws.roomId = null;
  ws.isAlive = true;

  log('CONN', `New client connected, assigned peerId: ${ws.peerId}`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    const { type } = data;

    switch (type) {
      case 'create-room': {
        // Host reconnecting after a signaling drop asks for its room back by code
        const resumeRoomId = typeof data.roomId === 'string' || typeof data.roomId === 'number'
          ? String(data.roomId).trim() : '';
        if (/^\d{5}$/.test(resumeRoomId) && data.peerId && typeof data.peerId === 'string') {
          const peerId = data.peerId.trim();
          if (ws.roomId && ws.roomId !== resumeRoomId) {
            leaveRoom(ws);
          }
          ws.peerId = peerId;
          let room = rooms.get(resumeRoomId);
          if (!room) {
            room = new Map();
            rooms.set(resumeRoomId, room);
          } else if (room.size >= 3 && !room.has(peerId)) {
            safeSend(ws, { type: 'error', message: `Room ${resumeRoomId} is full (maximum 3 users allowed)` });
            return;
          }
          const previous = room.get(peerId);
          if (previous && previous !== ws) previous.roomId = null; // its close won't remove us
          room.set(peerId, ws);
          ws.roomId = resumeRoomId;

          const otherPeers = getOtherPeers(resumeRoomId, peerId);
          log('RESUME', `Peer ${peerId} resumed room "${resumeRoomId}" (Total: ${room.size})`);
          safeSend(ws, {
            type: 'room-resumed',
            roomId: resumeRoomId,
            peerId,
            peers: otherPeers.map((p) => p.peerId)
          });
          for (const peer of otherPeers) {
            safeSend(peer.ws, { type: 'peer-joined', peerId });
          }
          break;
        }

        // Generate an unused random 5-digit room ID (10000-99999)
        let generatedRoomId;
        let attempts = 0;
        do {
          generatedRoomId = String(Math.floor(10000 + Math.random() * 90000));
          attempts++;
        } while (rooms.has(generatedRoomId) && attempts < 100);

        if (ws.roomId) {
          leaveRoom(ws);
        }

        if (data.peerId && typeof data.peerId === 'string') {
          ws.peerId = data.peerId.trim();
        }

        rooms.set(generatedRoomId, new Map([[ws.peerId, ws]]));
        ws.roomId = generatedRoomId;

        log('CREATE', `Peer ${ws.peerId} created room "${generatedRoomId}"`);

        safeSend(ws, {
          type: 'room-created',
          roomId: generatedRoomId,
          peerId: ws.peerId,
          peers: []
        });
        break;
      }

      case 'join': {
        const rawRoom = data.roomId ?? data.room;
        const roomId = rawRoom !== undefined && rawRoom !== null ? String(rawRoom).trim() : '';

        // Strict 5-digit number check
        if (!/^\d{5}$/.test(roomId)) {
          safeSend(ws, {
            type: 'error',
            message: 'Invalid roomId: must be strictly a 5-digit number (e.g. 12345)'
          });
          return;
        }

        // Leave any existing room first
        if (ws.roomId) {
          leaveRoom(ws);
        }

        // Optional custom peerId provided by client
        if (data.peerId && typeof data.peerId === 'string') {
          ws.peerId = data.peerId.trim();
        }

        // A peer reconnecting after a signaling drop (or server restart) may arrive before the
        // host does: restore the room instead of turning it away
        if (!rooms.has(roomId) && data.rejoin === true) {
          rooms.set(roomId, new Map());
          log('INFO', `Room "${roomId}" restored by rejoining peer ${ws.peerId}`);
        }

        if (!rooms.has(roomId)) {
          safeSend(ws, {
            type: 'error',
            message: `Room "${roomId}" not found. Please verify the 5-digit code or create a room.`
          });
          log('WARN', `Peer ${ws.peerId} tried to join non-existent room "${roomId}"`);
          return;
        }

        const room = rooms.get(roomId);
        // A peer rejoining after a signaling drop already has its seat
        if (room.size >= 3 && !room.has(ws.peerId)) {
          safeSend(ws, {
            type: 'error',
            message: `Room ${roomId} is full (maximum 3 users allowed)`
          });
          return;
        }

        const previous = room.get(ws.peerId);
        if (previous && previous !== ws) previous.roomId = null; // stale socket: its close won't remove us
        room.set(ws.peerId, ws);
        ws.roomId = roomId;

        const otherPeers = getOtherPeers(roomId, ws.peerId);
        const peerIdsInRoom = otherPeers.map(p => p.peerId);

        log('JOIN', `Peer ${ws.peerId} joined room "${roomId}" (Total: ${room.size})`);

        // Acknowledge join to the sender with existing peer IDs
        safeSend(ws, {
          type: 'joined',
          roomId,
          peerId: ws.peerId,
          peers: peerIdsInRoom
        });

        // Notify other peers about the newcomer
        for (const peer of otherPeers) {
          safeSend(peer.ws, {
            type: 'peer-joined',
            peerId: ws.peerId
          });
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'candidate': {
        if (!ws.roomId) {
          safeSend(ws, { type: 'error', message: 'You must join a room before swapping signals' });
          return;
        }

        const normalizedType = type === 'candidate' ? 'ice-candidate' : type;
        const targetId = data.targetId || data.target;
        const room = rooms.get(ws.roomId);

        if (!room) {
          safeSend(ws, { type: 'error', message: 'Room not found' });
          return;
        }

        const outgoingPayload = {
          type: normalizedType,
          from: ws.peerId,
          offer: data.offer,
          answer: data.answer,
          candidate: data.candidate,
          fresh: data.fresh === true ? true : undefined,           // brand-new connection
          iceRestart: data.iceRestart === true ? true : undefined  // reconnect of an existing one
        };

        // Targeted message
        if (targetId) {
          const targetWs = room.get(targetId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            safeSend(targetWs, outgoingPayload);
            log('SIGNAL', `${normalizedType.toUpperCase()} from ${ws.peerId} -> ${targetId}`);
          } else {
            safeSend(ws, { type: 'error', message: `Target peer ${targetId} not found in room` });
          }
          return;
        }

        // Automatic 1-to-1 routing if targetId is omitted
        const otherPeers = getOtherPeers(ws.roomId, ws.peerId);
        if (otherPeers.length === 1) {
          safeSend(otherPeers[0].ws, outgoingPayload);
          log('SIGNAL', `${normalizedType.toUpperCase()} from ${ws.peerId} -> ${otherPeers[0].peerId} (auto-relay)`);
        } else if (otherPeers.length === 0) {
          log('WARN', `Peer ${ws.peerId} sent ${normalizedType} but room is empty`);
        } else {
          // If multi-peer room and no targetId was specified, broadcast to all other peers
          for (const peer of otherPeers) {
            safeSend(peer.ws, outgoingPayload);
          }
          log('SIGNAL', `${normalizedType.toUpperCase()} from ${ws.peerId} broadcast to ${otherPeers.length} peers`);
        }
        break;
      }

      case 'leave': {
        leaveRoom(ws);
        safeSend(ws, { type: 'left' });
        break;
      }

      case 'ping': {
        safeSend(ws, { type: 'pong' });
        break;
      }

      default:
        safeSend(ws, { type: 'error', message: `Unknown message type: "${type}"` });
        break;
    }
  });

  ws.on('close', () => {
    log('DISCONN', `Client disconnected: ${ws.peerId}`);
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    log('ERROR', `Socket error for ${ws.peerId}: ${err.message}`);
    leaveRoom(ws);
  });
});

// Periodic heartbeat to clean up broken sockets
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log('WARN', `Terminating inactive peer: ${ws.peerId}`);
      leaveRoom(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` WebRTC Signaling & Web Server on port ${PORT}`);
  console.log(` Web Client UI: http://localhost:${PORT}`);
  console.log(` WebSocket URL: ws://localhost:${PORT}`);
  console.log(`===============================================`);
});
