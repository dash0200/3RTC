/**
 * Room and RoomBus core interfaces.
 * Direct reference: core/roomBus.js, core/RoomContext.jsx, and App.jsx.
 */

export type BusEventName =
  | 'peer-open'
  | 'peer-close'
  | 'channel-close'
  | 'room-left'
  | 'media-changed'
  | (string & {});

export interface SendableChannel {
  readyState?: string;
  send: (data: string | ArrayBufferView | ArrayBuffer) => void;
  bufferedAmount?: number;
}

export interface RoomBus {
  broadcast: (
    type: string,
    payload?: Record<string, unknown>,
    opts?: { bulk?: boolean }
  ) => number;
  send: (
    peerId: string,
    type: string,
    payload?: Record<string, unknown>,
    opts?: { bulk?: boolean }
  ) => boolean;
  sendBinary: (peerId: string, buffer: ArrayBufferView | ArrayBuffer) => boolean;
  broadcastBinary: (buffer: ArrayBufferView | ArrayBuffer) => number;
  on: <T = unknown>(
    type: string,
    handler: (payload: T, fromPeerId: string) => void
  ) => () => void;
  onBinary: (
    handler: (buffer: ArrayBuffer, fromPeerId: string) => boolean | void
  ) => () => void;
  dispatch: (message: Record<string, unknown>, fromPeerId: string) => void;
  dispatchBinary: (buffer: ArrayBuffer, fromPeerId: string) => boolean;
  onEvent: <T = unknown>(name: BusEventName, handler: (value: T) => void) => () => void;
  emitEvent: <T = unknown>(name: BusEventName, value?: T) => void;
  connectedPeerIds: () => string[];
  channelOf: (peerId: string, opts?: { bulk?: boolean }) => SendableChannel | null;
}

export interface SelfInfo {
  peerId: string | null;
  username: string;
  isHost: boolean;
}

export interface ConnectedPeer {
  id: string;
  peerId: string;
  username: string;
  isHost: boolean;
  isMuted: boolean;
  volume: number;
  isLocalMuted: boolean;
  build: string | null;
}
export type PeerVoiceEntry = ConnectedPeer;

export interface RoomSettings {
  playbackLock?: boolean;
  [key: string]: unknown;
}

export interface Room {
  bus: RoomBus;
  getSelfId: () => string | null;
  getSelf: () => SelfInfo;
  isPeerHost: (peerId: string | null | undefined) => boolean;
  getHostPeerId: () => string | null;
  peerName: (peerId: string) => string | null;
  clientIdOf: (peerId: string) => string | null;
  peerProtocol: (peerId: string) => number;
  getAuthorityId: () => string | null;
  getRoomSettings: () => RoomSettings;
  notify: (text: string) => void;
  log: (text: string) => void;
}

export interface RoomContextValue extends Room {
  roomId: string | null;
  isHost: boolean;
  username: string;
  peers: ConnectedPeer[];
  playbackLock: boolean;
  signalUrl?: string;
}
