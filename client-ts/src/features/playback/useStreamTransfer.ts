/**
 * Sharing a local video file over P2P (utils/p2pStreamer.js does the byte work):
 * - On demand (normal case): the viewer's player asks for byte ranges through the service worker
 *   and the owner sends just those. In bigger rooms viewers are arranged in a relay tree
 *   (webrtc/streamTree.js): computers pass the video on to up to RELAY_FANOUT others.
 * - Whole file (no service worker): the owner pushes the file in chunks.
 *
 * - Swarm (torrent-like, apps from Phase 3 on): a viewer asking with `swarm: true` gets the stream
 *   straight from the owner (no tree), announces the blocks it holds ('p2p-have') and fetches each
 *   block from the least busy viewer that has it, the owner being the fallback. Blocks that came
 *   from another viewer are checked against the owner's SHA-256 ('p2p-hash-request' ->
 *   'p2p-block-hashes'); a viewer that sent a bad one is never asked again. Older apps in the
 *   room keep using the relay tree.
 *
 * Wire: 'p2p-stream-request', 'p2p-stream-header', 'p2p-range-request', 'p2p-range-cancel',
 * 'p2p-stream-complete', 'p2p-stream-cancel', 'p2p-relay-gone', 'p2p-have', 'p2p-range-miss',
 * 'p2p-swarm-gone', 'p2p-hash-request', 'p2p-block-hashes', plus binary chunks on the bulk channel.
 */
import { useRef, useEffect, type RefObject } from 'react';
import type { RoomBus } from '../../types';
import {
  P2PStreamSender,
  P2PStreamReceiver,
  P2PRangeSender,
  P2PRangeReceiver,
  sha256Hex,
  canChecksum,
  RANGE_BLOCK_SIZE,
  STREAM_CACHE_BYTES,
  STREAM_CACHE_BYTES_PHONE,
  BUFFER_AHEAD_BYTES,
  BUFFER_AHEAD_BYTES_PHONE
} from '../../utils/p2pStreamer';
import { addViewer, detachViewer, markDirect, type StreamTree } from '../../webrtc/streamTree';
import { usePeerMessageOn } from '../../core/RoomContext';
import type { StreamProgress, StreamReceiverLike } from './usePlayback';

const IMAGE_MAGIC = 0x494d4731; // 'IMG1' frames belong to chat images
const isPhoneLike = (): boolean => {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
};

interface HostStreamState {
  file: File | null;
  streamNo: number;
  hashes: Map<number, string>;
}

interface PeerHaveState {
  streamNo: number;
  ranges: number[];
}

export interface UseStreamTransferRoom {
  bus: RoomBus;
  getSelf: () => { username: string };
  getSelfId: () => string;
  log: (msg: string) => void;
  notify: (msg: string) => void;
  peerName: (id: string) => string;
}

export interface UseStreamTransferPlayback {
  streamReceiverRef: RefObject<StreamReceiverLike | null>;
  activeStreamSendersRef: RefObject<Map<string, P2PStreamSender | P2PRangeSender>>;
  localVideoFileRef: RefObject<File | null>;
  setStreamProgress: React.Dispatch<React.SetStateAction<StreamProgress | null>>;
  setStreamVideoUrl: (url: string | null) => void;
}

export interface UseStreamTransferProps {
  room: UseStreamTransferRoom;
  playback: UseStreamTransferPlayback;
}

declare global {
  interface Window {
    __3rtcStream?: unknown;
  }
}

