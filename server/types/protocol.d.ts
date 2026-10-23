/**
 * Type definitions for 3RTC signaling protocol (server-side).
 * Reference: docs/PROTOCOL.md
 */

import type { WebSocket } from 'ws';

export interface SignalingSocket extends WebSocket {
  peerId: string;
  roomId: string | null;
  isAlive: boolean;
  failedJoins: number[];
  msgTokens: number;
  lastTokenRefill: number;
  ip: string;
  clientIp: string;
}

export interface SignalingMessageBase {
  type: string;
  [key: string]: unknown;
}

export interface CreateRoomMessage extends SignalingMessageBase {
  type: 'create-room';
  peerId?: string;
  roomId?: string | number;
  hostToken?: string;
  seatToken?: string;
}

export interface JoinMessage extends SignalingMessageBase {
  type: 'join';
  roomId?: string | number;
  room?: string | number;
  peerId?: string;
  rejoin?: boolean;
  seatToken?: string;
  hostToken?: string;
}

export interface OfferMessage extends SignalingMessageBase {
  type: 'offer';
  targetPeerId?: string;
  offer: unknown;
}

export interface AnswerMessage extends SignalingMessageBase {
  type: 'answer';
  targetPeerId?: string;
  answer: unknown;
}

export interface IceCandidateMessage extends SignalingMessageBase {
  type: 'ice-candidate';
  targetPeerId?: string;
  candidate: unknown;
}

export interface PingMessage extends SignalingMessageBase {
  type: 'ping';
}

/** "Is room X on this server?" (answered with { type: 'room-found', roomId, exists }) */
export interface FindRoomMessage extends SignalingMessageBase {
  type: 'find-room';
  roomId: string;
}

export interface RoomInfo {
  epoch: string;
  hostPeerId: string | null;
}

export interface TokensResult {
  seatToken?: string;
  hostToken?: string;
}
