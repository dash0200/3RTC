/**
 * The connection layer: the signaling socket, one RTCPeerConnection per person in the room (a
 * full mesh, up to MAX_ROOM_SIZE people), their data channels and voice, recovery, and leaving.
 *
 * Features never see any of this. They talk through the room bus (core/roomBus.js), which this
 * hook feeds: every message that arrives goes to bus.dispatch, a channel opening emits
 * 'peer-open', a peer going away emits 'peer-close', and leaving the room emits 'room-left'.
 */

import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import { getClientId } from '../utils/clientId';
import { sound } from '../utils/sound';
import { micPipeline } from '../utils/micPipeline';
import { speakingActivity } from '../utils/speakingActivity';
import { ICE_SERVERS, BULK_CHANNEL_ID, RECOVERY, PROTOCOL_VERSION } from './config';
import { extractAudioSdp, setVoiceRoomSize, tuneSdpForDiscordAudio, tuneAudioSender } from './sdp';
import { teardownPeerEntry } from './peerEntry';
import { attachRemoteAudio } from './remoteAudio';
import { attachPeerRecovery } from './peerRecovery';
import { createPeerMessageHandler } from './peerMessages';
import { processSignalingMessage } from './signalingMessages';
import { BUILD } from '../version';
import { useSignalingConnection, type SignalStatus, type RoomTokens } from '../hooks/useSignalingConnection';
import { candidateType, type NetworkHint } from './networkHint';
import { findRoomOn, sameServer } from './findRoom';
import type { IncomingSignalingMessage, OutgoingSignalingMessage, RoomBus } from '../types';
import type { PeerEntryRecord } from './peerEntry';
import type { PeerMetadataRecord } from './peerMessages';

const WAITING_TEXT = 'Waiting for peer to enter 5-digit code...';

export interface PeerMeshVoiceContext {
  isAudioBlockedRef: MutableRefObject<boolean>;
  localMutedPeersRef: MutableRefObject<Record<string, boolean>>;
  peerVolumesRef: MutableRefObject<Record<string, number>>;
  localStreamRef: MutableRefObject<MediaStream | null>;
  isMicMutedRef: MutableRefObject<boolean>;
  setPeerVoiceStates: (updater: (prev: Record<string, { isMuted: boolean }>) => Record<string, { isMuted: boolean }>) => void;
}

export interface PeerMeshNoticesContext {
  addSystemMessage: (text: string) => void;
  showToast: (text: string) => void;
}

export interface PeerMeshContext {
  bus: RoomBus;
  peersRef: MutableRefObject<Map<string, PeerEntryRecord>>;
  peerIdRef: MutableRefObject<string | null>;
  isHostRef: MutableRefObject<boolean>;
  hostPeerIdRef: MutableRefObject<string | null | undefined>;
  setHostPeerId?: (hostPeerId: string | null | undefined) => void;
  setPeerMetadata: (
    updater:
      | Record<string, PeerMetadataRecord>
      | ((prev: Record<string, PeerMetadataRecord>) => Record<string, PeerMetadataRecord>)
  ) => void;
  username: string;
  notices: PeerMeshNoticesContext;
  identityFields?: () => Record<string, unknown>;
  voice: PeerMeshVoiceContext;
  signalUrl: string;
  fallbackUrls?: string[];
  setSignalStatus: (status: SignalStatus) => void;
  logLocalDebug: (tag: string, detail: string) => void;
  /** See SignalingContext.onRoomError */
  onRoomError?: (message: string, roomId: string | null) => boolean;
  /** See SignalingContext.onHostChanged */
  onHostChanged?: (hostPeerId: string, fromPeerId: string) => void;
}

export interface PeerMeshHookResult {
  roomId: string | null;
  isHost: boolean;
  peerCount: number;
  isP2PConnected: boolean;
  p2pStatusText: string;
  createRoom: (resumeRoomId?: string | null, hostToken?: string | null) => void;
  joinRoom: (pin: string) => void;
  leaveRoom: () => void;
  sendSignal: (data: OutgoingSignalingMessage | Record<string, unknown>) => void;
  transferHost: (targetPeerId: string) => void;
  getHostToken: () => string | null;
  networkHint: NetworkHint | null;
  dismissNetworkHint: () => void;
}

