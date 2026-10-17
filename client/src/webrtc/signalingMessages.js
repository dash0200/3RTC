/**
 * Messages from the signaling server: room created / resumed / joined, peers joining and leaving,
 * and the offer / answer / ICE candidate exchange that sets up (and restarts) peer connections.
 */
import { micPipeline } from '../utils/micPipeline';
import { extractAudioSdp, tuneSdpForDiscordAudio, tuneAudioSender } from './sdp';

export async function processSignalingMessage(msg, ctx) {
    const { addSystemMessage, cleanupPeer, currentRoomRef, currentScreenTrackRef, getOrCreatePeerConnection, isHostRef, isMicMutedRef, localStreamRef, logLocalDebug, peerIdRef, peersRef, roomTokensRef, sendSignal, setHostPeerId, setIsHost, setP2pStatusText, setPeerCount, setRoomId, showToast, username } = ctx;
    // Keep the server's proof of our seat (and of the room, as host) for reconnecting
    if (roomTokensRef && (msg.type === 'room-created' || msg.type === 'room-resumed' || msg.type === 'joined')) {
        roomTokensRef.current = {
            roomId: String(msg.roomId),
            seat: msg.seatToken || null,
            host: msg.hostToken || null
        };
        // Who the host is, from the server (undefined: an older server that doesn't say)
        setHostPeerId?.('hostPeerId' in msg ? msg.hostPeerId ?? null : undefined);
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
            // Host reconnected to signaling and got its room back (same code)
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

            // Prepare receiver connections for each existing peer in the room
            if (msg.peers && msg.peers.length > 0) {
                setP2pStatusText('Connecting direct P2P data channels...');
                for (const peerId of msg.peers) {
                    const known = peersRef.current.get(peerId);
                    if (known) {
                        // Rejoined after a signaling drop: keep the connection; if it is broken,
                        // this peer sends us a fresh offer (it got 'peer-joined')
                        known.signalingGone = false;
                    } else {
                        getOrCreatePeerConnection(peerId, false);
                    }
                }
            }
            break;
        }

        case 'peer-joined': {
            // Existing peers initiate offer to the newcomer
            const knownEntry = peersRef.current.get(msg.peerId);
            if (knownEntry) {
                knownEntry.signalingGone = false;
                if (knownEntry.pc?.connectionState === 'connected' &&
                    knownEntry.dataChannel?.readyState === 'open') {
                    // Peer reconnected to signaling; our P2P link with them never broke
                    break;
                }
                // Link is broken: build a fresh connection (they replace their old one)
                cleanupPeer(msg.peerId);
            } else {
                addSystemMessage(`A peer entered room ${currentRoomRef.current}. Establishing P2P connection...`);
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
                // A brand-new connection from the peer (rebuilt or rejoined): flagged 'fresh', or
                // recognizable by a new DTLS fingerprint (works with servers that drop the flag)
                const fingerprintOf = (sdp) => (sdp?.match(/a=fingerprint:\S+ (\S+)/) || [])[1];
                const knownFingerprint = fingerprintOf(existing?.pc?.remoteDescription?.sdp);
                const isFreshOffer = Boolean(msg.fresh) ||
                    Boolean(knownFingerprint && knownFingerprint !== fingerprintOf(msg.offer?.sdp));
                // (A connection we only prepared, with no remote description yet, is simply used)
                if (existing && isFreshOffer && existing.pc?.remoteDescription) {
                    // Peer started a brand-new connection (it rebuilt or rejoined): drop the old one
                    cleanupPeer(senderId);
                } else if (existing && existing.isInitiator && existing.pc.signalingState === 'have-local-offer') {
                    // We're already offering a fresh connection to this peer; it will adopt ours
                    logLocalDebug('OFFER_GLARE_IGNORED', `From: ${senderId}`);
                    break;
                }
                const peerEntry = getOrCreatePeerConnection(senderId, false);
                const pc = peerEntry.pc;

                const offerAudioSdp = extractAudioSdp(msg.offer?.sdp);
                logLocalDebug('OFFER_RECEIVED', `From: ${senderId} | Offer SDP: ${offerAudioSdp}`);

                const tunedOfferSdp = tuneSdpForDiscordAudio(msg.offer?.sdp);
                peerEntry.applyingRemote = true;
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription({
                        type: msg.offer.type,
                        sdp: tunedOfferSdp
                    }));
                } finally {
                    peerEntry.applyingRemote = false;
                }

                // Ensure the negotiated audio and video transceivers on the answerer are active and set to sendrecv
                if (pc.getTransceivers) {
                    const allTransceivers = pc.getTransceivers();
                    for (const t of allTransceivers) {
                        const isVideo = t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video';
                        if (isVideo) {
                            peerEntry.videoTransceiver = t;
                            t.direction = 'sendrecv';
                            if (currentScreenTrackRef?.current && t.sender) {
                                t.sender.replaceTrack(currentScreenTrackRef.current).catch(() => { });
                            }
                        } else {
                            peerEntry.audioTransceiver = t;
                            t.direction = 'sendrecv';
                            if (localStreamRef.current && !isMicMutedRef.current && t.sender) {
                                const audioTrack = micPipeline.getOutputTrack() || localStreamRef.current.getAudioTracks()[0];
                                if (audioTrack) {
                                    t.sender.replaceTrack(audioTrack).catch(() => { });
                                }
                            }
                        }
                    }
                }

                // Flush queued candidates
                while (peerEntry.candidateQueue.length > 0) {
                    const cand = peerEntry.candidateQueue.shift();
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(cand));
                    } catch { }
                }

                const answer = await pc.createAnswer();
                const tunedAnswerSdp = tuneSdpForDiscordAudio(answer.sdp);
                const tunedAnswer = { type: answer.type, sdp: tunedAnswerSdp };
                await pc.setLocalDescription(tunedAnswer);
                tuneAudioSender(pc);

                const answerAudioSdp = extractAudioSdp(tunedAnswer.sdp);
                const tInfo = pc.getTransceivers ? pc.getTransceivers().map((t) => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                logLocalDebug('ANSWER_SENT', `To: ${senderId} | Answer SDP: ${answerAudioSdp} | Transceivers: ${tInfo}`);

                sendSignal({
                    type: 'answer',
                    targetId: senderId,
                    answer: {
                        type: tunedAnswer.type,
                        sdp: tunedAnswer.sdp
                    }
                });
            } catch (err) {
                logLocalDebug('OFFER_HANDLE_ERR', err.message);
            }
            break;
        }

        case 'answer': {
            try {
                const senderId = msg.from;
                const peerEntry = peersRef.current.get(senderId);
                if (peerEntry && peerEntry.pc) {
                    const pc = peerEntry.pc;
                    if (pc.signalingState !== 'have-local-offer') break; // stale answer
                    const tunedAnswerSdp = tuneSdpForDiscordAudio(msg.answer?.sdp);
                    peerEntry.applyingRemote = true;
                    try {
                        await pc.setRemoteDescription(new RTCSessionDescription({
                            type: msg.answer.type,
                            sdp: tunedAnswerSdp
                        }));
                    } finally {
                        peerEntry.applyingRemote = false;
                    }
                    tuneAudioSender(pc);
                    if (pc.getTransceivers) {
                        for (const t of pc.getTransceivers()) {
                            if (t.sender?.track?.kind === 'video' || t.receiver?.track?.kind === 'video') {
                                peerEntry.videoTransceiver = t;
                            } else if (t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio') {
                                peerEntry.audioTransceiver = t;
                            }
                        }
                    }

                    const answerAudioSdp = extractAudioSdp(msg.answer?.sdp);
                    const tInfo = pc.getTransceivers ? pc.getTransceivers().map(t => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                    logLocalDebug('ANSWER_PROCESSED', `From: ${senderId} | Answer SDP: ${answerAudioSdp} | Host Transceivers: ${tInfo}`);

                    while (peerEntry.candidateQueue.length > 0) {
                        const cand = peerEntry.candidateQueue.shift();
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(cand));
                        } catch { }
                    }
                }
            } catch (err) {
                logLocalDebug('ANSWER_HANDLE_ERR', err.message);
            }
            break;
        }

        case 'ice-candidate': {
            const senderId = msg.from;
            const peerEntry = peersRef.current.get(senderId);
            if (peerEntry && msg.candidate) {
                const pc = peerEntry.pc;
                // Queue while a (re)negotiation is being applied: an ICE restart's new candidates
                // must not be added before the description that introduces them
                if (pc && pc.remoteDescription && pc.remoteDescription.type && !peerEntry.applyingRemote) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    } catch { }
                } else {
                    peerEntry.candidateQueue.push(msg.candidate);
                }
            }
            break;
        }

        case 'peer-left': {
            const leftEntry = peersRef.current.get(msg.peerId);
            if (leftEntry && leftEntry.pc?.connectionState === 'connected' &&
                leftEntry.dataChannel?.readyState === 'open') {
                // Only their signaling socket dropped; the direct P2P link still works. Keep it:
                // they reconnect to signaling on their own, and if they really left, the
                // data channel closes (or they send 'peer-bye') and we clean up then.
                leftEntry.signalingGone = true;
                logLocalDebug('PEER_SIGNALING_GONE', `Peer ${msg.peerId}: signaling dropped, P2P still up`);
                break;
            }
            cleanupPeer(msg.peerId);
            setPeerCount(peersRef.current.size + 1);
            addSystemMessage('A peer disconnected from the room.');
            break;
        }

        case 'host': {
            // The host got the room back (maybe with a new peer id, after reloading)
            setHostPeerId?.(msg.hostPeerId ?? null);
            break;
        }

        case 'error': {
            if (msg.code === 'resume-denied' && /^\d{5}$/.test(String(msg.roomId || ''))) {
                // The server wouldn't give us the room back as host (no valid host token: e.g. an
                // older saved "Rejoin"): join it as a guest instead, if it's still there
                const tokens = roomTokensRef?.current?.roomId === String(msg.roomId) ? roomTokensRef.current : {};
                sendSignal({ type: 'join', roomId: String(msg.roomId), peerId: peerIdRef?.current, rejoin: true, ...(tokens.seat ? { seatToken: tokens.seat } : {}) });
                break;
            }
            showToast(msg.message || 'Signaling error');
            break;
        }

        default:
            break;
    }
}
