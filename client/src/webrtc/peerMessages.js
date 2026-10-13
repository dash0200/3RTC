/**
 * Messages from a peer's data channels (main channel and bulk channel share this handler):
 * identity and voice status, chat, YouTube / local-video sync, queue, reactions, soundboard,
 * P2P video streaming (push and on-demand), images and pings.
 */
import { sound } from '../utils/sound';
import { P2PStreamSender, P2PStreamReceiver, P2PRangeSender, P2PRangeReceiver } from '../utils/p2pStreamer';
import { addViewer, detachViewer, markDirect } from './streamTree';

export function createPeerMessageHandler(ctx) {
    const { activeStreamSendersRef, activeVideoTitleRef, addSystemMessage, cleanupPeer, dc, handleIncomingImageChunk, handleIncomingImageStart, handleRemoteLocalVideoAction, handleRemoteQueueAction, handleRemoteReaction, handleRemoteSoundboardSfx, handleRemoteYouTubeAction, handleRoomSettings, hostStreamRef, isAudioBlockedRef, lockRevertPendingRef, playbackLockRef, peerNameOf, isHostRef, isMicMutedRef, isStillCurrent, localVideoFileRef, peerEntry, peerIdRef, peersRef, queueRef, recordPeerPing, setActiveVideoId, setActiveVideoTitle, setLocalVideoFile, setMessages, setPeerCount, setPeerMetadata, setPeerVoiceStates, setQueue, setRemoteAction, setRemoteLocalVideoMeta, setSkipVotes, setStreamProgress, setStreamVideoUrl, showToast, skipVotesRef, streamReceiverRef, streamTreeRef, syncStateGetterRef, targetPeerId, username } = ctx;
    const openChannelTo = (peerId) => {
        const entry = peersRef.current.get(peerId);
        const channel = entry?.bulkChannel?.readyState === 'open' ? entry.bulkChannel : entry?.dataChannel;
        return channel?.readyState === 'open' ? channel : null;
    };
    return async (event) => {
        let arrayBuffer = null;
        if (event.data instanceof ArrayBuffer) {
            arrayBuffer = event.data;
        } else if (event.data instanceof Blob) {
            try {
                arrayBuffer = await event.data.arrayBuffer();
            } catch (e) { }
        }

        if (arrayBuffer) {
            // Feature 3.3: Check magic bytes for Direct P2P Image Chunk
            if (arrayBuffer.byteLength >= 4) {
                const magic = new DataView(arrayBuffer).getUint32(0, false);
                if (magic === 0x494D4731) { // 'IMG1'
                    handleIncomingImageChunk(arrayBuffer);
                    return;
                }
            }

            // Feature 1.4: P2P Video Streaming
            if (streamReceiverRef.current) {
                streamReceiverRef.current.handleChunk(arrayBuffer);
            }
            return;
        }

        try {
            const data = JSON.parse(event.data);
            if (data.type === 'peer-bye') {
                // Peer is leaving the room on purpose
                if (isStillCurrent()) {
                    peerEntry.byeReceived = true;
                    cleanupPeer(targetPeerId);
                    setPeerCount(peersRef.current.size + 1);
                }
                return;
            }
            if (data.type === 'peer-identity') {
                setPeerMetadata((prev) => ({
                    ...prev,
                    [targetPeerId]: {
                        username: data.username || `User_${targetPeerId.slice(0, 4)}`,
                        isHost: Boolean(data.isHost),
                        isMuted: Boolean(data.isMuted)
                    }
                }));
                handleRoomSettings?.(data, targetPeerId); // the host's identity carries the controls lock
                if (!data.isReply) {
                    try {
                        dc.send(JSON.stringify({
                            type: 'peer-identity',
                            peerId: peerIdRef.current,
                            username: username,
                            isHost: isHostRef.current,
                            isMuted: isMicMutedRef.current,
                            ...(isHostRef.current ? { playbackLock: Boolean(playbackLockRef?.current) } : {}),
                            isReply: true
                        }));
                    } catch (e) { }
                }
            } else if (data.type === 'room-settings') {
                handleRoomSettings?.(data, targetPeerId);
            } else if (data.type === 'chat') {
                setMessages((prev) => [...prev, { ...data, isSelf: false }]);
                sound.playPop();
            } else if (data.type === 'p2p-image-start') {
                handleIncomingImageStart(data);
            } else if (data.type === 'net-ping') {
                try {
                    dc.send(JSON.stringify({
                        type: 'net-pong',
                        pingId: data.pingId,
                        sendTime: data.sendTime
                    }));
                } catch (e) { }
            } else if (data.type === 'net-pong') {
                const rtt = Math.max(1, Math.round(performance.now() - (data.sendTime || 0)));
                recordPeerPing(targetPeerId, rtt);
            } else if (data.type === 'peer-voice-status') {
                setPeerVoiceStates((prev) => ({
                    ...prev,
                    [data.sender]: { isMuted: data.isMuted }
                }));
                setPeerMetadata((prev) => ({
                    ...prev,
                    [targetPeerId]: {
                        ...(prev[targetPeerId] || {}),
                        username: data.sender || prev[targetPeerId]?.username || `User_${targetPeerId.slice(0, 4)}`,
                        isMuted: data.isMuted
                    }
                }));
                // When remote peer un-mutes, ensure their audio element is actively playing
                if (!data.isMuted) {
                    for (const peer of peersRef.current.values()) {
                        if (peer.audioElement && !isAudioBlockedRef.current) {
                            peer.audioElement.play().catch(() => { });
                        }
                    }
                }
            } else if (data.type === 'yt-action') {
                handleRemoteYouTubeAction(data);
            } else if (data.type === 'local-video-action') {
                handleRemoteLocalVideoAction(data);
            } else if (data.type === 'queue-action') {
                handleRemoteQueueAction(data);
            } else if (data.type === 'reaction') {
                handleRemoteReaction(data);
            } else if (data.type === 'soundboard-sfx') {
                handleRemoteSoundboardSfx(data);
            } else if (data.type === 'p2p-stream-request') {
                // Remote peer requests to stream the local video file
                const streamChannel = peerEntry.bulkChannel?.readyState === 'open'
                    ? peerEntry.bulkChannel
                    : peerEntry.dataChannel;
                if (localVideoFileRef.current && streamChannel && data.supportsRange) {
                    // On-demand: serve only the parts the peer's player asks for
                    const file = localVideoFileRef.current;
                    if (hostStreamRef.current.file !== file) {
                        hostStreamRef.current = { file, streamNo: (Math.random() * 0xffffffff) >>> 0 };
                        streamTreeRef.current.clear();
                    }
                    activeStreamSendersRef.current.get(targetPeerId)?.abort();
                    activeStreamSendersRef.current.delete(targetPeerId);
                    // Bigger rooms: once we feed RELAY_FANOUT viewers, newer ones fetch through one of them
                    const parentId = addViewer(streamTreeRef.current, targetPeerId, data.canRelay,
                        (id) => peersRef.current.has(id) && Boolean(openChannelTo(id)));
                    const parentName = parentId ? peerNameOf?.(parentId) : null;
                    if (parentId) {
                        try {
                            streamChannel.send(JSON.stringify(P2PRangeSender.header(file, hostStreamRef.current.streamNo, username, { via: parentId })));
                        } catch { }
                        addSystemMessage(`📡 ${data.requester || 'A peer'} is streaming "${file.name}" through ${parentName || 'another viewer'}.`);
                    } else {
                        const sender = new P2PRangeSender(file, streamChannel, {
                            streamNo: hostStreamRef.current.streamNo,
                            senderName: username,
                            onError: (err) => addSystemMessage(`❌ Stream error: ${err.message}`)
                        });
                        activeStreamSendersRef.current.set(targetPeerId, sender);
                        sender.start();
                        addSystemMessage(`📡 Streaming "${file.name}" on demand to ${data.requester || 'peer'}.`);
                    }
                    showToast(`Streaming video to ${data.requester || 'peer'}...`);
                } else if (localVideoFileRef.current && streamChannel) {
                    addSystemMessage(`📡 Peer "${data.requester || 'User'}" requested video stream. Slicing and streaming chunks...`);
                    showToast(`Streaming video to ${data.requester || 'peer'}...`);

                    const sender = new P2PStreamSender(localVideoFileRef.current, streamChannel, {
                        targetPeerId,
                        senderName: username,
                        onProgress: () => { },
                        onComplete: (info) => {
                            addSystemMessage(`✅ Completed streaming video chunks to ${data.requester || 'peer'} (${(info.totalBytes / (1024 * 1024)).toFixed(1)} MB in ${info.durationSec.toFixed(1)}s)`);
                            showToast(`Stream transfer complete!`);
                        },
                        onError: (err) => {
                            addSystemMessage(`❌ Stream transfer error: ${err.message}`);
                        }
                    });
                    activeStreamSendersRef.current.set(targetPeerId, sender);
                    sender.start();
                }
            } else if (data.type === 'p2p-range-request' || data.type === 'p2p-range-cancel') {
                let sender = activeStreamSendersRef.current.get(targetPeerId);
                const file = localVideoFileRef.current;
                const hostStream = hostStreamRef.current;
                const needsSender = !sender || sender.isAborted || sender.streamNo !== data.streamNo;
                const channel = peerEntry.bulkChannel?.readyState === 'open' ? peerEntry.bulkChannel : peerEntry.dataChannel;
                if (needsSender && data.type === 'p2p-range-request' && file && hostStream.file === file &&
                    hostStream.streamNo === data.streamNo) {
                    // We own the file: a new channel after a rebuild, or a viewer whose parent dropped out
                    markDirect(streamTreeRef.current, targetPeerId);
                    if (channel) {
                        sender = new P2PRangeSender(file, channel, { streamNo: hostStream.streamNo, senderName: username });
                        activeStreamSendersRef.current.set(targetPeerId, sender);
                    }
                } else if (needsSender && data.type === 'p2p-range-request' && !file) {
                    // We are a viewer the owner picked as this peer's relay: pass on what we have
                    const receiver = streamReceiverRef.current;
                    if (receiver instanceof P2PRangeReceiver && !receiver.isAborted && receiver.streamNo === data.streamNo && channel) {
                        sender = new P2PRangeSender(null, channel, {
                            streamNo: receiver.streamNo,
                            fileSize: receiver.fileSize,
                            blockSize: receiver.blockSize,
                            readBlock: (block) => receiver.getBlock(block),
                            onRequest: (blocks, urgent) => receiver.want(blocks, urgent),
                            cancelType: 'p2p-relay-gone'
                        });
                        activeStreamSendersRef.current.set(targetPeerId, sender);
                    }
                }
                if (sender && sender.handleRequest && sender.streamNo === data.streamNo) {
                    if (data.type === 'p2p-range-request') sender.handleRequest(data);
                    else sender.handleCancel(data);
                }
            } else if (data.type === 'p2p-stream-header' && data.mode === 'range') {
                // On-demand stream: the player starts right away and fetches what it needs
                if (streamReceiverRef.current) {
                    streamReceiverRef.current.abort();
                }
                const relayId = data.via && data.via !== peerIdRef.current && peersRef.current.has(data.via) ? data.via : null;
                const receiver = new P2PRangeReceiver(data, {
                    ownerId: targetPeerId,
                    sourceId: relayId || targetPeerId,
                    getChannel: openChannelTo,
                    onSourceChange: (_id, reason) => {
                        if (streamReceiverRef.current !== receiver) return;
                        addSystemMessage(`📡 Now streaming straight from ${data.sender || 'the owner'} (${reason}).`);
                    },
                    onProgress: (prog) => {
                        if (streamReceiverRef.current !== receiver) return;
                        setStreamProgress((prev) => ({ ...(prev || {}), ...prog }));
                    },
                    // Where playback is, so the player is only fed ~10 s ahead
                    getPlaybackInfo: () => {
                        const video = [...document.querySelectorAll('video')]
                            .find((v) => (v.currentSrc || '').includes(receiver.url));
                        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
                        const bytesPerSec = receiver.fileSize / video.duration;
                        return { byte: video.currentTime * bytesPerSec, bytesPerSec };
                    }
                });
                streamReceiverRef.current = receiver;
                setStreamProgress({
                    percent: 0,
                    speedMBs: 0,
                    receivedBytes: 0,
                    totalBytes: data.fileSize,
                    receivedChunksCount: 0,
                    totalChunks: receiver.totalBlocks,
                    fileName: data.fileName,
                    isReady: true
                });
                setStreamVideoUrl(receiver.url);
                const relayName = relayId ? peerNameOf?.(relayId) : null;
                addSystemMessage(relayId
                    ? `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'}, passed along by ${relayName || 'another viewer'} (plays while it loads).`
                    : `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'} (plays while it loads).`);
            } else if (data.type === 'p2p-stream-header') {
                // Incoming P2P video stream header
                addSystemMessage(`📡 Receiving video stream from ${data.sender || 'Peer'}: "${data.fileName}" (${(data.fileSize / (1024 * 1024)).toFixed(1)} MB)`);
                showToast(`Streaming "${data.fileName}"...`);

                if (streamReceiverRef.current) {
                    streamReceiverRef.current.abort();
                }

                const receiver = new P2PStreamReceiver(data, {
                    onReady: (blobUrl, meta) => {
                        setStreamVideoUrl(blobUrl);
                        setStreamProgress((prev) => ({
                            ...(prev || {}),
                            isReady: true,
                            percent: meta.percent
                        }));
                    },
                    onProgress: (prog) => {
                        setStreamProgress((prev) => ({
                            ...(prev || {}),
                            ...prog
                        }));
                    },
                    onComplete: (blobUrl, meta) => {
                        setStreamVideoUrl(blobUrl);
                        setStreamProgress((prev) => ({
                            ...(prev || {}),
                            percent: 100,
                            isReady: true,
                            isCompleted: true
                        }));
                        addSystemMessage(`✅ Video stream fully buffered (${(meta.fileSize / (1024 * 1024)).toFixed(1)} MB). Ready to play!`);
                        showToast(`Stream ready to play!`);
                    },
                    onError: (err) => {
                        addSystemMessage(`❌ Video stream error: ${err.message}`);
                        showToast(`Stream error: ${err.message}`);
                    }
                });
                streamReceiverRef.current = receiver;
                setStreamProgress({
                    percent: 0,
                    speedMBs: 0,
                    receivedBytes: 0,
                    totalBytes: data.fileSize,
                    receivedChunksCount: 0,
                    totalChunks: data.totalChunks,
                    fileName: data.fileName,
                    isReady: false
                });
            } else if (data.type === 'p2p-stream-complete') {
                if (streamReceiverRef.current) {
                    streamReceiverRef.current.handleComplete();
                }
            } else if (data.type === 'p2p-relay-gone') {
                // The viewer relaying our stream stopped: fetch straight from the owner
                const receiver = streamReceiverRef.current;
                if (receiver instanceof P2PRangeReceiver && receiver.sourceId === targetPeerId) {
                    receiver.useOwner('relay stopped');
                }
            } else if (data.type === 'p2p-stream-cancel') {
                // This peer stopped receiving from us, or (if it owns our stream) stopped sharing it
                if (activeStreamSendersRef.current.has(targetPeerId)) {
                    activeStreamSendersRef.current.get(targetPeerId).abort();
                    activeStreamSendersRef.current.delete(targetPeerId);
                }
                detachViewer(streamTreeRef.current, targetPeerId);
                const receiver = streamReceiverRef.current;
                const fromOurOwner = !(receiver instanceof P2PRangeReceiver) || receiver.ownerId === targetPeerId;
                if (receiver && fromOurOwner) {
                    receiver.abort();
                    streamReceiverRef.current = null;
                    setStreamProgress(null);
                }
            } else if (data.type === 'yt-request-sync') {
                // A newly joined peer is asking for the current playing media & timestamp
                let hasSent = false;
                if (syncStateGetterRef.current) {
                    const state = syncStateGetterRef.current();
                    if (state) {
                        if (state.mediaType === 'local' && state.fileName) {
                            dc.send(JSON.stringify({
                                type: 'local-video-sync-state',
                                ...state,
                                sender: username
                            }));
                            hasSent = true;
                        } else if (state.videoId) {
                            dc.send(JSON.stringify({
                                type: 'yt-sync-state',
                                ...state,
                                queue: queueRef.current,
                                skipVotes: skipVotesRef.current,
                                activeVideoTitle: activeVideoTitleRef.current,
                                sender: username
                            }));
                            hasSent = true;
                        }
                    }
                }
                if (!hasSent && localVideoFileRef.current) {
                    dc.send(JSON.stringify({
                        type: 'local-video-sync-state',
                        mediaType: 'local',
                        fileName: localVideoFileRef.current.name,
                        fileSize: localVideoFileRef.current.size,
                        currentTime: 0,
                        isPlaying: false,
                        sender: username
                    }));
                    hasSent = true;
                }
                if (!hasSent) {
                    // Nothing playing here (lets a guest under the host controls lock drop what it opened)
                    dc.send(JSON.stringify({ type: 'yt-sync-state', videoId: null, nothingPlaying: true, sender: username }));
                }
            } else if (data.type === 'yt-sync-state') {
                // Received sync state from an existing peer in the room
                const isLockRevert = Boolean(lockRevertPendingRef?.current);
                if (lockRevertPendingRef) lockRevertPendingRef.current = false;
                if (data.nothingPlaying) {
                    // Host controls lock: we opened something the host doesn't have, so close it
                    if (isLockRevert) {
                        setLocalVideoFile(null);
                        setRemoteLocalVideoMeta(null);
                        setActiveVideoId(null);
                        setActiveVideoTitle('');
                        setRemoteAction({ action: 'close', type: 'yt-action', fromHost: true });
                    }
                } else if (data.videoId) {
                    setLocalVideoFile(null);
                    setRemoteLocalVideoMeta(null);
                    setActiveVideoId(data.videoId);
                    if (data.activeVideoTitle) {
                        setActiveVideoTitle(data.activeVideoTitle);
                    }
                    if (Array.isArray(data.queue)) {
                        setQueue(data.queue);
                        queueRef.current = data.queue;
                    }
                    if (Array.isArray(data.skipVotes)) {
                        setSkipVotes(data.skipVotes);
                        skipVotesRef.current = data.skipVotes;
                    }
                    setRemoteAction({
                        action: data.isPlaying ? 'play' : 'pause',
                        currentTime: data.currentTime,
                        newVideoId: data.videoId
                    });
                    addSystemMessage(`🔄 Synced YouTube playback & queue with room`);
                }
            } else if (data.type === 'local-video-sync-state') {
                if (lockRevertPendingRef) lockRevertPendingRef.current = false;
                if (data.fileName) {
                    setActiveVideoId(null);
                    setRemoteLocalVideoMeta({
                        fileName: data.fileName,
                        fileSize: data.fileSize,
                        sender: data.sender
                    });
                    setRemoteAction({
                        action: data.isPlaying ? 'play' : 'pause',
                        currentTime: data.currentTime,
                        fileName: data.fileName,
                        sender: data.sender,
                        subtitleInfo: data.subtitleInfo
                    });
                    addSystemMessage(`🔄 Synced with room's local video session: "${data.fileName}"`);
                }
            }
        } catch (e) { }
    };
}
