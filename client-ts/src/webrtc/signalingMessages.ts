/**
 * Messages from the signaling server: room created / resumed / joined, peers joining and leaving,
 * and the offer / answer / ICE candidate exchange that sets up (and restarts) peer connections.
 */
import { micPipeline } from '../utils/micPipeline';
import { extractAudioSdp, tuneSdpForDiscordAudio, tuneAudioSender } from './sdp';
import type { IncomingSignalingMessage, OutgoingSignalingMessage } from '../types';
import type { RoomTokens } from '../hooks/useSignalingConnection';
import type { PeerEntryRecord } from './peerEntry';

export interface SignalingContext {
  setRoomId: (id: string | null) => void;
  setIsHost: (isHost: boolean) => void;
  isHostRef: { current: boolean };
  setPeerCount: (count: number) => void;
  setP2pStatusText: (text: string) => void;
  addSystemMessage: (text: string) => void;
  showToast: (text: string) => void;
  username: string;
  peersRef: { current: Map<string, PeerEntryRecord> };
  getOrCreatePeerConnection: (peerId: string, isInitiator: boolean) => PeerEntryRecord | undefined;
  cleanupPeer: (peerId: string) => void;
  currentRoomRef: { current: string | null };
  currentScreenTrackRef?: { current: MediaStreamTrack | null };
  localStreamRef: { current: MediaStream | null };
  isMicMutedRef: { current: boolean };
  logLocalDebug: (tag: string, detail: string) => void;
  sendSignal: (msg: OutgoingSignalingMessage | Record<string, unknown>) => void;
  setHostPeerId?: (hostPeerId: string | null | undefined) => void;
  setTopology?: (topology: 'mesh' | 'hub') => void;
  hostPeerIdRef?: { current: string | null | undefined };
  topologyRef?: { current: 'mesh' | 'hub' };
  roomTokensRef?: { current: RoomTokens };
  peerIdRef?: { current: string | null };
  /** "Room not found" here: look for it on the other servers. True if a search started (it tells
   *  the user itself); false to show `notFoundMessage` now. */
  findRoomElsewhere?: (roomId: string, notFoundMessage: string) => boolean;
  /** Couldn't get into a room (full, not found...) before being in one: show it where the user joined.
   *  True if shown there (then no toast). */
  onRoomError?: (message: string, roomId: string | null) => boolean;
  /** The host handed the room to `hostPeerId` (`fromPeerId` did it) */
  onHostChanged?: (hostPeerId: string, fromPeerId: string) => void;
}

// Errors that mean "you didn't get into the room"
const ROOM_ERROR_CODES = new Set(['not-found', 'room-full', 'seat-taken', 'rate-limited', 'server-busy']);

