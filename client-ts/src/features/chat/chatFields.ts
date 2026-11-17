/**
 * The rich-chat fields of a 'chat' message from a peer (pure, for tests): kept only if well formed,
 * and cut to size (features/chat/useChat.ts).
 */
import { MAX_MENTIONS, REPLY_SNIPPET_CHARS, plainSnippet } from '../../utils/chatFormat';

/** The message a reply quotes. */
export interface ChatReplyRef {
  id: string;
  sender: string;
  text: string;
}

/** A `replyTo` from a peer, kept only if well formed, and cut to size. */
export function cleanReplyRef(raw: unknown): ChatReplyRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 64) return undefined;
  return {
    id: r.id,
    sender: typeof r.sender === 'string' ? r.sender.slice(0, 40) : '',
    text: typeof r.text === 'string' ? plainSnippet(r.text, REPLY_SNIPPET_CHARS) : ''
  };
}

/** `mentions` from a peer: at most MAX_MENTIONS short strings. */
export function cleanMentions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === 'string' && m.length > 0 && m.length <= 64).slice(0, MAX_MENTIONS);
}