export function usePeerMesh(ctx: PeerMeshContext): PeerMeshHookResult {
  const {
    bus,
    peersRef,
    peerIdRef,
    isHostRef,
    hostPeerIdRef,
    setHostPeerId,
    setPeerMetadata,
    username,
    notices,
    identityFields,
    voice,
    signalUrl,
    fallbackUrls = [],
    setSignalStatus,
    logLocalDebug,
    onRoomError,
    onHostChanged
  } = ctx;
  const onRoomErrorRef = useRef(onRoomError);
  onRoomErrorRef.current = onRoomError;
  const onHostChangedRef = useRef(onHostChanged);
  onHostChangedRef.current = onHostChanged;
  const { addSystemMessage, showToast } = notices;
  const {
    isAudioBlockedRef,
    localMutedPeersRef,
    peerVolumesRef,
    localStreamRef,
    isMicMutedRef,
    setPeerVoiceStates
  } = voice;

  const [roomId, setRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState<boolean>(false);
  const [peerCount, setPeerCount] = useState<number>(0);
  const [isP2PConnected, setIsP2PConnected] = useState<boolean>(false);
  const [p2pStatusText, setP2pStatusText] = useState<string>(WAITING_TEXT);
  const [networkHint, setNetworkHint] = useState<NetworkHint | null>(null);
  const dismissNetworkHint = useCallback(() => setNetworkHint(null), []);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingSignalsRef = useRef<OutgoingSignalingMessage[]>([]);
  const currentRoomRef = useRef<string | null>(null);
  const roomTokensRef = useRef<RoomTokens>({ roomId: null, seat: null, host: null });
  currentRoomRef.current = roomId;
  isHostRef.current = isHost;
  const getOrCreatePeerConnectionRef = useRef<((peerId: string, isInitiator: boolean) => PeerEntryRecord | undefined) | null>(null);
  const identityFieldsRef = useRef(identityFields);
  identityFieldsRef.current = identityFields;
  const usernameRef = useRef(username);
  usernameRef.current = username;

  // Voice bitrate per connection follows the room size (128 kbps up to 4 people, 64 kbps above)
  useEffect(() => {
    if (peerCount > 0) setVoiceRoomSize(peerCount, peersRef.current.values());
  }, [peerCount, peersRef]);

  const updateP2PStatus = useCallback(() => {
    const active = Array.from(peersRef.current.values()).filter((p) => p.isConnected).length;
    setIsP2PConnected(active > 0);
    setP2pStatusText(
      active > 0
        ? `Direct P2P Active (${active} peer${active > 1 ? 's' : ''} connected)`
        : WAITING_TEXT
    );
  }, [peersRef]);

  // Buffers the message while the socket is still connecting
  const sendSignal = useCallback((data: OutgoingSignalingMessage | Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      pendingSignalsRef.current.push(data as OutgoingSignalingMessage);
    }
  }, []);

  const cleanupPeer = useCallback(
    (targetPeerId: string) => {
      const entry = peersRef.current.get(targetPeerId);
      if (!entry) return;
      teardownPeerEntry(entry);
      peersRef.current.delete(targetPeerId);
      bus.emitEvent('peer-close', targetPeerId);
      setPeerMetadata((prev) => {
        const next = { ...prev };
        delete next[targetPeerId];
        return next;
      });
      speakingActivity.removePeer(targetPeerId);
      updateP2PStatus();
    },
    [bus, peersRef, setPeerMetadata, updateP2PStatus]
  );

  /** What we tell each peer about ourselves when a channel opens. */
  const getIdentity = useCallback(
    () => ({
      type: 'peer-identity',
      peerId: peerIdRef.current,
      username: usernameRef.current,
      isHost: isHostRef.current,
      isMuted: isMicMutedRef.current,
      proto: PROTOCOL_VERSION,
      build: BUILD.number,
      clientId: getClientId(),
      ...(identityFieldsRef.current?.() || {})
    }),
    [peerIdRef, isHostRef, isMicMutedRef]
  );

  const currentScreenTrackRef = useRef<MediaStreamTrack | null>(null);

  // Sync screen share track across all active peer connections when local user shares or stops
  useEffect(() => {
    const off = bus.onEvent<MediaStreamTrack | null>('set-screen-track', (track) => {
      currentScreenTrackRef.current = track;
      for (const peer of peersRef.current.values()) {
        if (peer.videoTransceiver?.sender) {
          peer.videoTransceiver.sender.replaceTrack(track).catch(() => {});
        }
      }
    });
    return off;
  }, [bus, peersRef]);

  const getOrCreatePeerConnection = useCallback(
    (targetPeerId: string, isInitiator: boolean) => {
      if (peersRef.current.has(targetPeerId)) return peersRef.current.get(targetPeerId);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const peerEntry: PeerEntryRecord = {
        pc,
        dataChannel: null,
        bulkChannel: null,
        isConnected: false,
        candidateQueue: [] as RTCIceCandidateInit[],
        audioElement: null,
        audioTransceiver: null,
        videoTransceiver: null,
        isInitiator: Boolean(isInitiator),
        applyingRemote: false,
        recoveryTimer: null,
        restartAttempts: 0,
        brokenSince: 0,
        wasInterrupted: false,
        signalingGone: false,
        rebuilt: false
      };
      peersRef.current.set(targetPeerId, peerEntry);

      // Bulk channel (video stream / images), same pre-agreed id on both sides
      try {
        const bulk = pc.createDataChannel('bulk', {
          negotiated: true,
          id: BULK_CHANNEL_ID,
          ordered: true
        });
        bulk.binaryType = 'arraybuffer';
        peerEntry.bulkChannel = bulk;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logLocalDebug('BULK_CHANNEL_ERR', msg);
      }

      // Voice transceivers
      try {
        if (isInitiator) {
          let audioTransceiver =
            pc.getTransceivers?.().find(
              (t) =>
                t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'
            ) || null;
          if (!audioTransceiver) {
            audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
          } else {
            audioTransceiver.direction = 'sendrecv';
          }
          peerEntry.audioTransceiver = audioTransceiver;
          if (localStreamRef.current) {
            const audioTrack =
              micPipeline.getOutputTrack() || localStreamRef.current.getAudioTracks()[0];
            if (audioTrack && !isMicMutedRef.current && audioTransceiver?.sender) {
              audioTransceiver.sender.replaceTrack(audioTrack).catch(() => {});
            }
          }

          // Screen share video transceiver
          let videoTransceiver =
            pc.getTransceivers?.().find(
              (t) =>
                t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video'
            ) || null;
          if (!videoTransceiver) {
            videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
          } else {
            videoTransceiver.direction = 'sendrecv';
          }
          peerEntry.videoTransceiver = videoTransceiver;
          if (currentScreenTrackRef.current && videoTransceiver?.sender) {
            videoTransceiver.sender.replaceTrack(currentScreenTrackRef.current).catch(() => {});
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logLocalDebug('TRANSCEIVER_INIT_ERR', msg);
      }

      attachRemoteAudio(pc, {
        isAudioBlockedRef,
        localMutedPeersRef,
        logLocalDebug,
        peerEntry,
        peerVolumesRef,
        targetPeerId,
        onRemoteVideoStream: (peerId, stream, track) => {
          bus.emitEvent('remote-screen-stream', { peerId, stream, track });
        },
        onRemoteVideoStreamEnded: (peerId) => {
          bus.emitEvent('remote-screen-stream-ended', { peerId });
        },
        onRemoteScreenAudioStream: (peerId, stream, track) => {
          bus.emitEvent('remote-screen-audio', { peerId, stream, track });
        }
      });

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const kind = candidateType(event.candidate);
        if (kind) (peerEntry.localCandidateTypes ||= new Set<string>()).add(kind);
        sendSignal({
          type: 'ice-candidate',
          targetId: targetPeerId,
          candidate: event.candidate
        });
      };

      const { isStillCurrent, scheduleRecovery } = attachPeerRecovery(pc, {
        addSystemMessage,
        setNetworkHint,
        cleanupPeer,
        getOrCreatePeerConnectionRef,
        logLocalDebug,
        peerEntry,
        peersRef,
        sendSignal,
        setPeerCount,
        showToast,
        targetPeerId,
        updateP2PStatus,
        wsRef
      });

      const bindDataChannel = (dc: RTCDataChannel) => {
        peerEntry.dataChannel = dc;
        try {
          dc.binaryType = 'arraybuffer';
        } catch {
          // ignore
        }

        dc.onopen = () => {
          peerEntry.isConnected = true;
          updateP2PStatus();
          sound.playChime();
          addSystemMessage(
            'Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!'
          );
          showToast('Direct P2P Connected!');
          try {
            dc.send(JSON.stringify(getIdentity()));
            dc.send(
              JSON.stringify({
                type: 'peer-voice-status',
                peerId: peerIdRef.current,
                sender: usernameRef.current,
                isMuted: isMicMutedRef.current
              })
            );
          } catch {
            // ignore
          }
          bus.emitEvent('peer-open', targetPeerId);
        };

        dc.onmessage = createPeerMessageHandler({
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
        });

        dc.onclose = () => {
          bus.emitEvent('channel-close', targetPeerId);
          if (!isStillCurrent()) return;
          peerEntry.isConnected = false;
          updateP2PStatus();
          if (peerEntry.byeReceived || peerEntry.signalingGone) {
            cleanupPeer(targetPeerId);
            setPeerCount(peersRef.current.size + 1);
          } else if (pc.connectionState !== 'closed') {
            peerEntry.wasInterrupted = true;
            scheduleRecovery(RECOVERY.disconnectGraceMs);
          }
        };
        dc.onerror = () => {};

        if (peerEntry.bulkChannel) peerEntry.bulkChannel.onmessage = dc.onmessage;
      };

      if (isInitiator) {
        try {
          bindDataChannel(pc.createDataChannel(`chat-${targetPeerId}`, { ordered: true }));
          pc.createOffer()
            .then((offer) => {
              const tunedOffer = {
                type: offer.type,
                sdp: tuneSdpForDiscordAudio(offer.sdp)
              };
              return pc.setLocalDescription(tunedOffer).then(() => {
                tuneAudioSender(pc);
                logLocalDebug(
                  'OFFER_SENT',
                  `To: ${targetPeerId} | SDP: ${extractAudioSdp(tunedOffer.sdp)}`
                );
                sendSignal({
                  type: 'offer',
                  targetId: targetPeerId,
                  fresh: true,
                  offer: { type: tunedOffer.type, sdp: tunedOffer.sdp }
                });
              });
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logLocalDebug('OFFER_ERR', `Target: ${targetPeerId} error: ${msg}`);
            });
        } catch {
          // ignore
        }
      } else {
        pc.ondatachannel = (event) => bindDataChannel(event.channel);
      }
      return peerEntry;
    },
    [
      addSystemMessage,
      bus,
      cleanupPeer,
      getIdentity,
      hostPeerIdRef,
      isAudioBlockedRef,
      isMicMutedRef,
      localMutedPeersRef,
      localStreamRef,
      logLocalDebug,
      peerIdRef,
      peerVolumesRef,
      peersRef,
      sendSignal,
      setPeerMetadata,
      setPeerVoiceStates,
      showToast,
      updateP2PStatus
    ]
  );
  getOrCreatePeerConnectionRef.current = getOrCreatePeerConnection;

  // Rooms live on the server they were made on (the app may be on a fallback): see findRoom.ts
  const findRoomElsewhereRef = useRef<(code: string, notFoundMessage: string) => boolean>(() => false);
  const lastRoomSearchRef = useRef<{ code: string; at: number } | null>(null);

  const handleSignalingMessage = useCallback(
    (msg: IncomingSignalingMessage) =>
      processSignalingMessage(msg, {
        addSystemMessage,
        cleanupPeer,
        currentRoomRef,
        currentScreenTrackRef,
        getOrCreatePeerConnection,
        isHostRef,
        isMicMutedRef,
        localStreamRef,
        logLocalDebug,
        peerIdRef,
        peersRef,
        roomTokensRef,
        sendSignal,
        setHostPeerId,
        setIsHost,
        setP2pStatusText,
        setPeerCount,
        setRoomId,
        showToast,
        username,
        findRoomElsewhere: (code: string, notFoundMessage: string) => findRoomElsewhereRef.current(code, notFoundMessage),
        onRoomError: (message: string, room: string | null) => onRoomErrorRef.current?.(message, room) ?? false,
        onHostChanged: (hostId: string, fromId: string) => onHostChangedRef.current?.(hostId, fromId)
      }),
    [
      peerIdRef,
      setHostPeerId,
      addSystemMessage,
      cleanupPeer,
      getOrCreatePeerConnection,
      isHostRef,
      isMicMutedRef,
      localStreamRef,
      logLocalDebug,
      peersRef,
      sendSignal,
      showToast,
      username
    ]
  );

  const switchServer = useSignalingConnection({
    addSystemMessage,
    currentRoomRef,
    fallbackUrls,
    handleSignalingMessage,
    isHostRef,
    peerIdRef,
    peersRef,
    pendingSignalsRef,
    roomTokensRef,
    setSignalStatus,
    showToast,
    signalUrl,
    wsRef
  });

  findRoomElsewhereRef.current = (code: string, notFoundMessage: string) => {
    if (!/^\d{5}$/.test(code)) return false;
    const last = lastRoomSearchRef.current;
    if (last && last.code === code && Date.now() - last.at < 30000) return false; // looked already
    const here = wsRef.current?.url;
    const others = [...new Set([signalUrl, ...fallbackUrls])].filter((url) => url && !sameServer(url, here));
    if (!others.length) return false;
    lastRoomSearchRef.current = { code, at: Date.now() };
    void findRoomOn(others, code).then((url) => {
      if (currentRoomRef.current) return; // in a room by now
      if (!url) {
        const message = notFoundMessage || `Room "${code}" not found. Please verify the 5-digit code or create a room.`;
        if (!onRoomErrorRef.current?.(message, code)) showToast(message);
        return;
      }
      addSystemMessage(`🔄 Room ${code} is on another 3RTC server. Connecting there...`);
      pendingSignalsRef.current.push({ type: 'join', roomId: code, peerId: peerIdRef.current || '' });
      switchServer(url);
    });
    return true;
  };

  const createRoom = useCallback(
    (resumeRoomId?: string | null, hostToken?: string | null) =>
      sendSignal({
        type: 'create-room',
        peerId: peerIdRef.current || '',
        ...(resumeRoomId
          ? { roomId: String(resumeRoomId), ...(hostToken ? { hostToken } : {}) }
          : {})
      }),
    [peerIdRef, sendSignal]
  );

  const getHostToken = useCallback(() => roomTokensRef.current.host, []);

  // The host makes someone else in the room the host (the server checks we are the host)
  const transferHost = useCallback(
    (targetPeerId: string) => sendSignal({ type: 'transfer-host', targetPeerId }),
    [sendSignal]
  );

  const joinRoom = useCallback(
    (pin: string) =>
      sendSignal({ type: 'join', roomId: pin, peerId: peerIdRef.current || '' }),
    [peerIdRef, sendSignal]
  );

  const leaveRoom = useCallback(() => {
    if (currentRoomRef.current) sendSignal({ type: 'leave' });
    for (const entry of peersRef.current.values()) teardownPeerEntry(entry, { sayBye: true });
    peersRef.current.clear();
    setPeerMetadata({});
    speakingActivity.clearPeers();
    setIsP2PConnected(false);
    setP2pStatusText(WAITING_TEXT);
    setRoomId(null);
    setIsHost(false);
    isHostRef.current = false;
    setPeerCount(0);
    roomTokensRef.current = { roomId: null, seat: null, host: null };
    setHostPeerId?.(undefined);
    setNetworkHint(null);
    bus.emitEvent('room-left');
  }, [bus, isHostRef, peersRef, sendSignal, setHostPeerId, setPeerMetadata]);

  return {
    roomId,
    isHost,
    peerCount,
    isP2PConnected,
    p2pStatusText,
    createRoom,
    joinRoom,
    leaveRoom,
    sendSignal,
    getHostToken,
    transferHost,
    networkHint,
    dismissNetworkHint
  };
}
