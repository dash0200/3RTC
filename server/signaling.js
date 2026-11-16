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
import { isAllowedOrigin } from './quickPicks.js';
import { createRateLimiter } from './rateLimit.js';

// People per room. Everyone connects directly to everyone (mesh); 4 keeps voice light on each
// person's upload, and local video files are passed along a relay tree instead of the owner
// uploading to every viewer.
export const MAX_ROOM_USERS = Math.max(2, Number(process.env.MAX_ROOM_USERS) || 4);
export const MAX_SIGNAL_PAYLOAD_BYTES = 64 * 1024; // 64 KB max payload to prevent memory exhaustion DoS

export const RATE_LIMIT = {
  maxFailedJoins: 15,        // Max failed room joins before temporary throttle
  failedJoinWindowMs: 30000, // 30-second sliding window
  maxMessagesPerSec: 60      // Max signaling messages per second per socket
};

export function isOriginAllowed(origin) {
  return !origin || isAllowedOrigin(origin);
}

/** Accept signaling connections on `server` (an http.Server). Returns the WebSocketServer. */
export function attachSignaling(server) {
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_SIGNAL_PAYLOAD_BYTES,
    verifyClient: (info, callback) => {
      const origin = info.origin || info.req?.headers?.origin;
      // Allow non-browser clients (tests, curl, CLI) or verified 3RTC origins
      if (isOriginAllowed(origin)) {
        return callback(true);
      }
      log('WARN', `Rejected WebSocket upgrade from unauthorized origin: ${origin}`);
      callback(false, 403, 'Forbidden Origin');
    }
  });

  // Map<roomId, Map<peerId, WebSocket>>
  /** @type {Map<string, Map<string, import('./types/protocol.d.ts').SignalingSocket>>} */
  const rooms = new Map();
  // Map<roomId, { epoch, hostPeerId }>: the room instance (see seats.js) and who is its host
  /** @type {Map<string, import('./types/protocol.d.ts').RoomInfo>} */
  const roomInfo = new Map();
  const seats = createSeats(loadSecret({ dir: path.dirname(fileURLToPath(import.meta.url)) }));
  const rateLimiter = createRateLimiter();

  /**
   * @param {string} roomId
   * @param {string} epoch
   * @param {string | null} hostPeerId
   * @param {number} [hostGen]
   * @param {'mesh' | 'hub'} [topology]
   * @param {number} [maxUsers]
   */
  function openRoom(roomId, epoch, hostPeerId, hostGen = 0, topology = 'mesh', maxUsers = undefined) {
    /** @type {Map<string, import('./types/protocol.d.ts').SignalingSocket>} */
    const room = new Map();
    rooms.set(roomId, room);
    const limit = maxUsers && Number(maxUsers) >= 2 ? Math.floor(Number(maxUsers)) : (topology === 'hub' ? 32 : MAX_ROOM_USERS);
    // hostGen: how many times the host has handed the room on (host tokens name it; older ones stop working)
    roomInfo.set(roomId, { epoch, hostPeerId, hostGen, topology, maxUsers: limit });
    return room;
  }

  /**
   * May `ws` sit as `peerId` in this room?
   * If claiming the host's seat, cryptographic seatToken verification is strictly required (H-03).
   * A seat held by another live socket also requires a seat token.
   * @param {string} roomId
   * @param {Map<string, import('./types/protocol.d.ts').SignalingSocket>} room
   * @param {string} peerId
   * @param {import('./types/protocol.d.ts').SignalingSocket} ws
   * @param {string | undefined} [token]
   */
  function maySit(roomId, room, peerId, ws, token) {
    const info = roomInfo.get(roomId);
    if (!info) return false;
    if (info.hostPeerId && peerId === info.hostPeerId) {
      return seats.checkSeat(token, roomId, peerId) === info.epoch;
    }
    const holder = room.get(peerId);
    if (!holder || holder === ws || holder.readyState !== WebSocket.OPEN) return true;
    return seats.checkSeat(token, roomId, peerId) === info.epoch;
  }

  /** Who is the host (the peer that created the room, or got it back with its host token). The
   *  apps trust this, not what a peer says about itself. null: not known (room brought back by a
   *  guest after a restart, until the host returns). */
  const hostOf = (roomId) => roomInfo.get(roomId)?.hostPeerId ?? null;

  /** Seat and host tokens for the client. Host token is only issued if host identity is verified. */
  function tokensFor(roomId, peerId, isHostVerified = false) {
    const info = roomInfo.get(roomId);
    if (!info) return {};
    return {
      seatToken: seats.seatToken(roomId, info.epoch, peerId),
      ...(info.hostPeerId === peerId && isHostVerified ? { hostToken: seats.hostToken(roomId, info.epoch, info.hostGen || 0) } : {})
    };
  }

  /**
   * @param {import('./types/protocol.d.ts').SignalingSocket} ws
   * @param {any} data
   */
  function safeSend(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * @param {string} roomId
   * @param {string} excludePeerId
   * @returns {{ peerId: string, ws: import('./types/protocol.d.ts').SignalingSocket }[]}
   */
  function getOtherPeers(roomId, excludePeerId) {
    const room = rooms.get(roomId);
    if (!room) return [];
    /** @type {{ peerId: string, ws: import('./types/protocol.d.ts').SignalingSocket }[]} */
    const peers = [];
    for (const [peerId, clientWs] of room.entries()) {
      if (peerId !== excludePeerId && clientWs.readyState === WebSocket.OPEN) {
        peers.push({ peerId, ws: clientWs });
      }
    }
    return peers;
  }

  /**
   * @param {import('./types/protocol.d.ts').SignalingSocket} ws
   */
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

  wss.on('connection', (rawWs, req) => {
    /** @type {import('./types/protocol.d.ts').SignalingSocket} */
    const ws = /** @type {any} */ (rawWs);
    ws.peerId = crypto.randomUUID();
    ws.roomId = null;
    ws.isAlive = true;
    ws.failedJoins = [];
    ws.msgTokens = RATE_LIMIT.maxMessagesPerSec;
    ws.lastTokenRefill = Date.now();
    const forwardedHeader = req?.headers?.['x-forwarded-for'];
    const forwarded = Array.isArray(forwardedHeader) ? forwardedHeader[0] : forwardedHeader;
    ws.ip = forwarded?.split(',')[0]?.trim() || req?.socket?.remoteAddress || 'unknown';
    ws.clientIp = ws.ip;

    log('CONN', `New client connected, assigned peerId: ${ws.peerId} from ${ws.ip}`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (rawData) => {
      const rawLen = Array.isArray(rawData)
        ? rawData.reduce((acc, c) => acc + c.length, 0)
        : (rawData ? (/** @type {any} */ (rawData).byteLength ?? /** @type {any} */ (rawData).length ?? 0) : 0);
      if (rawLen > MAX_SIGNAL_PAYLOAD_BYTES) {
        safeSend(ws, { type: 'error', message: 'Payload exceeds maximum allowed size' });
        return;
      }

      const now = Date.now();
      const elapsed = Math.max(0, (now - ws.lastTokenRefill) / 1000);
      ws.msgTokens = Math.min(RATE_LIMIT.maxMessagesPerSec, ws.msgTokens + elapsed * RATE_LIMIT.maxMessagesPerSec);
      ws.lastTokenRefill = now;

      if (ws.msgTokens < 1) {
        safeSend(ws, { type: 'error', code: 'rate-limited', message: 'Message rate limit exceeded. Please slow down.' });
        return;
      }
      ws.msgTokens -= 1;

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
            const host = seats.checkHostGen(data.hostToken, resumeRoomId);
            const existing = roomInfo.get(resumeRoomId);
            // A host token from before the room was handed on (lower generation) no longer works
            if (!host || (existing && (existing.epoch !== host.epoch || host.gen < (existing.hostGen || 0)))) {
              log('WARN', `Refused to resume room "${resumeRoomId}" (no valid host token)`);
              safeSend(ws, { type: 'error', code: 'resume-denied', roomId: resumeRoomId, message: `Couldn't get room ${resumeRoomId} back` });
              return;
            }
            const peerId = isValidPeerId(data.peerId) ? data.peerId : ws.peerId;
            let room = rooms.get(resumeRoomId) || openRoom(resumeRoomId, host.epoch, peerId, host.gen);
            // The host token proves this is the host: enough for the host's own seat or a free one
            // (Rejoin after Leave sends no seat token). A guest who is still here keeps theirs.
            const holder = room.get(peerId);
            const guestSeatInUse = Boolean(holder && holder !== ws && holder.readyState === WebSocket.OPEN &&
              roomInfo.get(resumeRoomId)?.hostPeerId !== peerId);
            if (guestSeatInUse && !maySit(resumeRoomId, room, peerId, ws, data.seatToken)) {
              safeSend(ws, { type: 'error', code: 'seat-taken', message: 'That seat is in use' });
              return;
            }
            const currentInfo = roomInfo.get(resumeRoomId);
            const limit = currentInfo?.maxUsers || (currentInfo?.topology === 'hub' ? 32 : MAX_ROOM_USERS);
            if (room.size >= limit && !room.has(peerId)) {
              safeSend(ws, { type: 'error', code: 'room-full', message: `Room ${resumeRoomId} is full (maximum ${limit} people)` });
              return;
            }
            if (ws.roomId && ws.roomId !== resumeRoomId) leaveRoom(ws);
            ws.peerId = peerId;
            const previous = room.get(peerId);
            if (previous && previous !== ws) previous.roomId = null; // its close won't remove us
            room.set(peerId, ws);
            ws.roomId = resumeRoomId;
            if (currentInfo) {
              currentInfo.hostPeerId = peerId;
              currentInfo.hostGen = Math.max(currentInfo.hostGen || 0, host.gen);
            }

            const otherPeers = getOtherPeers(resumeRoomId, peerId);
            log('RESUME', `Peer ${peerId} resumed room "${resumeRoomId}" (Total: ${room.size})`);
            const topology = currentInfo?.topology || 'mesh';
            safeSend(ws, {
              type: 'room-resumed',
              roomId: resumeRoomId,
              peerId,
              peers: otherPeers.map((p) => p.peerId),
              hostPeerId: peerId,
              topology,
              maxUsers: currentInfo?.maxUsers || limit,
              ...tokensFor(resumeRoomId, peerId, true)
            });
            for (const peer of otherPeers) {
              safeSend(peer.ws, { type: 'host', hostPeerId: peerId });
              safeSend(peer.ws, { type: 'peer-joined', peerId });
            }
            break;
          }

          // Rate limit room creation per IP to prevent room pool DoS (H-02)
          if (!rateLimiter.checkCreateRoom(ws.clientIp)) {
            log('WARN', `Rate limited create-room attempt from IP ${ws.clientIp}`);
            safeSend(ws, {
              type: 'error',
              code: 'rate-limited',
              message: 'Too many rooms created recently. Please wait a few minutes.'
            });
            return;
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

          const topology = data.topology === 'hub' ? 'hub' : 'mesh';
          const customLimit = data.maxUsers && Number(data.maxUsers) >= 2 ? Math.floor(Number(data.maxUsers)) : undefined;
          openRoom(generatedRoomId, newEpoch(), ws.peerId, 0, topology, customLimit).set(ws.peerId, ws);
          ws.roomId = generatedRoomId;
          const info = roomInfo.get(generatedRoomId);
          const maxUsers = info?.maxUsers ?? (topology === 'hub' ? 32 : MAX_ROOM_USERS);

          log('CREATE', `Peer ${ws.peerId} created room "${generatedRoomId}" (topology: ${topology}, limit: ${maxUsers})`);

          safeSend(ws, {
            type: 'room-created',
            roomId: generatedRoomId,
            peerId: ws.peerId,
            peers: [],
            hostPeerId: ws.peerId,
            topology,
            maxUsers,
            ...tokensFor(generatedRoomId, ws.peerId, true)
          });
          break;
        }

        case 'join': {
          // Check brute-force PIN sweep ban (H-01)
          if (rateLimiter.isJoinBanned(ws.clientIp).banned) {
            log('WARN', `Join attempt from temporarily banned IP ${ws.clientIp} rejected`);
            safeSend(ws, {
              type: 'error',
              code: 'rate-limited',
              message: 'Too many invalid room attempts. Temporarily blocked.'
            });
            return;
          }

          // Check instantaneous join rate
          if (!rateLimiter.checkJoinRate(ws.clientIp)) {
            log('WARN', `Rapid join attempts from IP ${ws.clientIp} throttled`);
            safeSend(ws, {
              type: 'error',
              code: 'rate-limited',
              message: 'Too many join attempts. Please slow down.'
            });
            return;
          }

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

          const nowJoin = Date.now();
          ws.failedJoins = (ws.failedJoins || []).filter((t) => nowJoin - t < RATE_LIMIT.failedJoinWindowMs);
          if (ws.failedJoins.length >= RATE_LIMIT.maxFailedJoins) {
            log('WARN', `Rate limited peer ${ws.peerId} (${ws.ip}): exceeded failed join attempts`);
            safeSend(ws, {
              type: 'error',
              code: 'rate-limited',
              message: 'Too many failed join attempts. Please wait 30 seconds before trying again.'
            });
            return;
          }

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
            ws.failedJoins.push(Date.now());
            safeSend(ws, {
              type: 'error',
              code: 'not-found',
              roomId,
              message: `Room "${roomId}" not found. Please verify the 5-digit code or create a room.`
            });
            log('WARN', `Peer ${peerId} tried to join non-existent room "${roomId}"`);
            return;
          }

          ws.failedJoins = [];
          const room = rooms.get(roomId);
          if (!room) return;
          const info = roomInfo.get(roomId);
          const isHostSeat = Boolean(info?.hostPeerId && peerId === info.hostPeerId);
          const hasValidSeatToken = Boolean(
            data.seatToken && seats.checkSeat(data.seatToken, roomId, peerId) === info?.epoch
          );

          // Prevent unauthenticated claim of the host's seat (H-03)
          if (isHostSeat && !hasValidSeatToken) {
            log('WARN', `Refused unauthenticated attempt to claim host seat ${peerId} in room "${roomId}"`);
            safeSend(ws, { type: 'error', code: 'seat-taken', message: 'That seat is in use' });
            return;
          }

          if (!maySit(roomId, room, peerId, ws, data.seatToken)) {
            log('WARN', `Refused peer id ${peerId} in room "${roomId}": in use, no seat token`);
            safeSend(ws, { type: 'error', code: 'seat-taken', message: 'That seat is in use' });
            return;
          }
          // A peer rejoining after a signaling drop already has its seat
          const roomLimit = info?.maxUsers || (info?.topology === 'hub' ? 32 : MAX_ROOM_USERS);
          if (room.size >= roomLimit && !room.has(peerId)) {
            safeSend(ws, {
              type: 'error',
              code: 'room-full',
              message: `Room ${roomId} is full (maximum ${roomLimit} people)`
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

          rateLimiter.recordSuccessfulJoin(ws.clientIp);

          const otherPeers = getOtherPeers(roomId, ws.peerId);
          const currentTopology = info?.topology || 'mesh';
          const isHost = Boolean(isHostSeat && hasValidSeatToken);
          const hostPeerId = hostOf(roomId);

          // In Hub topology, guests only connect to the host; the host connects to all guests.
          const peerIdsInRoom = currentTopology === 'hub'
            ? (isHost ? otherPeers.map((p) => p.peerId) : (hostPeerId ? [hostPeerId] : []))
            : otherPeers.map((p) => p.peerId);

          log('JOIN', `Peer ${ws.peerId} joined room "${roomId}" (Total: ${room.size}, topology: ${currentTopology})`);

          // Acknowledge join to the sender with existing peer IDs
          safeSend(ws, {
            type: 'joined',
            roomId,
            peerId: ws.peerId,
            peers: peerIdsInRoom,
            hostPeerId,
            topology: currentTopology,
            maxUsers: info?.maxUsers || roomLimit,
            ...tokensFor(roomId, ws.peerId, isHost)
          });

          // Notify other peers about the newcomer
          for (const peer of otherPeers) {
            // In Hub topology, non-hosts do not connect directly to other non-hosts
            if (currentTopology === 'hub' && !isHost && peer.peerId !== hostPeerId) {
              continue;
            }
            safeSend(peer.ws, {
              type: 'peer-joined',
              peerId: ws.peerId
            });
          }
          break;
        }

        case 'transfer-host': {
          // The host hands the room to someone else in it. Only the host the server knows may do it;
          // the new host gets a host token of the next generation, so the old host's token can't take
          // the room back (its seat token still works: it stays as a guest).
          const roomId = ws.roomId;
          const info = roomId ? roomInfo.get(roomId) : null;
          const room = roomId ? rooms.get(roomId) : null;
          if (!roomId || !info || !room || info.hostPeerId !== ws.peerId || room.get(ws.peerId) !== ws) {
            safeSend(ws, { type: 'error', code: 'not-host', message: 'Only the host can make someone else the host' });
            return;
          }
          const targetId = typeof data.targetPeerId === 'string' ? data.targetPeerId : '';
          const target = room.get(targetId);
          if (!targetId || targetId === ws.peerId || !target || target.readyState !== WebSocket.OPEN) {
            safeSend(ws, { type: 'error', code: 'target-not-found', message: 'That person is no longer in the room' });
            return;
          }
          info.hostGen = (info.hostGen || 0) + 1;
          info.hostPeerId = targetId;
          log('HOST', `Peer ${ws.peerId} made ${targetId} the host of room "${roomId}" (generation ${info.hostGen})`);
          safeSend(target, { type: 'host-token', roomId, hostToken: seats.hostToken(roomId, info.epoch, info.hostGen) });
          for (const [, clientWs] of room.entries()) {
            safeSend(clientWs, { type: 'host', hostPeerId: targetId, from: ws.peerId });
          }
          break;
        }

        case 'set-room-size': {
          const roomId = ws.roomId;
          const info = roomId ? roomInfo.get(roomId) : null;
          const room = roomId ? rooms.get(roomId) : null;
          if (!roomId || !info || !room || info.hostPeerId !== ws.peerId || room.get(ws.peerId) !== ws) {
            safeSend(ws, { type: 'error', code: 'not-host', message: 'Only the host can set room capacity' });
            return;
          }
          const rawLimit = Number(data.maxUsers);
          const nextLimit = rawLimit && rawLimit >= 2 ? Math.floor(rawLimit) : (info.topology === 'hub' ? 32 : MAX_ROOM_USERS);
          info.maxUsers = nextLimit;
          log('ROOM-SIZE', `Host ${ws.peerId} set room "${roomId}" capacity to ${nextLimit}`);
          for (const [, clientWs] of room.entries()) {
            safeSend(clientWs, {
              type: 'room-size-changed',
              maxUsers: nextLimit,
              from: ws.peerId
            });
          }
          break;
        }

        case 'set-topology': {
          const roomId = ws.roomId;
          const info = roomId ? roomInfo.get(roomId) : null;
          const room = roomId ? rooms.get(roomId) : null;
          if (!roomId || !info || !room || info.hostPeerId !== ws.peerId || room.get(ws.peerId) !== ws) {
            safeSend(ws, { type: 'error', code: 'not-host', message: 'Only the host can set room topology' });
            return;
          }
          const nextTopology = data.topology === 'hub' ? 'hub' : 'mesh';
          if (info.topology === nextTopology) return;
          info.topology = nextTopology;
          log('TOPOLOGY', `Host ${ws.peerId} set room "${roomId}" topology to ${nextTopology}`);
          for (const [, clientWs] of room.entries()) {
            safeSend(clientWs, {
              type: 'topology-changed',
              topology: nextTopology,
              hostPeerId: ws.peerId
            });
          }
          break;
        }

        case 'find-room': {
          // "Is room X on this server?" The app asks the other 3RTC servers before telling someone
          // a code doesn't exist (rooms live on the server they were made on). Limited exactly
          // like a join, so it's no faster for guessing codes.
          const roomId = typeof data.roomId === 'string' || typeof data.roomId === 'number' ? String(data.roomId).trim() : '';
          if (!/^\d{5}$/.test(roomId)) {
            safeSend(ws, { type: 'error', message: 'Invalid roomId: must be strictly a 5-digit number (e.g. 12345)' });
            return;
          }
          const nowFind = Date.now();
          ws.failedJoins = (ws.failedJoins || []).filter((t) => nowFind - t < RATE_LIMIT.failedJoinWindowMs);
          if (rateLimiter.isJoinBanned(ws.clientIp).banned || !rateLimiter.checkJoinRate(ws.clientIp) ||
            ws.failedJoins.length >= RATE_LIMIT.maxFailedJoins) {
            safeSend(ws, { type: 'error', code: 'rate-limited', message: 'Too many join attempts. Please slow down.' });
            return;
          }
          const exists = rooms.has(roomId);
          if (!exists) ws.failedJoins.push(nowFind);
          safeSend(ws, { type: 'room-found', roomId, exists });
          break;
        }

        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'candidate': {
          const currentRoomId = ws.roomId;
          if (!currentRoomId) {
            safeSend(ws, { type: 'error', message: 'You must join a room before swapping signals' });
            return;
          }

          const normalizedType = type === 'candidate' ? 'ice-candidate' : type;
          const targetId = data.targetId || data.target;
          const room = rooms.get(currentRoomId);

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
          const otherPeers = getOtherPeers(currentRoomId, ws.peerId);
          if (otherPeers.length === 1) {
            safeSend(otherPeers[0].ws, outgoingPayload);
            log('SIGNAL', `${normalizedType.toUpperCase()} from ${ws.peerId} -> ${otherPeers[0].peerId} (auto-relay)`);
          } else if (otherPeers.length === 0) {
            log('WARN', `Peer ${ws.peerId} sent ${normalizedType} but room is empty`);
          } else {
            // In a multi-peer room (3+ participants), P2P signals must be explicitly targeted
            safeSend(ws, { type: 'error', message: 'targetId required in multi-peer rooms' });
            log('WARN', `Rejected ${normalizedType.toUpperCase()} from ${ws.peerId}: targetId required in multi-peer rooms`);
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

  // Periodic heartbeat to clean up broken sockets and stale rate limit entries
  const heartbeatInterval = setInterval(() => {
    rateLimiter.cleanUp();
    wss.clients.forEach((rawWs) => {
      /** @type {import('./types/protocol.d.ts').SignalingSocket} */
      const ws = /** @type {any} */ (rawWs);
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
