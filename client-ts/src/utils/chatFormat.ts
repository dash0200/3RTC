/**
 * Rich chat text (pure, for tests): simple markdown, links and @mentions, as a tree the chat turns
 * into React elements (never HTML, so nothing in a message can inject markup).
 *
 *   `code`            code (nothing inside is formatted)
 *   **bold**  *italic*  _italic_  ~~struck~~
 *   https://… www.…   links (utils/chatLinks)
 *   @Name             a mention of someone in the room (by display name)
 *
 * The same rules are in the desktop app (`crates/core/src/chat_format.rs`).
 */
import { splitLinks } from './chatLinks';

export type ChatNode =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'mention'; v: string; peerId: string; self: boolean }
  | { t: 'b' | 'i' | 's'; c: ChatNode[] };

export interface MentionTarget {
  peerId: string;
  name: string;
  self?: boolean;
}

const CODE_RE = /`([^`\n]+)`/g;

// Emphasis: the marker must touch the text it wraps (so "2 * 3 * 4" stays plain). `_` only between
// non-word characters (so snake_case stays plain).
const EMPHASIS: Array<{ t: 'b' | 'i' | 's'; re: RegExp }> = [
  { t: 'b', re: /\*\*(?=\S)([\s\S]*?\S)\*\*/ },
  { t: 's', re: /~~(?=\S)([\s\S]*?\S)~~/ },
  { t: 'i', re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*/ },
  { t: 'i', re: /(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u }
];

const MAX_DEPTH = 4;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @Name pieces of plain text (longest names first, so "@Sai Kumar" beats "@Sai"). */
function splitMentions(text: string, targets: MentionTarget[]): ChatNode[] {
  const named = targets.filter((p) => p.name.trim());
  if (!named.length || !text.includes('@')) return text ? [{ t: 'text', v: text }] : [];
  const sorted = [...named].sort((a, b) => b.name.length - a.name.length);
  const re = new RegExp(`@(${sorted.map((p) => escapeRe(p.name.trim())).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  const out: ChatNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    // "@" must start a word (not an email address)
    if (at > 0 && /[\p{L}\p{N}_]/u.test(text[at - 1])) continue;
    const who = sorted.find((p) => p.name.trim().toLowerCase() === m[1].toLowerCase());
    if (!who) continue;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    out.push({ t: 'mention', v: m[0], peerId: who.peerId, self: Boolean(who.self) });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

function parseEmphasis(text: string, targets: MentionTarget[], depth: number): ChatNode[] {
  if (!text) return [];
  if (depth < MAX_DEPTH) {
    let best: { t: 'b' | 'i' | 's'; m: RegExpExecArray } | null = null;
    for (const e of EMPHASIS) {
      const m = e.re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { t: e.t, m };
    }
    if (best) {
      const { m, t } = best;
      return [
        ...splitMentions(text.slice(0, m.index), targets),
        { t, c: parseEmphasis(m[1], targets, depth + 1) },
        ...parseEmphasis(text.slice(m.index + m[0].length), targets, depth)
      ];
    }
  }
  return splitMentions(text, targets);
}

/** The formatted tree of a chat message. */
export function formatChat(text: string | null | undefined, targets: MentionTarget[] = []): ChatNode[] {
  const s = String(text ?? '');
  const out: ChatNode[] = [];
  const rest = (piece: string) => {
    for (const part of splitLinks(piece)) {
      if (part.href) out.push({ t: 'link', v: part.text, href: part.href });
      else out.push(...parseEmphasis(part.text, targets, 0));
    }
  };
  let last = 0;
  for (const m of s.matchAll(CODE_RE)) {
    if (m.index! > last) rest(s.slice(last, m.index));
    out.push({ t: 'code', v: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) rest(s.slice(last));
  return out;
}

/** The peers a message mentions (by @Name), for the `mentions` field. */
export function mentionedPeerIds(text: string, targets: MentionTarget[]): string[] {
  const ids = new Set<string>();
  const walk = (nodes: ChatNode[]) => {
    for (const n of nodes) {
      if (n.t === 'mention') ids.add(n.peerId);
      else if (n.t === 'b' || n.t === 'i' || n.t === 's') walk(n.c);
    }
  };
  walk(formatChat(text, targets));
  return [...ids].slice(0, MAX_MENTIONS);
}

/** Plain text of a message for a reply quote or a notification: markers dropped, one line, cut. */
export function plainSnippet(text: string, max = REPLY_SNIPPET_CHARS): string {
  const flat = (nodes: ChatNode[]): string =>
    nodes.map((n) => ('c' in n ? flat(n.c) : n.v)).join('');
  const one = flat(formatChat(text)).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The @word being typed at the caret ("@Sa|" -> "Sa"), or null. */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([\p{L}\p{N}_ .'-]{0,24})$/u.exec(before);
  if (!m) return null;
  const query = m[1];
  if (/\s{2}/.test(query) || query.startsWith(' ')) return null;
  return { query, start: caret - query.length - 1 };
}

export const MAX_MENTIONS = 10;
export const REPLY_SNIPPET_CHARS = 140;
