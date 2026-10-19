/**
 * 3RTC Network Protocol Types.
 * Wire-level specifications for:
 * 1. Signaling Server WebSocket messages (browser <-> server)
 * 2. WebRTC DataChannel messages (browser <-> browser, main channel)
 *
 * Direct reference: docs/PROTOCOL.md
 */

import type { MediaItem, QueueItem } from './media';

export const PROTOCOL_VERSION = 2;

// ============================================================================
// 1. Signaling Messages (WebSocket)
// ============================================================================

export type SignalingErrorCode =
  | 'resume-denied'
  | 'seat-taken'
  | 'room-full'
  | 'not-found'
  | 'server-busy';

export interface BaseSignalingMessage {
  type: string;
}

// Browser -> Server
export interface CreateRoomMessage extends BaseSignalingMessage {
  type: 'create-room';
  peerId: string;
  roomId?: string;
  hostToken?: string;
  seatToken?: string;
}

export interface JoinRoomMessage extends BaseSignalingMessage {
  type: 'join';
  roomId: string;
  peerId: string;
  rejoin?: boolean;
  seatToken?: string;
}

export interface LeaveRoomMessage extends BaseSignalingMessage {
  type: 'leave';
}

export interface SendOfferMessage extends BaseSignalingMessage {
  type: 'offer';
  targetId: string;
  offer: RTCSessionDescriptionInit;
  fresh?: boolean;
  iceRestart?: boolean;
}

export interface SendAnswerMessage extends BaseSignalingMessage {
  type: 'answer';
  targetId: string;
  answer: RTCSessionDescriptionInit;
}

export interface SendIceCandidateMessage extends BaseSignalingMessage {
  type: 'ice-candidate';
  targetId: string;
  candidate: RTCIceCandidateInit;
}

export interface PingMessage extends BaseSignalingMessage {
  type: 'ping';
}

// Server -> Browser
export interface RoomCreatedMessage extends BaseSignalingMessage {
  type: 'room-created';
  roomId: string;
  peerId: string;
  hostPeerId: string;
  seatToken: string;
  hostToken: string;
}

export interface RoomResumedMessage extends BaseSignalingMessage {
  type: 'room-resumed';
  roomId: string;
  peerId: string;
  peers: string[];
  hostPeerId: string;
  seatToken: string;
  hostToken: string;
}

export interface JoinedMessage extends BaseSignalingMessage {
  type: 'joined';
  roomId: string;
  peerId: string;
  peers: string[];
  hostPeerId: string;
  seatToken: string;
  hostToken?: string;
}

export interface HostUpdateMessage extends BaseSignalingMessage {
  type: 'host';
  hostPeerId: string;
}

export interface PeerJoinedMessage extends BaseSignalingMessage {
  type: 'peer-joined';
  peerId: string;
}

export interface PeerLeftMessage extends BaseSignalingMessage {
  type: 'peer-left';
  peerId: string;
}

export interface LeftMessage extends BaseSignalingMessage {
  type: 'left';
}

export interface ReceiveOfferMessage extends BaseSignalingMessage {
  type: 'offer';
  from: string;
  offer: RTCSessionDescriptionInit;
  fresh?: boolean;
  iceRestart?: boolean;
}

export interface ReceiveAnswerMessage extends BaseSignalingMessage {
  type: 'answer';
  from: string;
  answer: RTCSessionDescriptionInit;
}

export interface ReceiveIceCandidateMessage extends BaseSignalingMessage {
  type: 'ice-candidate';
  from: string;
  candidate: RTCIceCandidateInit;
}

export interface PongMessage extends BaseSignalingMessage {
  type: 'pong';
}

export interface SignalingErrorMessage extends BaseSignalingMessage {
  type: 'error';
  message: string;
  code?: SignalingErrorCode;
  roomId?: string;
}

export type OutgoingSignalingMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | SendOfferMessage
  | SendAnswerMessage
  | SendIceCandidateMessage
  | PingMessage;

export type IncomingSignalingMessage =
  | RoomCreatedMessage
  | RoomResumedMessage
  | JoinedMessage
  | HostUpdateMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | LeftMessage
  | ReceiveOfferMessage
  | ReceiveAnswerMessage
  | ReceiveIceCandidateMessage
  | PongMessage
  | SignalingErrorMessage;

export type SignalingMessage = OutgoingSignalingMessage | IncomingSignalingMessage;


// ============================================================================
// 2. Peer Messages (WebRTC DataChannel)
// ============================================================================

export interface BasePeerMessage {
  type: string;
  sender?: string;
  timestamp?: number;
}

