/**
 * Chat files both ways, over each peer's bulk channel (utils/p2pImageShare.ts, docs/PROTOCOL.md).
 *
 * - Small files (under ACCEPT_MIN_BYTES) go to everyone straight away, as before.
 * - A big file is only announced (`p2p-file-start`); each receiver who accepts it
 *   (`p2p-file-control` `accept`) gets it from its own sender, from the first chunk.
 * - Folders (`p2p-folder-offer`, sent by the desktop app): each file is accepted on its own from
 *   the folder window.
 * - Cancel: ours stops for everyone; a receiver's only for them; once nobody is waiting for or
 *   receiving a file it's over (transferPeers.ts has the rules).
 */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { sound } from '../../utils/sound';
import {
  FILE_CHUNK_SIZE,
  P2PImageSender,
  p2pImageReceiver,
  isImageFile,
  safeImageDownloadName,
  safeFileDownloadName
} from '../../utils/p2pImageShare';
import type { Room } from '../../types';
import { usePeerMessageOn } from '../../core/RoomContext';
import { TransferPeers, needsAccept } from './transferPeers';
import { cleanFolderOffer } from './folderOffer';
import {
  MAX_CHAT_TEXT,
  appendCapped,
  patchTransfer,
  setFolderCancelled,
  setTransferCancelled,
  setTransferPercent,
  type ChatMessage,
  type ChatMessageFile
} from './chatMessages';

const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB limit
const IMAGE_MAGIC = 0x494d4731; // 'IMG1'

/** One of our files: everyone's sender (small files), or one per receiver who accepted. */
interface OutFile {
  file: File | Blob;
  name: string;
  meta: { id: string; sender: string; isHost: boolean; caption: string };
  offered: boolean;
  all?: P2PImageSender;
  each: Map<string, P2PImageSender>;
  progress: Map<string, number>;
  sent: number;
}

type Setter = Dispatch<SetStateAction<ChatMessage[]>>;

export interface FileTransfers {
  sendFile: (file: File | Blob | null, caption?: string) => void;
  acceptTransfer: (transferId: string) => void;
  pauseTransfer: (transferId: string) => void;
  resumeTransfer: (transferId: string) => void;
  cancelTransfer: (transferId: string) => void;
}

