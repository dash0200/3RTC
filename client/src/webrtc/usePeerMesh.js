/**
 * The connection layer: the signaling socket, one RTCPeerConnection per person in the room (a
 * full mesh, up to MAX_ROOM_SIZE people), their data channels and voice, recovery, and leaving.
 *
 * Features never see any of this. They talk through the room bus (core/roomBus.js), which this
 * hook feeds: every message that arrives goes to bus.dispatch, a channel opening emits
 * 'peer-open', a peer going away emits 'peer-close', and leaving the room emits 'room-left'.
 */
import { getClientId } from '../utils/clientId';
import { useState, useRef, useCallback, useEffect } from 'react';
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
import { useSignalingConnection } from '../hooks/useSignalingConnection';

const WAITING_TEXT = 'Waiting for peer to enter 5-digit code...';

export function usePeerMesh(ctx) {
    const {
        bus, peersRef, peerIdRef, isHostRef, hostPeerIdRef, setHostPeerId, setPeerMetadata, username, notices, identityFields,
        voice, signalUrl, fallbackUrls, setSignalStatus, logLocalDebug
    } = ctx;
    const { addSystemMessage, showToast } = notices;
    const { isAudioBlockedRef, localMutedPeersRef, peerVolumesRef, localStreamRef, isMicMutedRef, setPeerVoiceStates } = voice;

    const [roomId, setRoomId] = useState(null);
    const [isHost, setIsHost] = useState(false);
    const [peerCount, setPeerCount] = useState(0);
    const [isP2PConnected, setIsP2PConnected] = useState(false);
    const [p2pStatusText, setP2pStatusText] = useState(WAITING_TEXT);

    const wsRef = useRef(null);
    const pendingSignalsRef = useRef([]);
    const currentRoomRef = useRef(null);
    // The server's proof of our seat (and, for the host, of the room): sent back when we reconnect,
    // so nobody else can take our place by naming our peer id (server/seats.js)
    const roomTokensRef = useRef({ roomId: null, seat: null, host: null });
    currentRoomRef.current = roomId;
    isHostRef.current = isHost;
    const getOrCreatePeerConnectionRef = useRef(null);
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
        setP2pStatusText(active > 0 ? `Direct P2P Active (${active} peer${active > 1 ? 's' : ''} connected)` : WAITING_TEXT);
    }, [peersRef]);

    // Buffers the message while the socket is still connecting
    const sendSignal = useCallback((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        } else {
            pendingSignalsRef.current.push(data);
        }
    }, []);

    const cleanupPeer = useCallback((targetPeerId) => {
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
    }, [bus, peersRef, setPeerMetadata, updateP2PStatus]);

    /** What we tell each peer about ourselves when a channel opens. */
    const getIdentity = useCallback(() => ({
        type: 'peer-identity',
        peerId: peerIdRef.current,
        username: usernameRef.current,
        isHost: isHostRef.current,
        isMuted: isMicMutedRef.current,
        proto: PROTOCOL_VERSION,
        build: BUILD.number,
        clientId: getClientId(),
        ...(identityFieldsRef.current?.() || {})
    }), [peerIdRef, isHostRef, isMicMutedRef]);

    const getOrCreatePeerConnection = useCallback((targetPeerId, isInitiator) => {
        if (peersRef.current.has(targetPeerId)) return peersRef.current.get(targetPeerId);

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const peerEntry = {
            pc,
            dataChannel: null,
            bulkChannel: null,
            isConnected: false,
            candidateQueue: [],
            audioElement: null,
            isInitiator: Boolean(isInitiator), // the initiator drives ICE restarts (no offer glare)
            applyingRemote: false,             // remote description being applied: queue candidates
            recoveryTimer: null,
            restartAttempts: 0,
            brokenSince: 0,
            wasInterrupted: false,
            signalingGone: false,              // peer dropped off signaling but P2P link was still up
            rebuilt: false
        };
        peersRef.current.set(targetPeerId, peerEntry);

        // Bulk channel (video stream / images), same pre-agreed id on both sides
        try {
            const bulk = pc.createDataChannel('bulk', { negotiated: true, id: BULK_CHANNEL_ID, ordered: true });
            bulk.binaryType = 'arraybuffer';
            peerEntry.bulkChannel = bulk;
        } catch (err) {
            logLocalDebug('BULK_CHANNEL_ERR', err.message);
        }

        // Voice: the initiator adds the audio transceiver so the offer has 'm=audio sendrecv'. The
        // answerer must not add one before the offer arrives; setRemoteDescription(offer) creates it.
        try {
            if (isInitiator) {
                let audioTransceiver = pc.getTransceivers?.().find((t) =>
                    t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio') || null;
                if (!audioTransceiver) {
                    audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
                } else {
                    audioTransceiver.direction = 'sendrecv';
                }
                if (localStreamRef.current) {
                    const audioTrack = micPipeline.getOutputTrack() || localStreamRef.current.getAudioTracks()[0];
                    if (audioTrack && !isMicMutedRef.current && audioTransceiver?.sender) {
                        audioTransceiver.sender.replaceTrack(audioTrack).catch(() => { });
                    }
                }
            }
        } catch (err) {
            logLocalDebug('TRANSCEIVER_INIT_ERR', err.message);
        }

        attachRemoteAudio(pc, { isAudioBlockedRef, localMutedPeersRef, logLocalDebug, peerEntry, peerVolumesRef, targetPeerId });

        pc.onicecandidate = (event) => {
            if (event.candidate) sendSignal({ type: 'ice-candidate', targetId: targetPeerId, candidate: event.candidate });
        };

        const { isStillCurrent, scheduleRecovery } = attachPeerRecovery(pc, { addSystemMessage, cleanupPeer, getOrCreatePeerConnectionRef, logLocalDebug, peerEntry, peersRef, sendSignal, setPeerCount, showToast, targetPeerId, updateP2PStatus, wsRef });

        const bindDataChannel = (dc) => {
            peerEntry.dataChannel = dc;
            try { dc.binaryType = 'arraybuffer'; } catch { }

            dc.onopen = () => {
                peerEntry.isConnected = true;
                updateP2PStatus();
                sound.playChime();
                addSystemMessage('Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!');
                showToast('Direct P2P Connected!');
                try {
                    dc.send(JSON.stringify(getIdentity()));
                    dc.send(JSON.stringify({ type: 'peer-voice-status', peerId: peerIdRef.current, sender: usernameRef.current, isMuted: isMicMutedRef.current }));
                } catch { }
                // Features catch the newcomer up (current video, shared state...)
                bus.emitEvent('peer-open', targetPeerId);
            };

            dc.onmessage = createPeerMessageHandler({ bus, cleanupPeer, dc, getIdentity, hostPeerIdRef, isAudioBlockedRef, isStillCurrent, peerEntry, peersRef, setPeerCount, setPeerMetadata, setPeerVoiceStates, targetPeerId });

            dc.onclose = () => {
                bus.emitEvent('channel-close', targetPeerId);
                if (!isStillCurrent()) return;
                peerEntry.isConnected = false;
                updateP2PStatus();
                // Peer left on purpose: clean up. Otherwise the link died: try to recover
                // (if they closed the tab, the server's peer-left cleans up first)
                if (peerEntry.byeReceived || peerEntry.signalingGone) {
                    cleanupPeer(targetPeerId);
                    setPeerCount(peersRef.current.size + 1);
                } else if (pc.connectionState !== 'closed') {
                    peerEntry.wasInterrupted = true;
                    scheduleRecovery(RECOVERY.disconnectGraceMs);
                }
            };
            dc.onerror = () => { };

            // Bulk transfers (video stream chunks, images) arrive on the bulk channel; same handler
            if (peerEntry.bulkChannel) peerEntry.bulkChannel.onmessage = dc.onmessage;
        };

        if (isInitiator) {
            try {
                bindDataChannel(pc.createDataChannel(`chat-${targetPeerId}`, { ordered: true }));
                pc.createOffer().then((offer) => {
                    const tunedOffer = { type: offer.type, sdp: tuneSdpForDiscordAudio(offer.sdp) };
                    return pc.setLocalDescription(tunedOffer).then(() => {
                        tuneAudioSender(pc);
                        logLocalDebug('OFFER_SENT', `To: ${targetPeerId} | SDP: ${extractAudioSdp(tunedOffer.sdp)}`);
                        // fresh: brand-new connection, the peer replaces any old one it has
                        sendSignal({ type: 'offer', targetId: targetPeerId, fresh: true, offer: { type: tunedOffer.type, sdp: tunedOffer.sdp } });
                    });
                }).catch((err) => logLocalDebug('OFFER_ERR', `Target: ${targetPeerId} error: ${err.message}`));
            } catch { }
        } else {
            pc.ondatachannel = (event) => bindDataChannel(event.channel);
        }
        return peerEntry;
    }, [addSystemMessage, bus, cleanupPeer, getIdentity, isAudioBlockedRef, isMicMutedRef, localMutedPeersRef, localStreamRef, logLocalDebug, peerIdRef, peerVolumesRef, peersRef, sendSignal, setPeerMetadata, setPeerVoiceStates, showToast, updateP2PStatus]);
    getOrCreatePeerConnectionRef.current = getOrCreatePeerConnection;

    const handleSignalingMessage = useCallback((msg) => processSignalingMessage(msg, {
        addSystemMessage, cleanupPeer, currentRoomRef, getOrCreatePeerConnection, isHostRef, isMicMutedRef, localStreamRef,
        logLocalDebug, peerIdRef, peersRef, roomTokensRef, sendSignal, setHostPeerId, setIsHost, setP2pStatusText, setPeerCount, setRoomId, showToast, username
    }), [peerIdRef, setHostPeerId, addSystemMessage, cleanupPeer, getOrCreatePeerConnection, isHostRef, isMicMutedRef, localStreamRef, logLocalDebug, peersRef, sendSignal, showToast, username]);

    useSignalingConnection({ addSystemMessage, currentRoomRef, fallbackUrls, handleSignalingMessage, isHostRef, peerIdRef, peersRef, pendingSignalsRef, roomTokensRef, setSignalStatus, showToast, signalUrl, wsRef });

    // With a code: a host coming back gets that room again (the server's resume path)
    // (it needs the room's host token: `hostToken`, saved with "Rejoin room" on the home screen)
    const createRoom = useCallback((resumeRoomId, hostToken) => sendSignal({
        type: 'create-room', peerId: peerIdRef.current,
        ...(resumeRoomId ? { roomId: String(resumeRoomId), ...(hostToken ? { hostToken } : {}) } : {})
    }), [peerIdRef, sendSignal]);
    /** The host token of the room we're in as host (to save for "Rejoin room"), else null. */
    const getHostToken = useCallback(() => roomTokensRef.current.host, []);
    const joinRoom = useCallback((pin) => sendSignal({ type: 'join', roomId: pin, peerId: peerIdRef.current }), [peerIdRef, sendSignal]);

    /** Leave on purpose: tell the server and every peer, drop all connections, reset features. */
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
        bus.emitEvent('room-left');
    }, [bus, isHostRef, peersRef, sendSignal, setHostPeerId, setPeerMetadata]);

    return {
        roomId, isHost, peerCount, isP2PConnected, p2pStatusText,
        createRoom, joinRoom, leaveRoom, sendSignal, getHostToken
    };
}
