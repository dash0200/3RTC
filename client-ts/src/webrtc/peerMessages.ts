/**
 * Everything that arrives on a peer's data channels (main and bulk share this handler).
 *
 * The connection layer handles only what belongs to the connection itself: 'peer-bye' (they left
 * on purpose), 'peer-identity' (name, host flag) and 'peer-voice-status' (mic muted). Every message,
 * including those, is then handed to the room bus, where features subscribe to their own types
 * (core/roomBus.js). Binary frames go to the bus's binary handlers (chat images, video stream).
 */

import { cleanName } from '../utils/names';
import type { RoomBus } from '../types';
import type { PeerEntryRecord } from './peerEntry';

export interface PeerMetadataRecord {
  username?: string;
  isHost?: boolean;
  isMuted?: boolean;
  proto?: number;
  build?: string;
  clientId?: string;
}

export interface PeerMessageHandlerContext {
  bus: RoomBus;
  cleanupPeer: (peerId: string) => void;
  dc: RTCDataChannel;
  getIdentity: () => Record<string, unknown>;
  hostPeerIdRef: { current: string | null | undefined };
  isAudioBlockedRef: { current: boolean };
  isStillCurrent: () => boolean;
  peerEntry: PeerEntryRecord;
  peersRef: { current: Map<string, PeerEntryRecord> };
  setPeerCount: (count: number) => void;
  setPeerMetadata: (updater: (prev: Record<string, PeerMetadataRecord>) => Record<string, PeerMetadataRecord>) => void;
  setPeerVoiceStates: (updater: (prev: Record<string, { isMuted: boolean }>) => Record<string, { isMuted: boolean }>) => void;
  targetPeerId: string;
}

/**
 * What a peer's message says about who sent it is checked here, once for every feature: `isHost`
 * comes from the signaling server (who made the room), not the sender; names are cleaned.
 */
export function normalizeSender(
  data: Record<string, any>,
  fromPeerId: string,
  hostPeerIdRef?: { current: string | null | undefined }
): void {
  if ('isHost' in data) {
    const hostId = hostPeerIdRef?.current;
    data.isHost = Boolean(hostId && fromPeerId === hostId);
  }
  if ('sender' in data) {
    data.sender = cleanName(data.sender) || undefined;
  }
  if (data.type === 'peer-identity' || data.type === 'peer-voice-status') {
    if ('username' in data) {
      data.username = cleanName(data.username) || undefined;
    }
  }
}

export function createPeerMessageHandler(
  ctx: PeerMessageHandlerContext
): (event: MessageEvent) => Promise<void> {
  const {
    bus,
    cleanupPeer,
    dc,
    getIdentity,
    hostPeerIdRef,
    isAudioBlockedRef,
    isStillCurrent,
    peerEntry,
    peersRef,
    setPeerCount,
    setPeerMetadata,
    setPeerVoiceStates,
    targetPeerId
  } = ctx;

  const handleCore = (data: Record<string, any>): boolean => {
    if (data.type === 'peer-bye') {
      if (isStillCurrent()) {
        (peerEntry as any).byeReceived = true;
        cleanupPeer(targetPeerId);
        setPeerCount(peersRef.current.size + 1);
      }
      return false;
    }
    if (data.type === 'peer-identity') {
      setPeerMetadata((prev) => ({
        ...prev,
        [targetPeerId]: {
          username: data.username || `User_${targetPeerId.slice(0, 4)}`,
          isHost: Boolean(data.isHost),
          isMuted: Boolean(data.isMuted),
          ...(data.proto ? { proto: data.proto } : {}),
          ...(typeof data.build === 'string' ? { build: data.build.slice(0, 20) } : {}),
          ...(typeof data.clientId === 'string' ? { clientId: data.clientId.slice(0, 64) } : {})
        }
      }));
      if (!data.isReply) {
        try {
          dc.send(JSON.stringify({ ...getIdentity(), isReply: true }));
        } catch {
          // ignore send error
        }
      }
    } else if (data.type === 'peer-voice-status') {
      setPeerVoiceStates((prev) => ({
        ...prev,
        [data.sender]: { isMuted: data.isMuted }
      }));
      setPeerMetadata((prev) => ({
        ...prev,
        [targetPeerId]: {
          ...(prev[targetPeerId] || {}),
          username:
            data.sender || prev[targetPeerId]?.username || `User_${targetPeerId.slice(0, 4)}`,
          isMuted: data.isMuted
        }
      }));
      if (!data.isMuted) {
        for (const peer of peersRef.current.values()) {
          if (peer.audioElement && !isAudioBlockedRef.current) {
            peer.audioElement.play().catch(() => {});
          }
        }
      }
    }
    return true;
  };

  return async (event: MessageEvent) => {
    let arrayBuffer: ArrayBuffer | null = null;
    if (event.data instanceof ArrayBuffer) {
      arrayBuffer = event.data;
    } else if (event.data instanceof Blob) {
      try {
        arrayBuffer = await event.data.arrayBuffer();
      } catch {
        // ignore blob read error
      }
    }
    if (arrayBuffer) {
      bus.dispatchBinary(arrayBuffer, targetPeerId);
      return;
    }

    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    normalizeSender(data, targetPeerId, hostPeerIdRef);
    if (handleCore(data)) bus.dispatch(data, targetPeerId);
  };
}
