import React, { memo, useMemo } from 'react';
import { formatChat, type ChatNode, type MentionTarget } from '../../utils/chatFormat';
import { splitTimestamps } from '../../utils/chatTimestamps';

/**
 * A chat message's text with its formatting (utils/chatFormat.ts): bold, italic, struck, `code`,
 * links (new tab), @mentions, and video timestamps that jump everyone there while a video is loaded.
 * Memoized: formatted once per message, not on every chat render.
 */
function renderTimestamps(text: string, onSeekTo: ((sec: number) => void) | undefined, keyBase: string) {
  if (!onSeekTo) return text;
  const parts = splitTimestamps(text);
  if (parts.length === 1 && parts[0].seconds === undefined) return text;
  return parts.map((part, idx) =>
    part.seconds === undefined ? (
      <React.Fragment key={`${keyBase}-${idx}`}>{part.text}</React.Fragment>
    ) : (
      <button
        key={`${keyBase}-${idx}`}
        type="button"
        className="chat-timestamp"
        onClick={() => onSeekTo(part.seconds!)}
        title={`Jump everyone to ${part.text}`}
      >
        {part.text}
      </button>
    )
  );
}

function renderNodes(nodes: ChatNode[], onSeekTo: ((sec: number) => void) | undefined, path: string): React.ReactNode[] {
  return nodes.map((n, idx) => {
    const key = `${path}.${idx}`;
    switch (n.t) {
      case 'text':
        return <React.Fragment key={key}>{renderTimestamps(n.v, onSeekTo, key)}</React.Fragment>;
      case 'code':
        return <code key={key} className="chat-code">{n.v}</code>;
      case 'link':
        return (
          <a key={key} className="chat-link" href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {n.v}
          </a>
        );
      case 'mention':
        return <span key={key} className={`chat-mention ${n.self ? 'is-me' : ''}`}>{n.v}</span>;
      case 'b':
        return <strong key={key}>{renderNodes(n.c, onSeekTo, key)}</strong>;
      case 'i':
        return <em key={key}>{renderNodes(n.c, onSeekTo, key)}</em>;
      case 's':
        return <s key={key}>{renderNodes(n.c, onSeekTo, key)}</s>;
      default:
        return null;
    }
  });
}

export interface RichTextProps {
  text: string;
  /** Who can be @mentioned (names in the room); keep the array stable between renders */
  targets: MentionTarget[];
  onSeekTo?: (seconds: number) => void;
}

function RichTextImpl({ text, targets, onSeekTo }: RichTextProps) {
  const nodes = useMemo(() => formatChat(text, targets), [text, targets]);
  return <>{renderNodes(nodes, onSeekTo, 'n')}</>;
}

export const RichText = memo(RichTextImpl);