// Connection & Handshake
export interface PeerIdentityMessage extends BasePeerMessage {
  type: 'peer-identity';
  peerId: string;
  username: string;
  isHost: boolean;
  isMuted: boolean;
  proto: number;
  build?: string;
  clientId: string;
  isReply?: boolean;
  playbackLock?: boolean;
}

export interface PeerVoiceStatusMessage extends BasePeerMessage {
  type: 'peer-voice-status';
  peerId: string;
  sender: string;
  isMuted: boolean;
}

export interface PeerByeMessage extends BasePeerMessage {
  type: 'peer-bye';
}

export interface NetPingMessage extends BasePeerMessage {
  type: 'net-ping';
  pingId: string;
  sendTime: number;
}

export interface NetPongMessage extends BasePeerMessage {
  type: 'net-pong';
  pingId: string;
  sendTime: number;
}

// Chat, Reactions, Soundboard
export interface ChatMessage extends BasePeerMessage {
  type: 'chat';
  id: string;
  sender: string;
  isHost?: boolean;
  text: string;
}

export interface P2PImageStartMessage extends BasePeerMessage {
  type: 'p2p-image-start';
  id: string;
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  caption?: string;
}

export interface ReactionMessage extends BasePeerMessage {
  type: 'reaction';
  id: string;
  emoji: string;
  lane?: number;
  combo?: number;
}

export interface SoundboardSfxMessage extends BasePeerMessage {
  type: 'soundboard-sfx';
  soundId: string;
  soundName: string;
  emoji: string;
}

// Playback & Synchronization
export type PlaybackActionKind = 'load' | 'play' | 'pause' | 'seek' | 'close' | 'unload';

export interface YouTubeActionMessage extends BasePeerMessage {
  type: 'yt-action';
  action: PlaybackActionKind;
  newVideoId?: string;
  title?: string;
  currentTime?: number;
  fromHost?: boolean;
  byVote?: boolean;
}

export interface LocalVideoActionMessage extends BasePeerMessage {
  type: 'local-video-action';
  action: PlaybackActionKind | 'subtitle-share' | string;
  fileName?: string;
  fileSize?: number;
  currentTime?: number;
  fromHost?: boolean;
  subtitleInfo?: unknown;
}

export interface RoomSettingsMessage extends BasePeerMessage {
  type: 'room-settings';
  playbackLock: boolean;
}

export interface YouTubeRequestSyncMessage extends BasePeerMessage {
  type: 'yt-request-sync';
}

export type YouTubeSyncStateMessage = BasePeerMessage & (
  | {
      type: 'yt-sync-state';
      videoId: string;
      currentTime: number;
      isPlaying: boolean;
      queue: QueueItem[];
      skipVotes: string[];
      activeVideoTitle?: string;
      nothingPlaying?: never;
    }
  | {
      type: 'yt-sync-state';
      videoId: null;
      nothingPlaying: true;
      queue?: QueueItem[];
      skipVotes?: string[];
      activeVideoTitle?: null;
    }
);

export interface LocalVideoSyncStateMessage extends BasePeerMessage {
  type: 'local-video-sync-state';
  mediaType: 'local';
  fileName: string;
  fileSize: number;
  currentTime: number;
  isPlaying: boolean;
  subtitleInfo?: unknown;
}

export interface MediaActionMessage extends BasePeerMessage {
  type: 'media-action';
  action: PlaybackActionKind;
  media?: MediaItem;
  currentTime?: number;
  fromHost?: boolean;
  byVote?: boolean;
}

export interface MediaSyncStateMessage extends BasePeerMessage {
  type: 'media-sync-state';
  media?: MediaItem | null;
  queue: QueueItem[];
  skipVotes: string[];
  currentTime?: number;
  isPlaying?: boolean;
}

export interface MediaHeartbeatMessage extends BasePeerMessage {
  type: 'media-heartbeat';
  key: string;
  currentTime: number;
  isPlaying: boolean;
}

// Queue
export type QueueActionKind =
  | 'add'
  | 'remove'
  | 'reorder'
  | 'clear'
  | 'play-item'
  | 'next'
  | 'vote-skip'
  | 'vote-skip-passed';

export interface QueueActionMessage extends BasePeerMessage {
  type: 'queue-action';
  action: QueueActionKind;
  item?: QueueItem;
  itemId?: string;
  queue?: QueueItem[];
  nextVideoId?: string | null;
  nextTitle?: string;
  remainingQueue?: QueueItem[];
  skipVotes?: string[];
}

// P2P Stream Sharing (Local Videos)
export interface P2PStreamRequestMessage extends BasePeerMessage {
  type: 'p2p-stream-request';
  requester: string;
  fileName: string;
  supportsRange?: boolean;
  canRelay?: boolean;
  swarm?: boolean;
}