export function useStreamTransfer({ room, playback }: UseStreamTransferProps): void {
  const { bus } = room;
  const { streamReceiverRef, activeStreamSendersRef, localVideoFileRef, setStreamProgress, setStreamVideoUrl } = playback;
  // Stream number of the file we currently offer, and who fetches it from whom
  const hostStreamRef = useRef<HostStreamState>({ file: null, streamNo: 0, hashes: new Map() });
  const streamTreeRef = useRef<StreamTree>(new Map());
  // What other viewers said they hold (kept until our stream starts, see 'p2p-have')
  const peerHaveRef = useRef<Map<string, PeerHaveState>>(new Map());

  const bulkChannelTo = (peerId: string | null): RTCDataChannel | null =>
    peerId ? ((bus.channelOf(peerId, { bulk: true }) as unknown) as RTCDataChannel | null) : null;
  const myName = (): string => room.getSelf().username;

  // Checksum every block as it goes out: any block a viewer can pass on came from us first, so
  // its checksum is ready when someone asks for it ('p2p-hash-request')
  const checksumAsSent = (stream: HostStreamState) => (block: number, data: Uint8Array) => {
    if (!stream.hashes.has(block) && canChecksum()) {
      sha256Hex(data as unknown as BufferSource)
        .then((hex) => stream.hashes.set(block, hex))
        .catch(() => {});
    }
  };

  const stopSenderFor = (peerId: string): void => {
    activeStreamSendersRef.current.get(peerId)?.abort();
    activeStreamSendersRef.current.delete(peerId);
  };

  // A viewer asks for our file
  usePeerMessageOn<{
    supportsRange?: boolean;
    swarm?: boolean;
    requester?: string;
    canRelay?: boolean;
    fileName?: string;
  }>(bus, 'p2p-stream-request', (data, from) => {
    const channel = bulkChannelTo(from);
    const file = localVideoFileRef.current;
    if (!file || !channel) return;
    if (data.supportsRange) {
      // On demand: serve only the parts the peer's player asks for
      if (hostStreamRef.current.file !== file) {
        hostStreamRef.current = { file, streamNo: (Math.random() * 0xffffffff) >>> 0, hashes: new Map() };
        streamTreeRef.current.clear();
      }
      stopSenderFor(from);
      if (data.swarm && canChecksum()) {
        // Swarm: served by us, and by the other viewers for what they already have
        detachViewer(streamTreeRef.current, from);
        const stream = hostStreamRef.current;
        const sender = new P2PRangeSender(file, channel, {
          streamNo: stream.streamNo,
          senderName: myName(),
          headerExtra: { swarm: true },
          onBlockRead: checksumAsSent(stream),
          onError: (err) => room.log(`❌ Stream error: ${err.message}`)
        });
        activeStreamSendersRef.current.set(from, sender);
        sender.start();
        room.log(`📡 Streaming "${file.name}" to ${data.requester || 'peer'} (shared between viewers).`);
        room.notify(`Streaming video to ${data.requester || 'peer'}...`);
        return;
      }
      // Bigger rooms: once we feed RELAY_FANOUT viewers, newer ones fetch through one of them
      const parentId = addViewer(streamTreeRef.current, from, Boolean(data.canRelay), (id) => Boolean(bulkChannelTo(id)));
      if (parentId) {
        try {
          channel.send(
            JSON.stringify(P2PRangeSender.header(file, hostStreamRef.current.streamNo, myName(), { via: parentId }))
          );
        } catch {}
        room.log(
          `📡 ${data.requester || 'A peer'} is streaming "${file.name}" through ${room.peerName(parentId) || 'another viewer'}.`
        );
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
      onProgress: () => {},
      onComplete: (info) => {
        room.log(
          `✅ Completed streaming video chunks to ${data.requester || 'peer'} (${(info.totalBytes / (1024 * 1024)).toFixed(1)} MB in ${info.durationSec.toFixed(1)}s)`
        );
        room.notify('Stream transfer complete!');
      },
      onError: (err) => room.log(`❌ Stream transfer error: ${err.message}`)
    });
    activeStreamSendersRef.current.set(from, sender);
    sender.start();
  });

  // A viewer's player asks for (or no longer needs) some blocks
  const onRange = (
    data: {
      type: string;
      streamNo: number;
      blocks?: number[];
      swarm?: boolean;
      urgent?: boolean;
    },
    from: string
  ) => {
    let sender = activeStreamSendersRef.current.get(from);
    const file = localVideoFileRef.current;
    const hostStream = hostStreamRef.current;
    const needsSender =
      !sender ||
      ('isAborted' in sender && sender.isAborted) ||
      ('streamNo' in sender && (sender as P2PRangeSender).streamNo !== data.streamNo);
    const channel = bulkChannelTo(from);
    if (needsSender && data.type === 'p2p-range-request' && data.swarm && !file) {
      // Another viewer asks for blocks we hold (swarm): only from what we have, never fetched for them
      const receiver = streamReceiverRef.current;
      if (
        receiver instanceof P2PRangeReceiver &&
        receiver.swarm &&
        !receiver.isAborted &&
        receiver.streamNo === data.streamNo &&
        channel
      ) {
        let misses: number[] | null = null;
        sender = new P2PRangeSender(null, channel, {
          streamNo: receiver.streamNo,
          fileSize: receiver.fileSize,
          blockSize: receiver.blockSize,
          readBlock: async (block) => {
            // Our current stream of it (it may have restarted since this peer first asked)
            const current = swarmReceiver(data.streamNo);
            const cached = current ? current.getCachedBlock?.(block) : null;
            if (!cached) throw new Error('not here');
            return cached;
          },
          onMiss: (block) => {
            if (!misses) {
              misses = [];
              Promise.resolve().then(() => {
                const blocks = misses;
                misses = null;
                try {
                  channel.send(JSON.stringify({ type: 'p2p-range-miss', streamNo: receiver.streamNo, blocks }));
                } catch {}
              });
            }
            misses.push(block);
          },
          cancelType: 'p2p-swarm-gone'
        });
        activeStreamSendersRef.current.set(from, sender);
      } else if (channel) {
        try {
          channel.send(JSON.stringify({ type: 'p2p-range-miss', streamNo: data.streamNo, blocks: data.blocks || [] }));
        } catch {}
        return;
      }
    } else if (
      needsSender &&
      data.type === 'p2p-range-request' &&
      file &&
      hostStream.file === file &&
      hostStream.streamNo === data.streamNo
    ) {
      // We own the file: a new channel after a rebuild, or a viewer whose parent dropped out
      markDirect(streamTreeRef.current, from);
      if (channel) {
        sender = new P2PRangeSender(file, channel, {
          streamNo: hostStream.streamNo,
          senderName: myName(),
          onBlockRead: checksumAsSent(hostStream)
        });
        activeStreamSendersRef.current.set(from, sender);
      }
    } else if (needsSender && data.type === 'p2p-range-request' && !file) {
      // We are a viewer the owner picked as this peer's relay: pass on what we have
      const receiver = streamReceiverRef.current;
      if (
        receiver instanceof P2PRangeReceiver &&
        !receiver.isAborted &&
        receiver.streamNo === data.streamNo &&
        channel
      ) {
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
    if (
      sender &&
      sender instanceof P2PRangeSender &&
      sender.handleRequest &&
      sender.streamNo === data.streamNo
    ) {
      if (data.type === 'p2p-range-request') {
        sender.handleRequest(data as unknown as Parameters<typeof sender.handleRequest>[0]);
      } else {
        sender.handleCancel(data as unknown as Parameters<typeof sender.handleCancel>[0]);
      }
    }
  };
  usePeerMessageOn(bus, 'p2p-range-request', onRange);
  usePeerMessageOn(bus, 'p2p-range-cancel', onRange);

  // The owner starts a stream to us
  usePeerMessageOn<{
    mode?: string;
    via?: string;
    sender?: string;
    fileSize: number;
    fileName: string;
    totalChunks: number;
    swarm?: boolean;
    streamNo: number;
  }>(bus, 'p2p-stream-header', (data, from) => {
    streamReceiverRef.current?.abort();
    if (data.mode === 'range') {
      // On demand: the player starts right away and fetches what it needs
      const selfId = room.getSelfId();
      const relayId = data.via && data.via !== selfId && bus.channelOf(data.via) ? data.via : null;
      const receiver = new P2PRangeReceiver(data, {
        ownerId: from,
        sourceId: relayId || from,
        getChannel: bulkChannelTo,
        swarm: true, // used when the owner's app does it too (data.swarm)
        onBadBlock: (peerId: string) => {
          room.log(
            `⚠️ A piece of the video from ${room.peerName(peerId) || 'another viewer'} didn't match the original: got it from ${data.sender || 'the owner'} instead.`
          );
        },
        // Phones get less memory for the stream
        cacheLimit: isPhoneLike() ? STREAM_CACHE_BYTES_PHONE : STREAM_CACHE_BYTES,
        bufferAhead: isPhoneLike() ? BUFFER_AHEAD_BYTES_PHONE : BUFFER_AHEAD_BYTES,
        onSourceChange: (_id: string | null, reason: string) => {
          if (streamReceiverRef.current !== receiver) return;
          room.log(`📡 Now streaming straight from ${data.sender || 'the owner'} (${reason}).`);
        },
        onProgress: (prog: Record<string, unknown>) => {
          if (streamReceiverRef.current !== receiver) return;
          setStreamProgress((prev) => ({ ...(prev as StreamProgress), ...prog }));
        }
      });
      streamReceiverRef.current = receiver;
      try {
        if (localStorage.getItem('3rtc_debug') === '1') window.__3rtcStream = receiver;
      } catch {}
      // Viewers that already have parts of it
      for (const [peerId, have] of peerHaveRef.current) {
        if (have.streamNo === receiver.streamNo) receiver.setPeerHave(peerId, have.ranges);
      }
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
      room.log(
        relayId
          ? `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'}, passed along by ${room.peerName(relayId) || 'another viewer'} (plays while it loads).`
          : `📡 Streaming "${data.fileName}" from ${data.sender || 'peer'} (plays while it loads).`
      );
      return;
    }
    // Whole file pushed in chunks (this browser can't stream on demand): plays when it's all here
    room.log(
      `📡 Downloading "${data.fileName}" (${(data.fileSize / (1024 * 1024)).toFixed(1)} MB) from ${data.sender || 'Peer'}: this browser can't stream on demand, so it plays when the download finishes`
    );
    room.notify(
      "This browser can't stream on demand: the video plays once it has downloaded. Reloading the page may fix it."
    );
    const receiver = new P2PStreamReceiver(data, {
      // A partial file can't be played (no length, no index), so the player gets it when complete
      onReady: () => {},
      onProgress: (prog: Record<string, unknown>) =>
        setStreamProgress((prev) => ({ ...(prev as StreamProgress), ...prog })),
      onComplete: (blobUrl: string, meta: { fileSize: number }) => {
        setStreamVideoUrl(blobUrl);
        setStreamProgress((prev) => ({
          ...(prev as StreamProgress),
          percent: 100,
          isReady: true,
          isCompleted: true
        }));
        room.log(
          `✅ Video stream fully buffered (${(meta.fileSize / (1024 * 1024)).toFixed(1)} MB). Ready to play!`
        );
        room.notify('Stream ready to play!');
      },
      onError: (err: Error) => {
        room.log(`❌ Video stream error: ${err.message}`);
        room.notify(`Stream error: ${err.message}`);
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
      isReady: false,
      wholeFile: true
    });
  });

  usePeerMessageOn(bus, 'p2p-stream-complete', () => streamReceiverRef.current?.handleComplete?.());

  // ---- swarm ---------------------------------------------------------------------------------
  const swarmReceiver = (streamNo?: number): P2PRangeReceiver | null => {
    const receiver = streamReceiverRef.current;
    return receiver instanceof P2PRangeReceiver &&
      receiver.swarm &&
      !receiver.isAborted &&
      (streamNo === undefined || receiver.streamNo === streamNo >>> 0)
      ? receiver
      : null;
  };

  usePeerMessageOn<{
    streamNo: number;
    ranges?: number[];
    getting?: number[];
    add?: number[];
    remove?: number[];
  }>(bus, 'p2p-have', (data, from) => {
    if (Array.isArray(data.ranges)) {
      peerHaveRef.current.set(from, { streamNo: data.streamNo >>> 0, ranges: data.ranges });
      const receiver = swarmReceiver(data.streamNo);
      receiver?.setPeerHave(from, data.ranges);
      receiver?.notePeerGetting(from, data.getting || []);
    } else {
      swarmReceiver(data.streamNo)?.updatePeerHave(from, data.add, data.remove, data.getting);
    }
  });

  usePeerMessageOn<{ streamNo: number; blocks?: number[] }>(bus, 'p2p-range-miss', (data, from) =>
    swarmReceiver(data.streamNo)?.handleMiss(from, Array.isArray(data.blocks) ? data.blocks : [])
  );

  usePeerMessageOn(bus, 'p2p-swarm-gone', (_data, from) => swarmReceiver()?.dropPeer(from));

  usePeerMessageOn<{ streamNo: number; hashes?: [number, string][] }>(bus, 'p2p-block-hashes', (data, from) => {
    const receiver = swarmReceiver(data.streamNo);
    if (receiver && from === receiver.ownerId && Array.isArray(data.hashes)) receiver.addHashes(data.hashes);
  });

  // The owner: checksums of blocks, so viewers can check what other viewers sent them
  usePeerMessageOn<{ streamNo: number; blocks?: number[] }>(bus, 'p2p-hash-request', async (data, from) => {
    const file = localVideoFileRef.current;
    const stream = hostStreamRef.current;
    if (
      !file ||
      stream.file !== file ||
      stream.streamNo !== data.streamNo >>> 0 ||
      !Array.isArray(data.blocks)
    ) {
      return;
    }
    const total = Math.ceil(file.size / RANGE_BLOCK_SIZE);
    const blocks = data.blocks
      .slice(0, 512)
      .map((b) => b >>> 0)
      .filter((b) => b < total);
    const reply = (hashes: [number, string][]): void => {
      if (hashes.length && hostStreamRef.current === stream) {
        bus.send(from, 'p2p-block-hashes', { streamNo: stream.streamNo, hashes });
      }
    };
    // The ones we already know (usually all: see onBlockRead) right away, then the rest
    reply(
      blocks
        .filter((b) => stream.hashes.has(b))
        .map((b) => [b, stream.hashes.get(b)!])
    );
    let out: [number, string][] = [];
    for (const b of blocks.filter((x) => !stream.hashes.has(x))) {
      const start = b * RANGE_BLOCK_SIZE;
      try {
        const hex = await sha256Hex(
          (await file.slice(start, Math.min(start + RANGE_BLOCK_SIZE, file.size)).arrayBuffer()) as unknown as BufferSource
        );
        stream.hashes.set(b, hex);
        out.push([b, hex]);
      } catch {
        continue;
      }
      if (out.length >= 8) {
        reply(out);
        out = [];
      }
    }
    reply(out);
  });

  // Tell the room which blocks we hold: what changed, often (others can fetch a block from us
  // soon after we got it); everything now and then, and to newcomers when they connect
  useEffect(() => {
    let sent: { receiver: P2PRangeReceiver | null; version: number; fullAt: number } = {
      receiver: null,
      version: -1,
      fullAt: 0
    };
    const timer = setInterval(() => {
      const receiver = swarmReceiver();
      if (
        !receiver ||
        (sent.receiver === receiver && sent.version === receiver.haveVersion && !receiver.gettingAdded.length)
      ) {
        return;
      }
      const changes = receiver.takeHaveChanges();
      const now = Date.now();
      if (sent.receiver !== receiver || now - sent.fullAt > 10000) {
        bus.broadcast('p2p-have', {
          streamNo: receiver.streamNo,
          ranges: receiver.haveRanges(),
          getting: receiver.gettingNow()
        });
        sent.fullAt = now;
      } else {
        bus.broadcast('p2p-have', {
          streamNo: receiver.streamNo,
          add: changes.add,
          remove: changes.remove,
          getting: changes.getting
        });
      }
      sent = { ...sent, receiver, version: receiver.haveVersion };
    }, 250);

    const offOpen = bus.onEvent('peer-open', (peerId) => {
      const receiver = swarmReceiver();
      if (receiver) bus.send(peerId as string, 'p2p-have', { streamNo: receiver.streamNo, ranges: receiver.haveRanges() });
    });

    return () => {
      clearInterval(timer);
      offOpen();
    };
  }, [bus]);

  // The viewer relaying our stream stopped: fetch straight from the owner
  usePeerMessageOn(bus, 'p2p-relay-gone', (_data, from) => {
    const receiver = streamReceiverRef.current;
    if (receiver instanceof P2PRangeReceiver && receiver.sourceId === from) receiver.useOwner('relay stopped');
  });

  // This peer stopped receiving from us, or (if it owns our stream) stopped sharing it
  usePeerMessageOn(bus, 'p2p-stream-cancel', (_data, from) => {
    stopSenderFor(from);
    detachViewer(streamTreeRef.current, from);
    swarmReceiver()?.dropPeer(from);
    peerHaveRef.current.delete(from);
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
    const offBinary = bus.onBinary((arrayBuffer, fromPeerId) => {
      if (arrayBuffer.byteLength >= 4 && new DataView(arrayBuffer).getUint32(0, false) === IMAGE_MAGIC) {
        return false;
      }
      streamReceiverRef.current?.handleChunk?.(arrayBuffer, fromPeerId);
      return true;
    });
    // A peer is gone: our parent left -> fetch from the owner; a viewer left -> its children do
    const offClose = bus.onEvent('peer-close', (peerId) => {
      peerHaveRef.current.delete(peerId as string);
      streamReceiverRef.current?.handlePeerGone?.(peerId as string);
      detachViewer(streamTreeRef.current, peerId as string);
      stopSenderFor(peerId as string);
    });
    // Their channel closed (it may come back): stop sending to it
    const offChannel = bus.onEvent('channel-close', (peerId) => stopSenderFor(peerId as string));
    const offLeft = bus.onEvent('room-left', () => peerHaveRef.current.clear());
    return () => {
      offBinary();
      offClose();
      offChannel();
      offLeft();
    };
  }, [bus]);

  // On-demand stream: the service worker forwards each byte range the video player asks for
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return undefined;
    const onWorkerMessage = (event: MessageEvent) => {
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