export function useFileTransfers(room: Room, setMessages: Setter): FileTransfers {
  const { bus } = room;
  const peersRef = useRef(new TransferPeers());
  const outRef = useRef(new Map<string, OutFile>());
  /** Big files and folder files offered to us, not accepted yet: their announcement. */
  const offersRef = useRef(new Map<string, Record<string, unknown>>());
  /** Transfers we've seen announced (a repeat announcement is not a new chat line). */
  const knownRef = useRef(new Set<string>());
  /** A folder's files (offered to us): which folder. */
  const folderOfRef = useRef(new Map<string, string>());

  const control = useCallback(
    (transferId: string, action: 'pause' | 'resume' | 'accept' | 'cancel', startChunk?: number) =>
      bus.broadcast('p2p-file-control', {
        type: 'p2p-file-control',
        transferId,
        action,
        ...(typeof startChunk === 'number' ? { startChunk } : {})
      }),
    [bus]
  );

  /** Shows where our offered file is with its receivers. */
  const showSendState = useCallback(
    (transferId: string) => {
      const out = outRef.current.get(transferId);
      const status = peersRef.current.status(transferId);
      if (!out?.offered || !status) return;
      setMessages(patchTransfer(transferId, { send: { ...status, sent: Math.max(status.sent, out.sent) } }));
    },
    [setMessages]
  );

  /** Everyone who wanted our file has it. */
  const outOver = useCallback(
    (transferId: string) => {
      outRef.current.delete(transferId);
      peersRef.current.finish(transferId);
      setMessages((prev) => prev.map((m) => (m.transferId === transferId ? { ...m, imageTransfer: null } : m)));
    },
    [setMessages]
  );

  /** Stops sending our file to everyone (`tell`: and tells them), and shows it cancelled. */
  const stopSending = useCallback(
    (transferId: string, tell = true) => {
      const out = outRef.current.get(transferId);
      out?.all?.abort();
      for (const s of out?.each.values() || []) s.abort();
      outRef.current.delete(transferId);
      peersRef.current.finish(transferId);
      if (tell) control(transferId, 'cancel');
      setMessages(setTransferCancelled(transferId));
    },
    [control, setMessages]
  );

  const nobodyReceiving = useCallback(
    (transferId: string) => {
      const name = outRef.current.get(transferId)?.name || 'the file';
      stopSending(transferId);
      room.notify(`Stopped sending ${name}: nobody is receiving it`);
    },
    [room, stopSending]
  );

  /** `peer` has all of our file. */
  const deliveredTo = useCallback(
    (transferId: string, peer: string) => {
      const out = outRef.current.get(transferId);
      if (out) {
        out.each.delete(peer);
        out.progress.delete(peer);
        out.sent += 1;
      }
      if (peersRef.current.delivered(transferId, peer)) outOver(transferId);
      else showSendState(transferId);
    },
    [outOver, showSendState]
  );

  /** A receiver cancelled, declined or left (or their copy failed): no more of it goes to them. */
  const dropReceiver = useCallback(
    (transferId: string, peer: string, outcome = peersRef.current.onCancel(transferId, peer)) => {
      const out = outRef.current.get(transferId);
      out?.each.get(peer)?.abort();
      out?.each.delete(peer);
      out?.progress.delete(peer);
      if (outcome.kind === 'over') {
        if (outcome.ended === 'nobody-got-it') nobodyReceiving(transferId);
        else outOver(transferId);
      } else {
        showSendState(transferId);
      }
    },
    [nobodyReceiving, outOver, showSendState]
  );

  /** `peer` accepted our big file: a sender of its own, from the first chunk. */
  const startTo = useCallback(
    (transferId: string, peer: string) => {
      const out = outRef.current.get(transferId);
      if (!out) return;
      const channels = () =>
        peersRef.current.isDropped(transferId, peer)
          ? []
          : ([bus.channelOf(peer, { bulk: true })].filter(Boolean) as unknown as RTCDataChannel[]);
      const sender = new P2PImageSender(out.file, channels, {
        ...out.meta,
        transferId,
        onProgress: ({ percent }) => {
          out.progress.set(peer, percent);
          const all = [...out.progress.values()];
          const avg = Math.round(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length));
          setMessages(setTransferPercent(transferId, avg));
        },
        onComplete: () => deliveredTo(transferId, peer),
        onError: (err) => {
          room.log(`❌ File transfer to a peer failed: ${err.message}`);
          dropReceiver(transferId, peer);
        }
      });
      out.each.set(peer, sender);
      // the announcement again (to them only), then the frames
      sender.start();
    },
    [bus, deliveredTo, dropReceiver, room, setMessages]
  );

  // Leaving the room: everything stops
  useEffect(
    () =>
      bus.onEvent('room-left', () => {
        for (const out of outRef.current.values()) {
          out.all?.abort();
          for (const s of out.each.values()) s.abort();
        }
        outRef.current.clear();
        offersRef.current.clear();
        knownRef.current.clear();
        folderOfRef.current.clear();
        p2pImageReceiver.reset();
        peersRef.current.reset();
      }),
    [bus]
  );

  // Transfers with no frame for 5 minutes are dropped
  useEffect(() => {
    const timer = setInterval(() => p2pImageReceiver.cleanStale(300000), 60000);
    return () => clearInterval(timer);
  }, []);

  // Someone left: they no longer get our files (one nobody gets stops), and theirs can't come
  useEffect(
    () =>
      bus.onEvent<string>('peer-close', (peerId) => {
        if (typeof peerId !== 'string') return;
        for (const out of outRef.current.values()) out.each.get(peerId)?.abort();
        for (const [transferId, ended] of peersRef.current.peerGone(peerId)) {
          if (ended === 'nobody-got-it') nobodyReceiving(transferId);
          else outOver(transferId);
        }
        for (const transferId of [...offersRef.current.keys()]) {
          if (peersRef.current.senderOf(transferId) !== peerId) continue;
          offersRef.current.delete(transferId);
          peersRef.current.finish(transferId);
          setMessages(setTransferCancelled(transferId));
        }
      }),
    [bus, nobodyReceiving, outOver, setMessages]
  );

  // Reconnected: ask for the rest of what's coming in; carry on with what we send
  useEffect(
    () =>
      bus.onEvent('peer-open', () => {
        for (const [tid, tr] of p2pImageReceiver.transfers.entries()) {
          if (tr.receivedCount < tr.totalChunks) {
            bus.broadcast('p2p-file-sync', {
              type: 'p2p-file-sync',
              transferId: tid,
              resumeFromChunk: p2pImageReceiver.getResumeChunk(tid)
            });
          }
        }
        for (const out of outRef.current.values()) {
          if (out.all?.isPaused) out.all.resume();
          for (const s of out.each.values()) if (s.isPaused) s.resume();
        }
      }),
    [bus]
  );

  // A file announced to us: small ones come now, big ones wait for Accept
  const onStart = (data: Record<string, unknown>, from: string) => {
    const transferId = typeof data?.transferId === 'string' ? data.transferId : '';
    if (!transferId || transferId.length > 64) return;
    if (knownRef.current.has(transferId) || folderOfRef.current.has(transferId)) {
      // announced again (its frames follow now): never a second chat line
      if (!offersRef.current.has(transferId) && peersRef.current.senderOf(transferId) === from) {
        p2pImageReceiver.handleStart(data);
      }
      return;
    }
    knownRef.current.add(transferId);
    peersRef.current.receiving(transferId, from);
    const fileName = typeof data.fileName === 'string' ? data.fileName.slice(0, 120) : 'file';
    const fileSize = Number.isFinite(data.fileSize) ? (data.fileSize as number) : 0;
    const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream';
    const offered = needsAccept(fileSize);
    if (offered) offersRef.current.set(transferId, data);
    else p2pImageReceiver.handleStart(data);
    setMessages((prev) =>
      appendCapped(prev, {
        type: 'chat',
        id: typeof data.id === 'string' ? String(data.id).slice(0, 64) : crypto.randomUUID(),
        transferId,
        sender: room.peerName(from) || (typeof data.sender === 'string' ? data.sender : 'Peer'),
        isHost: room.isPeerHost(from),
        text: typeof data.caption === 'string' ? data.caption.slice(0, MAX_CHAT_TEXT) : '',
        imageTransfer: {
          transferId,
          isTransferring: !offered,
          isOffered: offered,
          isPaused: false,
          percent: 0,
          fileName,
          fileSize,
          mimeType,
          isImage: isImageFile({ type: mimeType, name: fileName } as File)
        },
        isSelf: false,
        timestamp: Number.isFinite(data.timestamp) ? Math.min(data.timestamp as number, Date.now() + 60000) : Date.now()
      })
    );
    sound.playChime();
  };
  usePeerMessageOn<Record<string, unknown>>(bus, 'p2p-image-start', onStart);
  usePeerMessageOn<Record<string, unknown>>(bus, 'p2p-file-start', onStart);

  // A folder offered to us: one chat line, each file waits to be picked
  usePeerMessageOn<Record<string, unknown>>(bus, 'p2p-folder-offer', (data, from) => {
    const folder = cleanFolderOffer(data || {});
    if (!folder || knownRef.current.has(folder.folderId)) return;
    knownRef.current.add(folder.folderId);
    peersRef.current.receiving(folder.folderId, from);
    for (const f of folder.files) {
      peersRef.current.receiving(f.transferId, from);
      folderOfRef.current.set(f.transferId, folder.folderId);
      offersRef.current.set(f.transferId, {
        id: f.transferId,
        transferId: f.transferId,
        fileName: f.fileName,
        fileSize: f.fileSize,
        mimeType: f.mimeType,
        totalChunks: Math.max(1, Math.ceil(f.fileSize / FILE_CHUNK_SIZE))
      });
    }
    setMessages((prev) =>
      appendCapped(prev, {
        type: 'chat',
        id: typeof data.id === 'string' ? String(data.id).slice(0, 64) : folder.folderId,
        sender: room.peerName(from) || 'Peer',
        isHost: room.isPeerHost(from),
        text: typeof data.caption === 'string' ? data.caption.slice(0, MAX_CHAT_TEXT) : '',
        folder: {
          folderId: folder.folderId,
          name: folder.name,
          files: folder.files.map((f) => ({ ...f, state: 'offered' as const, percent: 0 }))
        },
        isSelf: false,
        timestamp: Number.isFinite(data.timestamp) ? Math.min(data.timestamp as number, Date.now() + 60000) : Date.now()
      })
    );
    sound.playChime();
  });

  // pause, resume, accept, cancel from a peer
  usePeerMessageOn<{ transferId?: string; action?: string; startChunk?: number }>(
    bus,
    'p2p-file-control',
    (data, from) => {
      const tid = data?.transferId;
      if (!tid) return;
      const out = outRef.current.get(tid);
      switch (data.action) {
        case 'accept':
          if (out?.offered && peersRef.current.onAccept(tid, from)) {
            startTo(tid, from);
            showSendState(tid);
          }
          return;
        case 'pause':
          if (out) (out.offered ? out.each.get(from) : out.all)?.pause();
          p2pImageReceiver.pause(tid);
          if (!out?.offered) setMessages(patchTransfer(tid, { isPaused: true }));
          return;
        case 'resume': {
          const sender = out ? (out.offered ? out.each.get(from) : out.all) : undefined;
          if (sender) {
            if (typeof data.startChunk === 'number') sender.seekTo(data.startChunk);
            sender.resume();
          }
          p2pImageReceiver.resume(tid);
          if (!out?.offered) setMessages(patchTransfer(tid, { isPaused: false }));
          return;
        }
        case 'cancel': {
          const outcome = peersRef.current.onCancel(tid, from);
          if (outcome.kind === 'stop-to' || outcome.kind === 'over') {
            dropReceiver(tid, from, outcome);
          } else if (outcome.kind === 'cancelled') {
            // a folder: all its files; else that file
            const files = [...folderOfRef.current].filter(([, f]) => f === tid).map(([t]) => t);
            for (const t of [tid, ...files]) {
              offersRef.current.delete(t);
              p2pImageReceiver.abort(t);
              peersRef.current.finish(t);
            }
            setMessages(files.length ? setFolderCancelled(tid) : setTransferCancelled(tid));
          }
          return;
        }
        default:
          break;
      }
    }
  );

  // a receiver back after a reconnect asks for the rest
  usePeerMessageOn<{ transferId?: string; resumeFromChunk?: number }>(bus, 'p2p-file-sync', (data, from) => {
    const tid = data?.transferId;
    const out = tid ? outRef.current.get(tid) : undefined;
    if (!tid || !out) return;
    peersRef.current.rejoin(tid, from);
    const sender = out.offered ? out.each.get(from) : out.all;
    if (!sender) return;
    if (typeof data.resumeFromChunk === 'number' && data.resumeFromChunk >= 0) sender.seekTo(data.resumeFromChunk);
    sender.resume();
    if (!out.offered) setMessages(patchTransfer(tid, { isPaused: false }));
  });

  // the frames
  useEffect(
    () =>
      bus.onBinary((arrayBuffer: ArrayBuffer) => {
        if (arrayBuffer.byteLength < 4 || new DataView(arrayBuffer).getUint32(0, false) !== IMAGE_MAGIC) {
          return false;
        }
        p2pImageReceiver.handleChunk(arrayBuffer, {
          onProgress: (transferId, percent, tr) =>
            setMessages(setTransferPercent(transferId, percent, Boolean(tr.isPaused))),
          onComplete: (transferId, result) => {
            peersRef.current.finish(transferId);
            const fileItem: ChatMessageFile = {
              url: result.objectUrl,
              name: result.fileName,
              size: result.fileSize,
              mimeType: result.mimeType,
              blob: result.blob,
              isImage: isImageFile({ type: result.mimeType, name: result.fileName } as File)
            };
            if (folderOfRef.current.has(transferId)) {
              setMessages(patchTransfer(transferId, {}, { state: 'done', percent: 100, file: fileItem }));
              return;
            }
            setMessages((prev) =>
              prev.map((m) =>
                m.transferId === transferId ? { ...m, imageTransfer: null, image: fileItem, file: fileItem } : m
              )
            );
            sound.playPop();
          }
        });
        return true;
      }),
    [bus, setMessages]
  );

  const sendFile = useCallback(
    (file: File | Blob | null, caption = '') => {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        room.notify('File exceeds 10 GB limit. Please select a smaller file.');
        return;
      }
      // files stream over bulk channels so control and chat traffic never wait behind them
      const receivers = bus.connectedPeerIds().filter((id: string) => bus.channelOf(id, { bulk: true }));
      if (receivers.length === 0) {
        room.notify('Waiting for peer to connect before sending file');
        return;
      }
      const { username, isHost } = room.getSelf();
      const messageId = crypto.randomUUID();
      const transferId = crypto.randomUUID();
      const isImg = isImageFile(file);
      const rawName = (file instanceof File ? file.name : '') || (isImg ? 'screenshot.png' : 'file.bin');
      const safeName = isImg ? safeImageDownloadName(rawName, file.type) : safeFileDownloadName(rawName, file.type);
      const mime = file.type || (isImg ? 'image/png' : 'application/octet-stream');
      const offered = needsAccept(file.size);
      const fileItem: ChatMessageFile = {
        url: URL.createObjectURL(file),
        name: safeName,
        size: file.size,
        mimeType: mime,
        blob: file,
        isImage: isImg
      };
      setMessages((prev) =>
        appendCapped(prev, {
          type: 'chat',
          id: messageId,
          transferId,
          sender: username,
          isHost,
          text: caption,
          image: fileItem,
          file: fileItem,
          imageTransfer: {
            transferId,
            isTransferring: true,
            isPaused: false,
            percent: 0,
            fileName: safeName,
            fileSize: file.size,
            mimeType: mime,
            isImage: isImg,
            ...(offered ? { send: { waiting: receivers.length, sending: 0, sent: 0 } } : {})
          },
          isSelf: true,
          timestamp: Date.now()
        })
      );
      sound.playPop();

      const meta = { id: messageId, sender: username, isHost, caption };
      const out: OutFile = { file, name: safeName, meta, offered, each: new Map(), progress: new Map(), sent: 0 };
      outRef.current.set(transferId, out);
      // everyone it's announced to gets it (offered: once they accept), until they cancel or leave
      peersRef.current.sending(transferId, receivers, offered);
      // the bulk channels of everyone still receiving it (not those who cancelled or left)
      const channels = () =>
        bus
          .connectedPeerIds()
          .filter((id: string) => !peersRef.current.isDropped(transferId, id))
          .map((id: string) => bus.channelOf(id, { bulk: true }))
          .filter(Boolean) as unknown as RTCDataChannel[];
      const all = new P2PImageSender(file, offered ? () => receivers.map((id) => bus.channelOf(id, { bulk: true })).filter(Boolean) as unknown as RTCDataChannel[] : channels, {
        ...meta,
        transferId,
        onProgress: ({ percent, isPaused }) => setMessages(setTransferPercent(transferId, percent, Boolean(isPaused))),
        onComplete: () => {
          for (const peer of receivers) {
            if (!peersRef.current.isDropped(transferId, peer)) peersRef.current.delivered(transferId, peer);
          }
          outOver(transferId);
        },
        onError: (err) => {
          outRef.current.delete(transferId);
          peersRef.current.finish(transferId);
          room.log(`❌ File transfer failed: ${err.message}`);
          room.notify(`File send failed: ${err.message}`);
        }
      });
      if (offered) {
        // only the announcement: each receiver who accepts gets a sender of their own
        all.announce();
        return;
      }
      out.all = all;
      all.start();
    },
    [bus, outOver, room, setMessages]
  );

  /** Accept (a big file's card, or a folder's file): its sender starts sending it to us. */
  const acceptTransfer = useCallback(
    (transferId: string) => {
      const start = offersRef.current.get(transferId);
      if (!start) return;
      offersRef.current.delete(transferId);
      p2pImageReceiver.handleStart(start);
      control(transferId, 'accept');
      setMessages(
        patchTransfer(transferId, { isOffered: false, isTransferring: true, percent: 0 }, { state: 'receiving', percent: 0 })
      );
    },
    [control, setMessages]
  );

  const pauseTransfer = useCallback(
    (transferId: string) => {
      const out = outRef.current.get(transferId);
      out?.all?.pause();
      for (const s of out?.each.values() || []) s.pause();
      p2pImageReceiver.pause(transferId);
      control(transferId, 'pause');
      setMessages(patchTransfer(transferId, { isPaused: true }));
    },
    [control, setMessages]
  );

  const resumeTransfer = useCallback(
    (transferId: string) => {
      const out = outRef.current.get(transferId);
      out?.all?.resume();
      for (const s of out?.each.values() || []) s.resume();
      p2pImageReceiver.resume(transferId);
      control(transferId, 'resume', p2pImageReceiver.getResumeChunk(transferId));
      setMessages(patchTransfer(transferId, { isPaused: false }));
    },
    [control, setMessages]
  );

  // The card's Cancel (or Decline). Our file: it stops for everyone. Theirs: we stop getting it
  // (the sender stops sending to us, and stops altogether once nobody's left).
  const cancelTransfer = useCallback(
    (transferId: string) => {
      if (outRef.current.has(transferId) || peersRef.current.isOurs(transferId)) {
        stopSending(transferId);
        return;
      }
      offersRef.current.delete(transferId);
      p2pImageReceiver.abort(transferId);
      peersRef.current.finish(transferId);
      control(transferId, 'cancel');
      setMessages(setTransferCancelled(transferId));
    },
    [control, setMessages, stopSending]
  );

  return { sendFile, acceptTransfer, pauseTransfer, resumeTransfer, cancelTransfer };
}
