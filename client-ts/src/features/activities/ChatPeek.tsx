/**
 * New chat messages shown over an activity for a few seconds, like comments on a live stream,
 * for when the chat list itself isn't in view (phones, chat panel closed, full screen).
 * Tapping one opens the chat. Only messages that arrive while it is shown, never your own.
 */
import { useEffect, useRef, useState } from 'react';

const SHOW_MS = 7000;
const MAX_SHOWN = 3;

export interface ChatPeekMessage {
    id: string | number;
    text?: string;
    image?: { url?: string } | boolean | string | null;
    imageTransfer?: { fileName?: string } | boolean | null;
    isSelf?: boolean;
    sender?: string;
}

export interface ChatPeekProps {
    messages: ChatPeekMessage[];
    onOpenChat: () => void;
}

interface ShownItem {
    id: string | number;
    sender: string;
    text: string;
    until: number;
}

const preview = (m: ChatPeekMessage): string => {
    const text = (m.text || '').trim();
    if (m.image || m.imageTransfer) return text ? `📷 ${text}` : '📷 Photo';
    return text;
};

export default function ChatPeek({ messages, onOpenChat }: ChatPeekProps) {
    const [shown, setShown] = useState<ShownItem[]>([]);
    const seenRef = useRef<Set<string | number> | null>(null);

    useEffect(() => {
        const ids = new Set(messages.map((m) => m.id));
        if (seenRef.current === null) {
            seenRef.current = ids; // what was there before: not new
            return;
        }
        const fresh = messages.filter((m) => !seenRef.current?.has(m.id) && !m.isSelf && preview(m));
        seenRef.current = ids;
        if (!fresh.length) return;
        const now = Date.now();
        setShown((prev) => [...prev, ...fresh.map((m) => ({ id: m.id, sender: m.sender || 'Someone', text: preview(m), until: now + SHOW_MS }))].slice(-MAX_SHOWN));
    }, [messages]);

    // Drop each one when its time is up
    useEffect(() => {
        if (!shown.length) return undefined;
        const next = Math.min(...shown.map((s) => s.until)) - Date.now();
        const timer = setTimeout(() => setShown((prev) => prev.filter((s) => s.until > Date.now())), Math.max(0, next) + 30);
        return () => clearTimeout(timer);
    }, [shown]);

    if (!shown.length) return null;
    return (
        <div className="chat-peek" aria-live="polite">
            {shown.map((s) => (
                <button key={s.id} type="button" className="chat-peek-item" onClick={onOpenChat} title="Open chat">
                    <span className="chat-peek-name">{s.sender}</span>
                    <span className="chat-peek-text">{s.text}</span>
                </button>
            ))}
        </div>
    );
}
