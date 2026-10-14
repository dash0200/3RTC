/**
 * Sharing a local video file over P2P (utils/p2pStreamer.js does the byte work):
 * - On demand (normal case): the viewer's player asks for byte ranges through the service worker
 *   and the owner sends just those. In bigger rooms viewers are arranged in a relay tree
 *   (webrtc/streamTree.js): computers pass the video on to up to RELAY_FANOUT others.
 * - Whole file (no service worker): the owner pushes the file in chunks.
 *
 * Wire: 'p2p-stream-request', 'p2p-stream-header', 'p2p-range-request', 'p2p-range-cancel',
 * 'p2p-stream-complete', 'p2p-stream-cancel', 'p2p-relay-gone', plus binary chunks on the bulk channel.
 */
import { useRef, useEffect } from 'react';
import { P2PStreamSender, P2PStreamReceiver, P2PRangeSender, P2PRangeReceiver, STREAM_CACHE_BYTES, STREAM_CACHE_BYTES_PHONE, BUFFER_AHEAD_BYTES, BUFFER_AHEAD_BYTES_PHONE } from '../../utils/p2pStreamer';
import { addViewer, detachViewer, markDirect } from '../../webrtc/streamTree';
import { usePeerMessageOn } from '../../core/RoomContext';

const IMAGE_MAGIC = 0x494D4731; // 'IMG1' frames belong to chat images
const isPhoneLike = () => {
    try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; }
};