export interface P2PStreamHeaderMessage extends BasePeerMessage {
  type: 'p2p-stream-header';
  mode: 'range' | 'file';
  streamNo: number;
  fileSize: number;
  blockSize?: number;
  via?: string;
  swarm?: boolean;
  totalChunks?: number;
}

export interface P2PRangeRequestMessage extends BasePeerMessage {
  type: 'p2p-range-request';
  streamNo: number;
  blocks: number[];
  urgent?: boolean;
  swarm?: boolean;
}

export interface P2PRangeCancelMessage extends BasePeerMessage {
  type: 'p2p-range-cancel';
  streamNo: number;
  blocks: number[];
}

export interface P2PStreamCompleteMessage extends BasePeerMessage {
  type: 'p2p-stream-complete';
}

export interface P2PStreamCancelMessage extends BasePeerMessage {
  type: 'p2p-stream-cancel';
}

export interface P2PRelayGoneMessage extends BasePeerMessage {
  type: 'p2p-relay-gone';
}

export interface P2PHaveMessage extends BasePeerMessage {
  type: 'p2p-have';
  streamNo: number;
  ranges?: number[];
  add?: number[];
  remove?: number[];
  getting?: number[];
}

export interface P2PRangeMissMessage extends BasePeerMessage {
  type: 'p2p-range-miss';
  streamNo: number;
  blocks: number[];
}

export interface P2PSwarmGoneMessage extends BasePeerMessage {
  type: 'p2p-swarm-gone';
}

export interface P2PHashRequestMessage extends BasePeerMessage {
  type: 'p2p-hash-request';
  streamNo: number;
  blocks: number[];
}

export interface P2PBlockHashesMessage extends BasePeerMessage {
  type: 'p2p-block-hashes';
  streamNo: number;
  hashes: [blockIndex: number, sha256Hex: string][];
}

// File Format Inspection
export interface FileFormatDetails {
  container?: string;
  video?: string;
  audio: string[];
  subtitles: string[];
  duration?: number;
}

export interface FileFormatMessage extends BasePeerMessage {
  type: 'file-format';
  fileName: string;
  fileSize: number;
  format: FileFormatDetails;
}

export interface FileFormatReportMessage extends BasePeerMessage {
  type: 'file-format-report';
  fileName: string;
  verdict: 'ok' | 'maybe' | 'no-video' | 'no-audio';
  message: string;
  device: string;
}

export interface FileSubtitleRequestMessage extends BasePeerMessage {
  type: 'file-subtitle-request';
  fileName: string;
  track: number;
}

export interface FileSubtitleProgressMessage extends BasePeerMessage {
  type: 'file-subtitle-progress';
  fileName: string;
  track: number;
  progress: number;
  done?: boolean;
  error?: string;
}

// Shared State (Games, Activities)
export interface RoomStateMessage<S = unknown> extends BasePeerMessage {
  type: 'room-state';
  key: string;
  v: number;
  state: S;
}

export interface RoomStateActionMessage<A = unknown> extends BasePeerMessage {
  type: 'room-state-action';
  key: string;
  action: A;
}

export interface RoomStateRequestMessage extends BasePeerMessage {
  type: 'room-state-request';
  key: string;
}

export interface RoomStateGoneMessage extends BasePeerMessage {
  type: 'room-state-gone';
  key: string;
}

export type PeerMessage =
  | PeerIdentityMessage
  | PeerVoiceStatusMessage
  | PeerByeMessage
  | NetPingMessage
  | NetPongMessage
  | ChatMessage
  | P2PImageStartMessage
  | ReactionMessage
  | SoundboardSfxMessage
  | YouTubeActionMessage
  | LocalVideoActionMessage
  | RoomSettingsMessage
  | YouTubeRequestSyncMessage
  | YouTubeSyncStateMessage
  | LocalVideoSyncStateMessage
  | MediaActionMessage
  | MediaSyncStateMessage
  | MediaHeartbeatMessage
  | QueueActionMessage
  | P2PStreamRequestMessage
  | P2PStreamHeaderMessage
  | P2PRangeRequestMessage
  | P2PRangeCancelMessage
  | P2PStreamCompleteMessage
  | P2PStreamCancelMessage
  | P2PRelayGoneMessage
  | P2PHaveMessage
  | P2PRangeMissMessage
  | P2PSwarmGoneMessage
  | P2PHashRequestMessage
  | P2PBlockHashesMessage
  | FileFormatMessage
  | FileFormatReportMessage
  | FileSubtitleRequestMessage
  | FileSubtitleProgressMessage
  | RoomStateMessage
  | RoomStateActionMessage
  | RoomStateRequestMessage
  | RoomStateGoneMessage;
