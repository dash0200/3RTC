/**
 * Chat: text messages, files (useFileTransfers.ts: over each peer's bulk channel, big ones and
 * folders only to whoever accepts them) and the unread count.
 *
 * Wire messages: 'chat' { id, sender, isHost, text, replyTo?, mentions? }, 'p2p-image-start' { ... }
 * followed by binary 'IMG1' frames (utils/p2pImageShare.ts).
 *
 * Rich chat (older apps ignore the new fields and show the text): `replyTo { id, sender, text }`
 * quotes an earlier message (`text` a short plain snippet), `mentions` lists the peer ids named
 * with @Name; the people mentioned get a notice. Formatting is in the text (utils/chatFormat.ts).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { sound } from '../../utils/sound';
import type { Room } from '../../types';
import { usePeerMessageOn } from '../../core/RoomContext';
import { MAX_MENTIONS, plainSnippet } from '../../utils/chatFormat';
import { cleanMentions, cleanReplyRef, type ChatReplyRef } from './chatFields';
import { MAX_CHAT_TEXT, appendCapped, releaseMessage, type ChatMessage } from './chatMessages';
import { useFileTransfers } from './useFileTransfers';

export type { ChatReplyRef } from './chatFields';
export type {
  ChatMessage,
  ChatMessageFile,
  ChatMessageImage,
  ChatMessageTransfer,
  ChatMessageFolder,
  ChatFolderFile
} from './chatMessages';

export interface UseChatOptions {
  room: Room;
  isChatOpen: boolean;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  unreadChatCount: number;
  sendMessage: (text: string, extras?: { replyTo?: ChatReplyRef | null; mentions?: string[] }) => void;
  sendImage: (file: File | Blob | null, caption?: string) => void;
  sendFile: (file: File | Blob | null, caption?: string) => void;
  acceptTransfer: (transferId: string) => void;
  pauseTransfer: (transferId: string) => void;
  resumeTransfer: (transferId: string) => void;
  cancelTransfer: (transferId: string) => void;
}

export function useChat({ room, isChatOpen }: UseChatOptions): UseChatReturn {
  const { bus } = room;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const prevLengthRef = useRef<number>(0);
  const files = useFileTransfers(room, setMessages);

  useEffect(() => {
    if (isChatOpen) {
      setUnreadChatCount(0);
    } else {
      const diff = messages.length - prevLengthRef.current;
      if (diff > 0) setUnreadChatCount((prev) => prev + diff);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, isChatOpen]);

  // Older apps also post every reaction-button tap as a chat message
  const lastReactionRef = useRef<Map<string, { emoji: string; at: number }>>(new Map()); // peerId -> { emoji, at }

  // Clear messages and free their files when leaving a room (useFileTransfers stops the transfers)
  useEffect(
    () =>
      bus.onEvent('room-left', () => {
        setMessages((prev) => {
          for (const m of prev) releaseMessage(m);
          return [];
        });
        setUnreadChatCount(0);
        prevLengthRef.current = 0;
        lastReactionRef.current.clear();
      }),
    [bus]
  );

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
    replyTo?: unknown;
    mentions?: unknown;
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
    const replyTo = cleanReplyRef(data.replyTo);
    const mentions = cleanMentions(data.mentions);
    const selfId = room.getSelfId();
    const mentionsMe = Boolean(selfId && mentions.includes(selfId));
    const sender = room.peerName(from) || data.sender || 'Peer';
    setMessages((prev) => {
      // A reply quotes our own copy of the message when we have it (names can't be faked there)
      const quoted = replyTo && prev.find((m) => m.id === replyTo.id);
      return appendCapped(prev, {
        type: 'chat',
        id: typeof data.id === 'string' ? data.id.slice(0, 64) : crypto.randomUUID(),
        sender,
        isHost: room.isPeerHost(from),
        text: text.slice(0, MAX_CHAT_TEXT),
        ...(replyTo
          ? { replyTo: quoted ? { id: quoted.id, sender: quoted.isSelf ? 'You' : quoted.sender, text: plainSnippet(quoted.text || (quoted.file ? `📎 ${quoted.file.name}` : '')) } : replyTo }
          : {}),
        ...(mentions.length ? { mentions } : {}),
        ...(mentionsMe ? { mentionsMe } : {}),
        timestamp: Number.isFinite(data.timestamp)
          ? Math.min(data.timestamp as number, Date.now() + 60000)
          : Date.now(),
        isSelf: false
      });
    });
    if (mentionsMe) {
      sound.playChime();
      room.notify(`💬 ${sender} mentioned you: ${plainSnippet(text, 80)}`);
    } else {
      sound.playPop();
    }
  });

  const sendMessage = useCallback(
    (text: string, extras: { replyTo?: ChatReplyRef | null; mentions?: string[] } = {}) => {
      const { username, isHost } = room.getSelf();
      const replyTo = extras.replyTo
        ? { id: extras.replyTo.id, sender: extras.replyTo.sender, text: plainSnippet(extras.replyTo.text) }
        : undefined;
      const mentions = (extras.mentions || []).slice(0, MAX_MENTIONS);
      const msg = {
        type: 'chat' as const,
        id: crypto.randomUUID(),
        sender: username,
        isHost,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(mentions.length ? { mentions } : {}),
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

  const { sendFile } = files;
  const sendImage = useCallback((file: File | Blob | null, caption = '') => sendFile(file, caption), [sendFile]);

  return {
    messages,
    unreadChatCount,
    sendMessage,
    sendImage,
    sendFile,
    acceptTransfer: files.acceptTransfer,
    pauseTransfer: files.pauseTransfer,
    resumeTransfer: files.resumeTransfer,
    cancelTransfer: files.cancelTransfer
  };
}
