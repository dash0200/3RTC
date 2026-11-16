/**
 * Chat: text messages, P2P images (sent over each peer's bulk channel) and the unread count.
 *
 * Wire messages: 'chat' { id, sender, isHost, text }, 'p2p-image-start' { ... } followed by
 * binary 'IMG1' frames (utils/p2pImageShare.ts).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { sound } from '../../utils/sound';
import {
  P2PImageSender,
  p2pImageReceiver,
  isImageFile,
  safeImageDownloadName,
  safeFileDownloadName
} from '../../utils/p2pImageShare';
import type { Room } from '../../types';
import { usePeerMessageOn } from '../../core/RoomContext';

const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB limit
const MAX_MESSAGES = 300; // older ones are dropped (and their file memory freed)
const MAX_CHAT_TEXT = 2000; // (the box allows 200; more from a peer is cut)
const IMAGE_MAGIC = 0x494d4731; // 'IMG1'

export interface ChatMessageTransfer {
  transferId: string;
  isTransferring: boolean;
  isPaused?: boolean;
  percent: number;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  isImage?: boolean;
}

export interface ChatMessageFile {
  url: string;
  name: string;
  size: number;
  mimeType: string;
  blob?: Blob;
  isImage?: boolean;
}

export type ChatMessageImage = ChatMessageFile;

export interface ChatMessage {
  type: 'chat';
  id: string;
  sender: string;
  isHost?: boolean;
  text: string;
  timestamp: number;
  isSelf: boolean;
  transferId?: string;
  image?: ChatMessageFile;
  file?: ChatMessageFile;
  imageTransfer?: ChatMessageTransfer | null;
}

export interface UseChatOptions {
  room: Room;
  isChatOpen: boolean;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  unreadChatCount: number;
  sendMessage: (text: string) => void;
  sendImage: (file: File | Blob | null, caption?: string) => void;
  sendFile: (file: File | Blob | null, caption?: string) => void;
  pauseTransfer: (transferId: string) => void;
  resumeTransfer: (transferId: string) => void;
  cancelTransfer: (transferId: string) => void;
}

// Append and keep the list bounded
const appendCapped = (prev: ChatMessage[], item: ChatMessage): ChatMessage[] => {
  const next = prev.concat([item]);
  if (next.length <= MAX_MESSAGES) return next;
  const dropped = next.splice(0, next.length - MAX_MESSAGES);
  for (const m of dropped) {
    const url = m.file?.url || m.image?.url;
    if (url?.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    }
  }
  return next;
};

const setTransferPercent =
  (transferId: string, percent: number, isPaused = false) =>
  (prev: ChatMessage[]): ChatMessage[] =>
    prev.map((m) =>
      m.transferId === transferId && m.imageTransfer
        ? { ...m, imageTransfer: { ...m.imageTransfer, percent, isPaused } }
        : m
    );

export function useChat({ room, isChatOpen }: UseChatOptions): UseChatReturn {
  const { bus } = room;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const prevLengthRef = useRef<number>(0);
  const activeSendersRef = useRef<Map<string, P2PImageSender>>(new Map());

  useEffect(() => {
    if (isChatOpen) {
      setUnreadChatCount(0);
    } else {
      const diff = messages.length - prevLengthRef.current;
      if (diff > 0) setUnreadChatCount((prev) => prev + diff);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, isChatOpen]);

  // Clear messages, revoke blob URLs, abort active senders and reset state when leaving a room
  useEffect(
    () =>
      bus.onEvent('room-left', () => {
        for (const [, sender] of activeSendersRef.current.entries()) {
          sender.abort();
        }
        activeSendersRef.current.clear();
        setMessages((prev) => {
          for (const m of prev) {
            const url = m.file?.url || m.image?.url;
            if (url?.startsWith('blob:')) {
              try {
                URL.revokeObjectURL(url);
              } catch {
                /* already gone */
              }
            }
          }
          return [];
        });
        setUnreadChatCount(0);
        prevLengthRef.current = 0;
        lastReactionRef.current.clear();
        p2pImageReceiver.reset();
      }),
    [bus]
  );

  // Periodically clean up stale/abandoned transfers
  useEffect(() => {
    const timer = setInterval(() => {
      p2pImageReceiver.cleanStale(300000);
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Reconnection handshake: when connection opens/reopens, sync incomplete transfers
  useEffect(() => {
    return bus.onEvent('peer-open', () => {
      // 1. If we are receiving files and have an incomplete transfer, request resume
      for (const [tid, tr] of p2pImageReceiver.transfers.entries()) {
        if (tr.receivedCount < tr.totalChunks) {
          const resumeFromChunk = p2pImageReceiver.getResumeChunk(tid);
          bus.broadcast('p2p-file-sync', {
            type: 'p2p-file-sync',
            transferId: tid,
            resumeFromChunk
          });
        }
      }
      // 2. If we have active senders that were paused due to network disconnect, resume them
      for (const [, sender] of activeSendersRef.current.entries()) {
        if (sender.isPaused) {
          sender.resume();
        }
      }
    });
  }, [bus]);

  // Older apps also post every reaction-button tap as a chat message
  const lastReactionRef = useRef<Map<string, { emoji: string; at: number }>>(new Map()); // peerId -> { emoji, at }

  usePeerMessageOn<{ emoji?: string }>(bus, 'reaction', (data, from) => {
    if (typeof data?.emoji === 'string') {
      lastReactionRef.current.set(from, { emoji: data.emoji, at: Date.now() });
    }
  });

  usePeerMessageOn<{
    id?: string;
    sender?: string;
    text?: string;
    timestamp?: number;
  }>(bus, 'chat', (data, from) => {
    const reaction = lastReactionRef.current.get(from);
    if (
      reaction &&
      typeof data.text === 'string' &&
      data.text.trim() === reaction.emoji &&
      Date.now() - reaction.at < 2500
    ) {
      return;
    }
    const text = data.text;
    if (typeof text !== 'string' || !text.trim()) return;
    setMessages((prev) =>
      appendCapped(prev, {
        type: 'chat',
        id: typeof data.id === 'string' ? data.id.slice(0, 64) : crypto.randomUUID(),
        sender: room.peerName(from) || data.sender || 'Peer',
        isHost: room.isPeerHost(from),
        text: text.slice(0, MAX_CHAT_TEXT),
        timestamp: Number.isFinite(data.timestamp)
          ? Math.min(data.timestamp as number, Date.now() + 60000)
          : Date.now(),
        isSelf: false
      })
    );
    sound.playPop();
  });

  // Handle incoming start of image or arbitrary file transfer
  const handleIncomingTransferStart = (data: Record<string, unknown>, from: string) => {
    const transferId = typeof data?.transferId === 'string' ? data.transferId : '';
    if (!transferId || transferId.length > 64) return;
    p2pImageReceiver.handleStart(data);
    const fileName = typeof data.fileName === 'string' ? data.fileName.slice(0, 120) : 'file';
    const fileSize = Number.isFinite(data.fileSize) ? (data.fileSize as number) : 0;
    const mimeType = typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream';
    const isImg = isImageFile({ type: mimeType, name: fileName } as File);

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
          isTransferring: true,
          isPaused: false,
          percent: 0,
          fileName,
          fileSize,
          mimeType,
          isImage: isImg
        },
        isSelf: false,
        timestamp: Number.isFinite(data.timestamp)
          ? Math.min(data.timestamp as number, Date.now() + 60000)
          : Date.now()
      })
    );
    sound.playChime();
  };

  usePeerMessageOn<Record<string, unknown>>(bus, 'p2p-image-start', handleIncomingTransferStart);
  usePeerMessageOn<Record<string, unknown>>(bus, 'p2p-file-start', handleIncomingTransferStart);

  // Handle remote pause, resume, or cancel control commands
  usePeerMessageOn<{ transferId?: string; action?: string; startChunk?: number }>(
    bus,
    'p2p-file-control',
    (data) => {
      const tid = data?.transferId;
      if (!tid) return;
      const action = data.action;
      if (action === 'pause') {
        const sender = activeSendersRef.current.get(tid);
        if (sender) sender.pause();
        p2pImageReceiver.pause(tid);
        setMessages((prev) =>
          prev.map((m) =>
            m.transferId === tid && m.imageTransfer
              ? { ...m, imageTransfer: { ...m.imageTransfer, isPaused: true } }
              : m
          )
        );
      } else if (action === 'resume') {
        const sender = activeSendersRef.current.get(tid);
        if (sender) {
          if (typeof data.startChunk === 'number') {
            sender.seekTo(data.startChunk);
          }
          sender.resume();
        }
        p2pImageReceiver.resume(tid);
        setMessages((prev) =>
          prev.map((m) =>
            m.transferId === tid && m.imageTransfer
              ? { ...m, imageTransfer: { ...m.imageTransfer, isPaused: false } }
              : m
          )
        );
      } else if (action === 'cancel') {
        const sender = activeSendersRef.current.get(tid);
        if (sender) {
          sender.abort();
          activeSendersRef.current.delete(tid);
        }
        p2pImageReceiver.abort(tid);
        setMessages((prev) => prev.filter((m) => m.transferId !== tid));
      }
    }
  );

  // Handle reconnect resume sync: peer asks us to resume from specific chunk
  usePeerMessageOn<{ transferId?: string; resumeFromChunk?: number }>(
    bus,
    'p2p-file-sync',
    (data) => {
      const tid = data?.transferId;
      if (!tid) return;
      const sender = activeSendersRef.current.get(tid);
      if (sender) {
        if (typeof data.resumeFromChunk === 'number' && data.resumeFromChunk >= 0) {
          sender.seekTo(data.resumeFromChunk);
        }
        sender.resume();
        setMessages((prev) =>
          prev.map((m) =>
            m.transferId === tid && m.imageTransfer
              ? { ...m, imageTransfer: { ...m.imageTransfer, isPaused: false } }
              : m
          )
        );
      }
    }
  );

  useEffect(
    () =>
      bus.onBinary((arrayBuffer: ArrayBuffer) => {
        if (
          arrayBuffer.byteLength < 4 ||
          new DataView(arrayBuffer).getUint32(0, false) !== IMAGE_MAGIC
        ) {
          return false;
        }
        p2pImageReceiver.handleChunk(arrayBuffer, {
          onProgress: (transferId, percent, tr) =>
            setMessages(setTransferPercent(transferId, percent, Boolean(tr.isPaused))),
          onComplete: (transferId, result) => {
            const isImg = isImageFile({ type: result.mimeType, name: result.fileName } as File);
            const fileItem: ChatMessageFile = {
              url: result.objectUrl,
              name: result.fileName,
              size: result.fileSize,
              mimeType: result.mimeType,
              blob: result.blob,
              isImage: isImg
            };
            setMessages((prev) =>
              prev.map((m) =>
                m.transferId === transferId
                  ? {
                      ...m,
                      imageTransfer: null,
                      image: fileItem,
                      file: fileItem
                    }
                  : m
              )
            );
            sound.playPop();
          }
        });
        return true;
      }),
    [bus]
  );

  const sendMessage = useCallback(
    (text: string) => {
      const { username, isHost } = room.getSelf();
      const msg = {
        type: 'chat' as const,
        id: crypto.randomUUID(),
        sender: username,
        isHost,
        text,
        timestamp: Date.now()
      };
      if (bus.broadcast('chat', msg) > 0) {
        setMessages((prev) => appendCapped(prev, { ...msg, isSelf: true }));
        sound.playPop();
      } else {
        room.notify('Waiting for peer to connect before sending');
      }
    },
    [bus, room]
  );

  const sendFile = useCallback(
    (file: File | Blob | null, caption = '') => {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        room.notify('File exceeds 10 GB limit. Please select a smaller file.');
        return;
      }
      // Files and images stream over bulk channels so control and chat traffic never wait behind them
      const getChannels = () =>
        bus
          .connectedPeerIds()
          .map((id: string) => bus.channelOf(id, { bulk: true }))
          .filter(Boolean) as unknown as RTCDataChannel[];

      if (getChannels().length === 0) {
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
      const previewUrl = URL.createObjectURL(file);

      const fileItem: ChatMessageFile = {
        url: previewUrl,
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
            isImage: isImg
          },
          isSelf: true,
          timestamp: Date.now()
        })
      );
      sound.playPop();

      const sender = new P2PImageSender(file, getChannels, {
        id: messageId,
        transferId,
        sender: username,
        isHost,
        caption,
        onProgress: ({ percent, isPaused }) =>
          setMessages(setTransferPercent(transferId, percent, Boolean(isPaused))),
        onComplete: () => {
          activeSendersRef.current.delete(transferId);
          setMessages((prev) =>
            prev.map((m) => (m.transferId === transferId ? { ...m, imageTransfer: null } : m))
          );
        },
        onError: (err) => {
          activeSendersRef.current.delete(transferId);
          room.log(`❌ File transfer failed: ${err.message}`);
          room.notify(`File send failed: ${err.message}`);
        }
      });

      activeSendersRef.current.set(transferId, sender);
      sender.start();
    },
    [bus, room]
  );

  const pauseTransfer = useCallback(
    (transferId: string) => {
      const sender = activeSendersRef.current.get(transferId);
      if (sender) {
        sender.pause();
      }
      p2pImageReceiver.pause(transferId);
      bus.broadcast('p2p-file-control', {
        type: 'p2p-file-control',
        transferId,
        action: 'pause'
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.transferId === transferId && m.imageTransfer
            ? { ...m, imageTransfer: { ...m.imageTransfer, isPaused: true } }
            : m
        )
      );
    },
    [bus]
  );

  const resumeTransfer = useCallback(
    (transferId: string) => {
      const sender = activeSendersRef.current.get(transferId);
      if (sender) {
        sender.resume();
      }
      p2pImageReceiver.resume(transferId);
      const resumeChunk = p2pImageReceiver.getResumeChunk(transferId);
      bus.broadcast('p2p-file-control', {
        type: 'p2p-file-control',
        transferId,
        action: 'resume',
        startChunk: resumeChunk
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.transferId === transferId && m.imageTransfer
            ? { ...m, imageTransfer: { ...m.imageTransfer, isPaused: false } }
            : m
        )
      );
    },
    [bus]
  );

  const cancelTransfer = useCallback(
    (transferId: string) => {
      const sender = activeSendersRef.current.get(transferId);
      if (sender) {
        sender.abort();
        activeSendersRef.current.delete(transferId);
      }
      p2pImageReceiver.abort(transferId);
      bus.broadcast('p2p-file-control', {
        type: 'p2p-file-control',
        transferId,
        action: 'cancel'
      });
      setMessages((prev) => prev.filter((m) => m.transferId !== transferId));
    },
    [bus]
  );

  const sendImage = useCallback(
    (file: File | Blob | null, caption = '') => {
      sendFile(file, caption);
    },
    [sendFile]
  );

  return {
    messages,
    unreadChatCount,
    sendMessage,
    sendImage,
    sendFile,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer
  };
}