export async function processSignalingMessage(
  msg: IncomingSignalingMessage,
  ctx: SignalingContext
): Promise<void> {
  const {
    addSystemMessage,
    cleanupPeer,
    currentRoomRef,
    currentScreenTrackRef,
    getOrCreatePeerConnection,
    hostPeerIdRef,
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
    topologyRef,
    username
  } = ctx;

  if (
    roomTokensRef &&
    (msg.type === 'room-created' || msg.type === 'room-resumed' || msg.type === 'joined')
  ) {
    roomTokensRef.current = {
      roomId: String(msg.roomId),
      seat: typeof msg.seatToken === 'string' ? msg.seatToken : null,
      host: typeof msg.hostToken === 'string' ? msg.hostToken : null
    };
    setHostPeerId?.('hostPeerId' in msg && typeof msg.hostPeerId === 'string' ? msg.hostPeerId : null);
    if ('topology' in msg && msg.topology) {
      ctx.setTopology?.(msg.topology);
    }
  }

  switch (msg.type) {
    case 'room-created': {
      setRoomId(msg.roomId);
      setIsHost(true);
      isHostRef.current = true;
      setPeerCount(1);
      setP2pStatusText('Waiting for peer to enter 5-digit code...');
      addSystemMessage(`You created room ${msg.roomId} as "${username}".`);
      showToast(`Created room ${msg.roomId}`);
      break;
    }

    case 'room-resumed': {
      setRoomId(msg.roomId);
      setIsHost(true);
      isHostRef.current = true;
      for (const peerId of msg.peers || []) {
        const known = peersRef.current.get(peerId);
        if (known) {
          known.signalingGone = false;
        } else {
          getOrCreatePeerConnection(peerId, false);
        }
      }
      setPeerCount(peersRef.current.size + 1);
      break;
    }

    case 'joined': {
      setRoomId(msg.roomId);
      setIsHost(false);
      isHostRef.current = false;
      const count = (msg.peers ? msg.peers.length : 0) + 1;
      setPeerCount(count);
      addSystemMessage(`You joined room ${msg.roomId} as "${username}".`);
      showToast(`Joined room ${msg.roomId}`);

      if (msg.peers && msg.peers.length > 0) {
        setP2pStatusText('Connecting direct P2P data channels...');
        const isHub = ('topology' in msg && msg.topology === 'hub') || topologyRef?.current === 'hub';
        const hostId = ('hostPeerId' in msg && typeof msg.hostPeerId === 'string' ? msg.hostPeerId : hostPeerIdRef?.current) || null;
        for (const peerId of msg.peers) {
          if (isHub && !isHostRef.current && hostId && peerId !== hostId) {
            continue; // In Hub mode, non-host guests only connect to the host
          }
          const known = peersRef.current.get(peerId);
          if (known) {
            known.signalingGone = false;
          } else {
            getOrCreatePeerConnection(peerId, false);
          }
        }
      }
      break;
    }

    case 'peer-joined': {
      const isHub = topologyRef?.current === 'hub';
      const hostId = hostPeerIdRef?.current;
      if (isHub && !isHostRef.current && hostId && msg.peerId !== hostId) {
        // In Hub mode, non-host guests do not connect directly to other non-hosts
        break;
      }
      const knownEntry = peersRef.current.get(msg.peerId);
      if (knownEntry) {
        knownEntry.signalingGone = false;
        if (
          knownEntry.pc?.connectionState === 'connected' &&
          knownEntry.dataChannel?.readyState === 'open'
        ) {
          break;
        }
        cleanupPeer(msg.peerId);
      } else {
        addSystemMessage(
          `A peer entered room ${currentRoomRef.current}. Establishing P2P connection...`
        );
      }
      setPeerCount(peersRef.current.size + 2);
      setP2pStatusText('Connecting direct P2P data channel...');
      getOrCreatePeerConnection(msg.peerId, true);
      break;
    }

    case 'offer': {
      try {
        const senderId = msg.from;
        const existing = peersRef.current.get(senderId);
        const fingerprintOf = (sdp?: string) =>
          (sdp?.match(/a=fingerprint:\S+ (\S+)/) || [])[1];
        const knownFingerprint = fingerprintOf(existing?.pc?.remoteDescription?.sdp);
        const isFreshOffer =
          Boolean(msg.fresh) ||
          Boolean(knownFingerprint && knownFingerprint !== fingerprintOf(msg.offer?.sdp));

        if (existing && isFreshOffer && existing.pc?.remoteDescription) {
          cleanupPeer(senderId);
        } else if (
          existing &&
          existing.isInitiator &&
          existing.pc?.signalingState === 'have-local-offer'
        ) {
          logLocalDebug('OFFER_GLARE_IGNORED', `From: ${senderId}`);
          break;
        }
        const peerEntry = getOrCreatePeerConnection(senderId, false);
        const pc = peerEntry?.pc;
        if (!peerEntry || !pc) break;

        const offerAudioSdp = extractAudioSdp(msg.offer?.sdp);
        logLocalDebug('OFFER_RECEIVED', `From: ${senderId} | Offer SDP: ${offerAudioSdp}`);

        const tunedOfferSdp = tuneSdpForDiscordAudio(msg.offer?.sdp);
        peerEntry.applyingRemote = true;
        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: msg.offer.type,
              sdp: tunedOfferSdp
            })
          );
        } finally {
          peerEntry.applyingRemote = false;
        }

        if (pc.getTransceivers) {
          const allTransceivers = pc.getTransceivers();
          let seenAudioTransceiver = false;
          for (const t of allTransceivers) {
            const isVideo =
              t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video';
            if (isVideo) {
              peerEntry.videoTransceiver = t;
              t.direction = 'sendrecv';
              if (currentScreenTrackRef?.current && t.sender) {
                t.sender.replaceTrack(currentScreenTrackRef.current).catch(() => {});
              }
            } else {
              if (!seenAudioTransceiver) {
                seenAudioTransceiver = true;
                peerEntry.audioTransceiver = t;
                t.direction = 'sendrecv';
                if (localStreamRef.current && !isMicMutedRef.current && t.sender) {
                  const audioTrack =
                    micPipeline.getOutputTrack() || localStreamRef.current.getAudioTracks()[0];
                  if (audioTrack) {
                    t.sender.replaceTrack(audioTrack).catch(() => {});
                  }
                }
              } else {
                // Secondary audio line (e.g. incoming screen-audio)
                t.direction = 'recvonly';
              }
            }
          }
        }

        const candidateQueue = peerEntry.candidateQueue || (peerEntry.candidateQueue = []);
        while (candidateQueue.length > 0) {
          const cand = candidateQueue.shift();
          if (cand) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch {
              // ignore candidate error
            }
          }
        }

        const answer = await pc.createAnswer();
        const tunedAnswerSdp = tuneSdpForDiscordAudio(answer.sdp);
        const tunedAnswer = { type: answer.type, sdp: tunedAnswerSdp };
        await pc.setLocalDescription(tunedAnswer);
        tuneAudioSender(pc);

        const answerAudioSdp = extractAudioSdp(tunedAnswer.sdp);
        const tInfo = pc.getTransceivers
          ? pc
              .getTransceivers()
              .map((t) => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`)
              .join(', ')
          : 'none';
        logLocalDebug(
          'ANSWER_SENT',
          `To: ${senderId} | Answer SDP: ${answerAudioSdp} | Transceivers: ${tInfo}`
        );

        sendSignal({
          type: 'answer',
          targetId: senderId,
          answer: {
            type: tunedAnswer.type,
            sdp: tunedAnswer.sdp
          }
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logLocalDebug('OFFER_HANDLE_ERR', msg);
      }
      break;
    }

    case 'answer': {
      try {
        const senderId = msg.from;
        const peerEntry = peersRef.current.get(senderId);
        if (peerEntry && peerEntry.pc) {
          const pc: RTCPeerConnection = peerEntry.pc;
          if (pc.signalingState !== 'have-local-offer') break;
          const tunedAnswerSdp = tuneSdpForDiscordAudio(msg.answer?.sdp);
          peerEntry.applyingRemote = true;
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription({
                type: msg.answer.type,
                sdp: tunedAnswerSdp
              })
            );
          } finally {
            peerEntry.applyingRemote = false;
          }
          tuneAudioSender(pc);
          if (pc.getTransceivers) {
            for (const t of pc.getTransceivers()) {
              if (
                t.sender?.track?.kind === 'video' ||
                t.receiver?.track?.kind === 'video'
              ) {
                peerEntry.videoTransceiver = t;
              } else if (
                t.sender?.track?.kind === 'audio' ||
                t.receiver?.track?.kind === 'audio'
              ) {
                peerEntry.audioTransceiver = t;
              }
            }
          }

          const answerAudioSdp = extractAudioSdp(msg.answer?.sdp);
          const tInfo = pc.getTransceivers
            ? pc
                .getTransceivers()
                .map((t) => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`)
                .join(', ')
            : 'none';
          logLocalDebug(
            'ANSWER_PROCESSED',
            `From: ${senderId} | Answer SDP: ${answerAudioSdp} | Host Transceivers: ${tInfo}`
          );

          const candidateQueue = peerEntry.candidateQueue || (peerEntry.candidateQueue = []);
          while (candidateQueue.length > 0) {
            const cand = candidateQueue.shift();
            if (cand) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logLocalDebug('ANSWER_HANDLE_ERR', msg);
      }
      break;
    }

    case 'ice-candidate': {
      const senderId = msg.from;
      const peerEntry = peersRef.current.get(senderId);
      if (peerEntry && msg.candidate) {
        const pc = peerEntry.pc;
        if (
          pc &&
          pc.remoteDescription &&
          pc.remoteDescription.type &&
          !peerEntry.applyingRemote
        ) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            // ignore
          }
        } else {
          if (!peerEntry.candidateQueue) peerEntry.candidateQueue = [];
          peerEntry.candidateQueue.push(msg.candidate);
        }
      }
      break;
    }

    case 'peer-left': {
      const leftEntry = peersRef.current.get(msg.peerId);
      if (
        leftEntry &&
        leftEntry.pc?.connectionState === 'connected' &&
        leftEntry.dataChannel?.readyState === 'open'
      ) {
        leftEntry.signalingGone = true;
        logLocalDebug(
          'PEER_SIGNALING_GONE',
          `Peer ${msg.peerId}: signaling dropped, P2P still up`
        );
        break;
      }
      cleanupPeer(msg.peerId);
      setPeerCount(peersRef.current.size + 1);
      addSystemMessage('A peer disconnected from the room.');
      break;
    }

    case 'topology-changed': {
      ctx.setTopology?.(msg.topology);
      if (topologyRef) topologyRef.current = msg.topology;
      setHostPeerId?.(msg.hostPeerId);
      if (msg.topology === 'hub' && !isHostRef.current) {
        const hostId = msg.hostPeerId || hostPeerIdRef?.current;
        for (const [peerId] of peersRef.current) {
          if (peerId !== hostId) {
            cleanupPeer(peerId);
          }
        }
      }
      addSystemMessage(
        msg.topology === 'hub'
          ? 'Network topology switched to Host-Hub mode.'
          : 'Network topology switched to Full Mesh mode.'
      );
      showToast(msg.topology === 'hub' ? 'Topology: Host Hub' : 'Topology: Full Mesh');
      break;
    }

    case 'host': {
      setHostPeerId?.(msg.hostPeerId ?? null);
      const selfId = peerIdRef?.current;
      if (selfId && msg.hostPeerId === selfId) {
        // We were made the host
        if (!isHostRef.current) {
          setIsHost(true);
          isHostRef.current = true;
        }
      } else if (isHostRef.current && msg.hostPeerId) {
        // We handed the room on: our host token is no good any more
        setIsHost(false);
        isHostRef.current = false;
        if (roomTokensRef?.current) roomTokensRef.current = { ...roomTokensRef.current, host: null };
      }
      if (msg.from) ctx.onHostChanged?.(msg.hostPeerId, msg.from);
      break;
    }

    case 'host-token': {
      // After being made the host: the token that gets the room back (reload, Rejoin, signaling drop)
      if (roomTokensRef?.current && roomTokensRef.current.roomId === String(msg.roomId) && typeof msg.hostToken === 'string') {
        roomTokensRef.current = { ...roomTokensRef.current, host: msg.hostToken };
      }
      break;
    }

    case 'error': {
      if (msg.code === 'resume-denied' && /^\d{5}$/.test(String(msg.roomId || ''))) {
        const tokens =
          roomTokensRef?.current?.roomId === String(msg.roomId)
            ? roomTokensRef.current
            : { seat: null, host: null };
        sendSignal({
          type: 'join',
          roomId: String(msg.roomId),
          peerId: peerIdRef?.current,
          rejoin: true,
          ...(tokens.seat ? { seatToken: tokens.seat } : {})
        });
        break;
      }
      // The room may be on another 3RTC server: look there before saying it doesn't exist
      if (msg.code === 'not-found' && ctx.findRoomElsewhere?.(String(msg.roomId || ''), msg.message || '')) break;
      if (!currentRoomRef.current && msg.code && ROOM_ERROR_CODES.has(msg.code) &&
        ctx.onRoomError?.(msg.message || 'Couldn\'t join that room', msg.roomId ? String(msg.roomId) : null)) break;
      showToast(msg.message || 'Signaling error');
      break;
    }

    default:
      break;
  }
}
