/**
 * Chat messages as kept and shown (`useChat.ts`, `useFileTransfers.ts`, `LiveChat.tsx`), and the
 * small helpers that change them.
 */

import type { ChatReplyRef } from './chatFields';
import type { SendStatus } from './transferPeers';

export const MAX_MESSAGES = 300; // older ones are dropped (and their file memory freed)
export const MAX_CHAT_TEXT = 2000; // (the box allows 200; more from a peer is cut)

export interface ChatMessageTransfer {
  transferId: string;
  isTransferring: boolean;
  isPaused?: boolean;
  /** Cancelled (by us, by its sender, or because nobody was receiving it): nothing more comes. */
  isCancelled?: boolean;
  /** Theirs, big: it comes only once we accept it. */
  isOffered?: boolean;
  /** Ours, big: where it is with the receivers (waiting to accept, being sent, sent). */
  send?: SendStatus;
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

/** Where one file of a folder offered to us is. */
export type FolderFileState = 'offered' | 'receiving' | 'done' | 'cancelled';

export interface ChatFolderFile {
  transferId: string;
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  state: FolderFileState;
  percent: number;
  /** Once here: the file to save. */
  file?: ChatMessageFile;
}

/** A folder offered in chat (`p2p-folder-offer`, from the desktop app): pick the files to get. */
export interface ChatMessageFolder {
  folderId: string;
  name: string;
  files: ChatFolderFile[];
  isCancelled?: boolean;
}

export interface ChatMessage {
  type: 'chat';
  id: string;
  sender: string;
  isHost?: boolean;
  text: string;
  replyTo?: ChatReplyRef;
  /** Peer ids named with @Name */
  mentions?: string[];
  /** It mentions us */
  mentionsMe?: boolean;
  timestamp: number;
  isSelf: boolean;
  transferId?: string;
  image?: ChatMessageFile;
  file?: ChatMessageFile;
  imageTransfer?: ChatMessageTransfer | null;
  folder?: ChatMessageFolder;
}

const revoke = (url: string | undefined) => {
  if (url?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already gone */
    }
  }
};

/** Frees a message's file memory (object URLs). */
export const releaseMessage = (m: ChatMessage): void => {
  revoke(m.file?.url || m.image?.url);
  for (const f of m.folder?.files || []) revoke(f.file?.url);
};

/** Appends and keeps the list bounded. */
export const appendCapped = (prev: ChatMessage[], item: ChatMessage): ChatMessage[] => {
  const next = prev.concat([item]);
  if (next.length <= MAX_MESSAGES) return next;
  const dropped = next.splice(0, next.length - MAX_MESSAGES);
  for (const m of dropped) releaseMessage(m);
  return next;
};

/** Changes a transfer's card (`imageTransfer`) or, for a folder's file, its row. */
export const patchTransfer =
  (transferId: string, patch: Partial<ChatMessageTransfer>, folderPatch: Partial<ChatFolderFile> = {}) =>
  (prev: ChatMessage[]): ChatMessage[] =>
    prev.map((m) => {
      if (m.transferId === transferId && m.imageTransfer) {
        return { ...m, imageTransfer: { ...m.imageTransfer, ...patch } };
      }
      if (m.folder && m.folder.files.some((f) => f.transferId === transferId)) {
        return {
          ...m,
          folder: {
            ...m.folder,
            files: m.folder.files.map((f) => (f.transferId === transferId ? { ...f, ...folderPatch } : f))
          }
        };
      }
      return m;
    });

export const setTransferPercent = (transferId: string, percent: number, isPaused = false) =>
  patchTransfer(transferId, { percent, isPaused }, { percent });

export const setTransferCancelled = (transferId: string) =>
  patchTransfer(
    transferId,
    { isTransferring: false, isPaused: false, isOffered: false, isCancelled: true },
    { state: 'cancelled' }
  );

/** A folder offered to us was withdrawn: every file not here yet is cancelled. */
export const setFolderCancelled =
  (folderId: string) =>
  (prev: ChatMessage[]): ChatMessage[] =>
    prev.map((m) =>
      m.folder?.folderId === folderId
        ? {
            ...m,
            folder: {
              ...m.folder,
              isCancelled: true,
              files: m.folder.files.map((f) => (f.state === 'done' ? f : { ...f, state: 'cancelled' as const }))
            }
          }
        : m
    );

/** "1 person", "3 people". */
export const people = (n: number): string => (n === 1 ? '1 person' : `${n} people`);

/** A file card's status line: offered, waiting for receivers, sending, receiving, cancelled. */
export function transferStatusText(t: ChatMessageTransfer, isSelf: boolean, size: string): string {
  if (t.isCancelled) return `✕ Cancelled (${size})`;
  if (t.isOffered) return `${size} • accept to download`;
  const percent = t.percent || 0;
  if (isSelf && t.send) {
    if (t.send.sending === 0) return `Waiting for ${people(t.send.waiting)} to accept (${size})`;
    const waiting = t.send.waiting > 0 ? `, ${t.send.waiting} waiting` : '';
    return `Sending to ${people(t.send.sending)} • ${percent}%${waiting} (${size})`;
  }
  if (t.isPaused) return '⏸️ Paused';
  return `${isSelf ? 'Sending' : 'Receiving'} • ${percent}% (${size})`;
}
