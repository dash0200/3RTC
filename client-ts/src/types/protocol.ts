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
  | 'server-busy'
  | 'rate-limited'
  | 'not-host'
  | 'target-not-found';

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
  topology?: RoomTopologyKind;
  maxUsers?: number;
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

/** The host makes someone else in the room the host */
export interface TransferHostMessage extends BaseSignalingMessage {
  type: 'transfer-host';
  targetPeerId: string;
}

export type RoomTopologyKind = 'mesh' | 'hub';

/** The host switches room topology between full mesh and host-hub */
export interface SetTopologyMessage extends BaseSignalingMessage {
  type: 'set-topology';
  topology: RoomTopologyKind;
}

/** The host dynamically sets maximum peers allowed in the room */
export interface SetRoomSizeMessage extends BaseSignalingMessage {
  type: 'set-room-size';
  maxUsers: number;
}

// Server -> Browser
export interface RoomCreatedMessage extends BaseSignalingMessage {
  type: 'room-created';
  roomId: string;
  peerId: string;
  hostPeerId: string;
  seatToken: string;
  hostToken: string;
  topology?: RoomTopologyKind;
  maxUsers?: number;
}

export interface RoomResumedMessage extends BaseSignalingMessage {
  type: 'room-resumed';
  roomId: string;
  peerId: string;
  peers: string[];
  hostPeerId: string;
  seatToken: string;
  hostToken: string;
  topology?: RoomTopologyKind;
  maxUsers?: number;
}

export interface JoinedMessage extends BaseSignalingMessage {
  type: 'joined';
  roomId: string;
  peerId: string;
  peers: string[];
  hostPeerId: string;
  seatToken: string;
  hostToken?: string;
  topology?: RoomTopologyKind;
  maxUsers?: number;
}

export interface HostUpdateMessage extends BaseSignalingMessage {
  type: 'host';
  hostPeerId: string;
  /** Set when the host handed the room on: who did it */
  from?: string;
  /** 'host-left': the host left and didn't come back in time, so the server picked the next host */
  reason?: string;
}

/** To the new host after a transfer: its host token */
export interface HostTokenMessage extends BaseSignalingMessage {
  type: 'host-token';
  roomId: string;
  hostToken: string;
}

/** Broadcast to all room peers when host changes network topology */
export interface TopologyChangedMessage extends BaseSignalingMessage {
  type: 'topology-changed';
  topology: RoomTopologyKind;
  hostPeerId: string;
}

/** Broadcast to all room peers when host changes room capacity */
export interface RoomSizeChangedMessage extends BaseSignalingMessage {
  type: 'room-size-changed';
  maxUsers: number;
  from?: string;
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
  | PingMessage
  | TransferHostMessage
  | SetTopologyMessage
  | SetRoomSizeMessage;

export type IncomingSignalingMessage =
  | RoomCreatedMessage
  | RoomResumedMessage
  | JoinedMessage
  | HostUpdateMessage
  | HostTokenMessage
  | TopologyChangedMessage
  | RoomSizeChangedMessage
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
  topology?: RoomTopologyKind;
  maxUsers?: number;
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

export type CandidatePathKind = 'host' | 'srflx' | 'prflx' | 'relay';

export interface PeerLinkMetric {
  rttMs: number;
  candidateType: CandidatePathKind;
  lossPct: number;
  jitterMs: number;
  downloadKBps?: number;
  uploadKBps?: number;
}

/** Broadcast across DataChannels so every room participant knows the full P2P distance topology */
export interface NetTopologyReportMessage extends BasePeerMessage {
  type: 'net-topology-report';
  from: string;
  links: Record<string, PeerLinkMetric>;
}

// Chat, Reactions, Soundboard
export interface ChatMessage extends BasePeerMessage {
  type: 'chat';
  id: string;
  sender: string;
  isHost?: boolean;
  text: string;
  /** The message it answers (features/chat/chatFields.ts) */
  replyTo?: { id: string; sender: string; text: string };
  /** Peer ids named with @Name */
  mentions?: string[];
}

export interface CameraStatusMessage extends BasePeerMessage {
  type: 'camera-status';
  on: boolean;
}

/**
 * QUIC file transfer, desktop app to desktop app only (desktop/docs/adr/0009). The web app never
 * sends or reads these; they're here so both apps' message lists stay the same.
 */
export interface QuicOfferMessage extends BasePeerMessage {
  type: 'quic-offer';
  transferId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  addrs: string[];
  certSha256: string;
  token: string;
  /** In a folder being sent: the file's path inside it */
  relativePath?: string;
}

export interface QuicAnswerMessage extends BasePeerMessage {
  type: 'quic-answer';
  transferId: string;
  addrs: string[];
  offset?: number;
}

export interface QuicFallbackMessage extends BasePeerMessage {
  type: 'quic-fallback';
  transferId: string;
  reason?: string;
}

export interface P2PImageStartMessage extends BasePeerMessage {
  type: 'p2p-image-start';
  id: string;
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  caption?: string;
  totalChunks?: number;
  sender?: string;
  isHost?: boolean;
}

export interface P2PFileStartMessage extends BasePeerMessage {
  type: 'p2p-file-start';
  id: string;
  transferId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  caption?: string;
  sender?: string;
  isHost?: boolean;
}

/**
 * `accept`: a receiver wants a big file (8 MB or more) or a folder's file; only then does the
 * sender send it to them. `cancel` from the file's sender: cancelled for everyone (with a folder's
 * id: the whole folder). From a receiver: only that receiver stops getting it; once nobody waits
 * for or receives it, the sender stops (docs/PROTOCOL.md).
 */
export interface P2PFileControlMessage extends BasePeerMessage {
  type: 'p2p-file-control';
  transferId: string;
  action: 'pause' | 'resume' | 'accept' | 'cancel';
  startChunk?: number;
}

/** A folder offered in chat (desktop app, bulk channel): each file is sent on `accept`. */
export interface P2PFolderOfferMessage extends BasePeerMessage {
  type: 'p2p-folder-offer';
  id: string;
  folderId: string;
  name: string;
  caption?: string;
  isHost?: boolean;
  files: Array<{
    transferId: string;
    /** Its path inside the folder, the folder's name first (`Photos/2026/a.jpg`). */
    path: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
  }>;
}

export interface P2PFileSyncMessage extends BasePeerMessage {
  type: 'p2p-file-sync';
  transferId: string;
  resumeFromChunk: number;
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
  topology?: RoomTopologyKind;
  maxUsers?: number;
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
/**
 * Desktop viewer → desktop sharer: the tallest screen-share picture this viewer wants (0: as sent).
 * Only the desktop app sends or reads it; listed so the shapes stay in one place (docs/PROTOCOL.md).
 */
export interface ScreenQualityMessage extends BasePeerMessage {
  type: 'screen-quality';
  maxHeight: number;
}

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
  | NetTopologyReportMessage
  | ChatMessage
  | P2PImageStartMessage
  | P2PFileStartMessage
  | P2PFolderOfferMessage
  | P2PFileControlMessage
  | P2PFileSyncMessage
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
  | ScreenQualityMessage
  | FileSubtitleRequestMessage
  | FileSubtitleProgressMessage
  | RoomStateMessage
  | RoomStateActionMessage
  | RoomStateRequestMessage
  | RoomStateGoneMessage
  | CameraStatusMessage
  | QuicOfferMessage
  | QuicAnswerMessage
  | QuicFallbackMessage;
