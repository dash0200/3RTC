/**
 * Signaling over WebSocket: rooms of up to MAX_ROOM_USERS people, and relaying offers, answers and
 * ICE candidates between them so their browsers can connect directly. Room codes survive the host
 * reconnecting (room-resumed). Message list: docs/PROTOCOL.md.
 */
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { createSeats, loadSecret, newEpoch, isValidPeerId } from './seats.js';

// People per room. Everyone connects directly to everyone (mesh); 6 keeps voice light on each
// person's upload, and local video files are passed along a relay tree instead of the owner
// uploading to every viewer.
export const MAX_ROOM_USERS = Math.max(2, Number(process.env.MAX_ROOM_USERS) || 6);

/** Accept signaling connections on `server` (an http.Server). Returns the WebSocketServer. */
export function attachSignaling(server) {
  const wss = new WebSocketServer({ server });

  // Map<roomId, Map<peerId, WebSocket>>
  const rooms = new Map();
  // Map<roomId, { epoch, hostPeerId }>: the room instance (see seats.js) and who is its host
  const roomInfo = new Map();
  const seats = createSeats(loadSecret({ dir: path.dirname(fileURLToPath(import.meta.url)) }));

  function openRoom(roomId, epoch, hostPeerId) {
    rooms.set(roomId, new Map());
    roomInfo.set(roomId, { epoch, hostPeerId });
    return rooms.get(roomId);
  }

  /**
   * May `ws` sit as `peerId` in this room? A free seat, or one held by this same socket, yes. A seat
   * held by another live socket only with a seat token for it (a peer reclaiming its own seat after
   * its signaling dropped): ids are public, so naming one proves nothing.
   */
  function maySit(roomId, room, peerId, ws, token) {
    const holder = room.get(peerId);
    if (!holder || holder === ws || holder.readyState !== WebSocket.OPEN) return true;
    return seats.checkSeat(token, roomId, peerId) === roomInfo.get(roomId)?.epoch;
  }

  /** Who is the host (the peer that created the room, or got it back with its host token). The
   *  apps trust this, not what a peer says about itself. null: not known (room brought back by a
   *  guest after a restart, until the host returns). */
  const hostOf = (roomId) => roomInfo.get(roomId)?.hostPeerId ?? null;

  /** Seat and host tokens for the client (tokens are only ever sent to their owner). */
  function tokensFor(roomId, peerId) {
    const info = roomInfo.get(roomId);
    if (!info) return {};
    return {
      seatToken: seats.seatToken(roomId, info.epoch, peerId),
      ...(info.hostPeerId === peerId ? { hostToken: seats.hostToken(roomId, info.epoch) } : {})
    };
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
        roomInfo.delete(roomId);
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
          // The host asks for its room back by code (after a signaling drop, a server restart, or
          // reloading the page). Only with the room's host token: anyone can name a code.
          const resumeRoomId = typeof data.roomId === 'string' || typeof data.roomId === 'number'
            ? String(data.roomId).trim() : '';
          if (/^\d{5}$/.test(resumeRoomId)) {
            const epoch = seats.checkHost(data.hostToken, resumeRoomId);
            const existing = roomInfo.get(resumeRoomId);
            if (!epoch || (existing && existing.epoch !== epoch)) {
              log('WARN', `Refused to resume room "${resumeRoomId}" (no valid host token)`);
              safeSend(ws, { type: 'error', code: 'resume-denied', roomId: resumeRoomId, message: `Couldn't get room ${resumeRoomId} back` });
              return;
            }
            const peerId = isValidPeerId(data.peerId) ? data.peerId : ws.peerId;
            let room = rooms.get(resumeRoomId) || openRoom(resumeRoomId, epoch, peerId);
            if (!maySit(resumeRoomId, room, peerId, ws, data.seatToken)) {
              safeSend(ws, { type: 'error', code: 'seat-taken', message: 'That seat is in use' });
              return;
            }
            if (room.size >= MAX_ROOM_USERS && !room.has(peerId)) {
              safeSend(ws, { type: 'error', code: 'room-full', message: `Room ${resumeRoomId} is full (maximum ${MAX_ROOM_USERS} people)` });
              return;
            }
            if (ws.roomId && ws.roomId !== resumeRoomId) leaveRoom(ws);
            ws.peerId = peerId;
            const previous = room.get(peerId);
            if (previous && previous !== ws) previous.roomId = null; // its close won't remove us
            room.set(peerId, ws);
            ws.roomId = resumeRoomId;
            roomInfo.get(resumeRoomId).hostPeerId = peerId;

            const otherPeers = getOtherPeers(resumeRoomId, peerId);
            log('RESUME', `Peer ${peerId} resumed room "${resumeRoomId}" (Total: ${room.size})`);
            safeSend(ws, {
              type: 'room-resumed',
              roomId: resumeRoomId,
              peerId,
              peers: otherPeers.map((p) => p.peerId),
              hostPeerId: peerId,
              ...tokensFor(resumeRoomId, peerId)
            });
            for (const peer of otherPeers) {
              safeSend(peer.ws, { type: 'host', hostPeerId: peerId });
              safeSend(peer.ws, { type: 'peer-joined', peerId });
            }
            break;
          }

          // A new room: an unused random 5-digit code (10000-99999)
          let generatedRoomId;
          let attempts = 0;
          do {
            generatedRoomId = String(crypto.randomInt(10000, 100000));
            attempts++;
          } while (rooms.has(generatedRoomId) && attempts < 100);
          if (rooms.has(generatedRoomId)) {
            // (only with tens of thousands of rooms open) never take over a room in use
            safeSend(ws, { type: 'error', code: 'server-busy', message: 'No free room codes right now. Try again in a minute.' });
            return;
          }

          if (ws.roomId) {
            leaveRoom(ws);
          }
          if (isValidPeerId(data.peerId)) ws.peerId = data.peerId;

          openRoom(generatedRoomId, newEpoch(), ws.peerId).set(ws.peerId, ws);
          ws.roomId = generatedRoomId;

          log('CREATE', `Peer ${ws.peerId} created room "${generatedRoomId}"`);

          safeSend(ws, {
            type: 'room-created',
            roomId: generatedRoomId,
            peerId: ws.peerId,
            peers: [],
            hostPeerId: ws.peerId,
            ...tokensFor(generatedRoomId, ws.peerId)
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

          const peerId = isValidPeerId(data.peerId) ? data.peerId : ws.peerId;

          // A peer reconnecting after a server restart may arrive before the host does: it may
          // bring the room back, with its seat token for it (a stranger can't make up rooms)
          if (!rooms.has(roomId) && data.rejoin === true) {
            const epoch = seats.checkSeat(data.seatToken, roomId, peerId);
            if (epoch) {
              openRoom(roomId, epoch, null);
              log('INFO', `Room "${roomId}" restored by rejoining peer ${peerId}`);
            }
          }

          if (!rooms.has(roomId)) {
            safeSend(ws, {
              type: 'error',
              code: 'not-found',
              message: `Room "${roomId}" not found. Please verify the 5-digit code or create a room.`
            });
            log('WARN', `Peer ${peerId} tried to join non-existent room "${roomId}"`);
            return;
          }

          const room = rooms.get(roomId);
          if (!maySit(roomId, room, peerId, ws, data.seatToken)) {
            log('WARN', `Refused peer id ${peerId} in room "${roomId}": in use, no seat token`);
            safeSend(ws, { type: 'error', code: 'seat-taken', message: 'That seat is in use' });
            return;
          }
          // A peer rejoining after a signaling drop already has its seat
          if (room.size >= MAX_ROOM_USERS && !room.has(peerId)) {
            safeSend(ws, {
              type: 'error',
              code: 'room-full',
              message: `Room ${roomId} is full (maximum ${MAX_ROOM_USERS} people)`
            });
            return;
          }

          // Leave any existing room first
          if (ws.roomId && ws.roomId !== roomId) {
            leaveRoom(ws);
          }
          ws.peerId = peerId;

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
            peers: peerIdsInRoom,
            hostPeerId: hostOf(roomId),
            ...tokensFor(roomId, ws.peerId)
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

  return wss;
}