export function useStreamTransfer({ room, playback }) {
    const { bus } = room;
    const { streamReceiverRef, activeStreamSendersRef, localVideoFileRef, setStreamProgress, setStreamVideoUrl } = playback;
    // Stream number of the file we currently offer, and who fetches it from whom
    const hostStreamRef = useRef({ file: null, streamNo: 0 });
    const streamTreeRef = useRef(new Map());

    const bulkChannelTo = (peerId) => bus.channelOf(peerId, { bulk: true });
    const myName = () => room.getSelf().username;

    const stopSenderFor = (peerId) => {
        activeStreamSendersRef.current.get(peerId)?.abort();
        activeStreamSendersRef.current.delete(peerId);
    };

    // A viewer asks for our file
    usePeerMessageOn(bus, 'p2p-stream-request', (data, from) => {
        const channel = bulkChannelTo(from);
        const file = localVideoFileRef.current;
        if (!file || !channel) return;
        if (data.supportsRange) {
            // On demand: serve only the parts the peer's player asks for
            if (hostStreamRef.current.file !== file) {
                hostStreamRef.current = { file, streamNo: (Math.random() * 0xffffffff) >>> 0 };
                streamTreeRef.current.clear();
            }
            stopSenderFor(from);
            // Bigger rooms: once we feed RELAY_FANOUT viewers, newer ones fetch through one of them
            const parentId = addViewer(streamTreeRef.current, from, data.canRelay, (id) => Boolean(bulkChannelTo(id)));
            if (parentId) {
                try {
                    channel.send(JSON.stringify(P2PRangeSender.header(file, hostStreamRef.current.streamNo, myName(), { via: parentId })));
                } catch { }
                room.log(`📡 ${data.requester || 'A peer'} is streaming "${file.name}" through ${room.peerName(parentId) || 'another viewer'}.`);
            } else {
                const sender = new P2PRangeSender(file, channel, {
                    streamNo: hostStreamRef.current.streamNo,
                    senderName: myName(),
                    onError: (err) => room.log(`❌ Stream error: ${err.message}`)
                });
                activeStreamSendersRef.current.set(from, sender);
                sender.start();
                room.log(`📡 Streaming "${file.name}" on demand to ${data.requester || 'peer'}.`);
            }
            room.notify(`Streaming video to ${data.requester || 'peer'}...`);
            return;
        }
        room.log(`📡 Peer "${data.requester || 'User'}" requested video stream. Slicing and streaming chunks...`);
        room.notify(`Streaming video to ${data.requester || 'peer'}...`);
        const sender = new P2PStreamSender(file, channel, {
            targetPeerId: from,
            senderName: myName(),
            onProgress: () => { },
            onComplete: (info) => {
                room.log(`✅ Completed streaming video chunks to ${data.requester || 'peer'} (${(info.totalBytes / (1024 * 1024)).toFixed(1)} MB in ${info.durationSec.toFixed(1)}s)`);
                room.notify('Stream transfer complete!');
            },
            onError: (err) => room.log(`❌ Stream transfer error: ${err.message}`)
        });
        activeStreamSendersRef.current.set(from, sender);
        sender.start();
    });

    // A viewer's player asks for (or no longer needs) some blocks
    const onRange = (data, from) => {
        let sender = activeStreamSendersRef.current.get(from);
        const file = localVideoFileRef.current;
        const hostStream = hostStreamRef.current;
        const needsSender = !sender || sender.isAborted || sender.streamNo !== data.streamNo;
        const channel = bulkChannelTo(from);
        if (needsSender && data.type === 'p2p-range-request' && file && hostStream.file === file && hostStream.streamNo === data.streamNo) {
            // We own the file: a new channel after a rebuild, or a viewer whose parent dropped out
            markDirect(streamTreeRef.current, from);
            if (channel) {
                sender = new P2PRangeSender(file, channel, { streamNo: hostStream.streamNo, senderName: myName() });
                activeStreamSendersRef.current.set(from, sender);
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
                activeStreamSendersRef.current.set(from, sender);
            }
        }
        if (sender?.handleRequest && sender.streamNo === data.streamNo) {
            if (data.type === 'p2p-range-request') sender.handleRequest(data);
            else sender.handleCancel(data);
        }
    };
    usePeerMessageOn(bus, 'p2p-range-request', onRange);
    usePeerMessageOn(bus, 'p2p-range-cancel', onRange);

    // The owner starts a stream to us
    usePeerMessageOn(bus, 'p2p-stream-header', (data, from) => {
        streamReceiverRef.current?.abort();
        if (data.mode === 'range') {
            // On demand: the player starts right away and fetches what it needs
            const selfId = room.getSelfId();
            const relayId = data.via && data.via !== selfId && bus.channelOf(data.via) ? data.via : null;
            const receiver = new P2PRangeReceiver(data, {
                ownerId: from,
                sourceId: relayId || from,
                getChannel: bulkChannelTo,
                // Phones get less memory for the stream
                cacheLimit: isPhoneLike() ? STREAM_CACHE_BYTES_PHONE : STREAM_CACHE_BYTES,
                bufferAhead: isPhoneLike() ? BUFFER_AHEAD_BYTES_PHONE : BUFFER_AHEAD_BYTES,
                onSourceChange: (_id, reason) => {
                    if (streamReceiverRef.current !== receiver) return;
                    room.log(`📡 Now streaming straight from ${data.sender || 'the owner'} (${reason}).`);
                },
                onProgress: (prog) => {
                    if (streamReceiverRef.current !== receiver) return;
                    setStreamProgress((prev) => ({ ...(prev || {}), ...prog }));
                }
            });
            streamReceiverRef.current = receiver;
            setStreamProgress({
                percent: 0, speedMBs: 0, receivedBytes: 0, totalBytes: data.fileSize, receivedChunksCount: 0,
                totalChunks: receiver.totalBlocks, fileName: data.fileName, isReady: true
            });
            setStreamVideoUrl(receiver.url);
            room.log(relayId
                ? `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'}, passed along by ${room.peerName(relayId) || 'another viewer'} (plays while it loads).`
                : `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'} (plays while it loads).`);
            return;
        }
        // Whole file pushed in chunks (this browser can't stream on demand): plays when it's all here
        room.log(`📡 Downloading "${data.fileName}" (${(data.fileSize / (1024 * 1024)).toFixed(1)} MB) from ${data.sender || 'Peer'}: this browser can't stream on demand, so it plays when the download finishes`);
        room.notify('This browser can\'t stream on demand: the video plays once it has downloaded. Reloading the page may fix it.');
        const receiver = new P2PStreamReceiver(data, {
            // A partial file can't be played (no length, no index), so the player gets it when complete
            onReady: () => { },
            onProgress: (prog) => setStreamProgress((prev) => ({ ...(prev || {}), ...prog })),
            onComplete: (blobUrl, meta) => {
                setStreamVideoUrl(blobUrl);
                setStreamProgress((prev) => ({ ...(prev || {}), percent: 100, isReady: true, isCompleted: true }));
                room.log(`✅ Video stream fully buffered (${(meta.fileSize / (1024 * 1024)).toFixed(1)} MB). Ready to play!`);
                room.notify('Stream ready to play!');
            },
            onError: (err) => {
                room.log(`❌ Video stream error: ${err.message}`);
                room.notify(`Stream error: ${err.message}`);
            }
        });
        streamReceiverRef.current = receiver;
        setStreamProgress({
            percent: 0, speedMBs: 0, receivedBytes: 0, totalBytes: data.fileSize, receivedChunksCount: 0,
            totalChunks: data.totalChunks, fileName: data.fileName, isReady: false, wholeFile: true
        });
    });

    usePeerMessageOn(bus, 'p2p-stream-complete', () => streamReceiverRef.current?.handleComplete?.());

    // The viewer relaying our stream stopped: fetch straight from the owner
    usePeerMessageOn(bus, 'p2p-relay-gone', (_data, from) => {
        const receiver = streamReceiverRef.current;
        if (receiver instanceof P2PRangeReceiver && receiver.sourceId === from) receiver.useOwner('relay stopped');
    });

    // This peer stopped receiving from us, or (if it owns our stream) stopped sharing it
    usePeerMessageOn(bus, 'p2p-stream-cancel', (_data, from) => {
        stopSenderFor(from);
        detachViewer(streamTreeRef.current, from);
        const receiver = streamReceiverRef.current;
        const fromOurOwner = !(receiver instanceof P2PRangeReceiver) || receiver.ownerId === from;
        if (receiver && fromOurOwner) {
            receiver.abort();
            streamReceiverRef.current = null;
            setStreamProgress(null);
        }
    });

    useEffect(() => {
        // Stream data (anything binary that isn't a chat image)
        const offBinary = bus.onBinary((arrayBuffer) => {
            if (arrayBuffer.byteLength >= 4 && new DataView(arrayBuffer).getUint32(0, false) === IMAGE_MAGIC) return false;
            streamReceiverRef.current?.handleChunk(arrayBuffer);
            return true;
        });
        // A peer is gone: our parent left -> fetch from the owner; a viewer left -> its children do
        const offClose = bus.onEvent('peer-close', (peerId) => {
            streamReceiverRef.current?.handlePeerGone?.(peerId);
            detachViewer(streamTreeRef.current, peerId);
            stopSenderFor(peerId);
        });
        // Their channel closed (it may come back): stop sending to it
        const offChannel = bus.onEvent('channel-close', stopSenderFor);
        return () => {
            offBinary();
            offClose();
            offChannel();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bus]);

    // On-demand stream: the service worker forwards each byte range the video player asks for
    useEffect(() => {
        const sw = navigator.serviceWorker;
        if (!sw) return undefined;
        const onWorkerMessage = (event) => {
            const msg = event.data || {};
            if (msg.type !== 'p2p-range-open' || !event.ports[0]) return;
            const port = event.ports[0];
            const receiver = streamReceiverRef.current;
            if (receiver && typeof receiver.serve === 'function' && String(receiver.streamNo) === String(msg.streamNo)) {
                receiver.serve(port, msg.start, msg.end);
            } else {
                port.postMessage({ type: 'meta', ok: false });
            }
        };
        sw.addEventListener('message', onWorkerMessage);
        return () => sw.removeEventListener('message', onWorkerMessage);
    }, [streamReceiverRef]);
}
