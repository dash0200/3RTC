/**
 * Keeps the tab's title (and a dot on its icon) up to date with the room: see utils/tabTitle.ts
 * for what it says when. Renders nothing.
 *
 * Away from the tab (another tab, or another window on top, like a game): messages are counted,
 * "your turn" blinks in the title, and the tab's icon gets a red dot until you're back.
 * Who's talking comes from the voice loop's speaking store (not React state at the top), with a
 * short hold so the title doesn't flicker between words.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { speakingActivity } from '../utils/speakingActivity';
import { composeTitle, type TitleInput } from '../utils/tabTitle';
import type { ChatMessage } from '../features/chat/useChat';

const TALK_HOLD_MS = 1500;
const TALK_TICK_MS = 400;
const BLINK_MS = 1100;

export interface TabTitlePeer {
  peerId?: string | null;
  id?: string;
  username: string;
  isMuted?: boolean;
  isLocalMuted?: boolean;
}

export interface TabTitleProps {
  roomId: string | null;
  peers: TabTitlePeer[];
  reconnecting: boolean;
  game: TitleInput['game'];
  invite: TitleInput['invite'];
  nowPlaying: string;
  messages: ChatMessage[];
}

/** You're somewhere else: the tab is hidden, or another window has the focus */
function useAway(): boolean {
  const read = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus());
  const [away, setAway] = useState(read);
  useEffect(() => {
    const update = () => setAway(read());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);
  return away;
}

/** Names of the people talking now (held a moment after they stop) */
function useTalking(peers: TabTitlePeer[]): string[] {
  const lastSpoke = useRef<Record<string, number>>({});
  const [talking, setTalking] = useState<string[]>([]);
  const peersRef = useRef(peers);
  peersRef.current = peers;
  useEffect(() => {
    const note = () => {
      const now = Date.now();
      for (const [id, s] of Object.entries(speakingActivity.get().peers)) if (s.isSpeaking) lastSpoke.current[id] = now;
    };
    note();
    const unsubscribe = speakingActivity.subscribe(note);
    const tick = setInterval(() => {
      const now = Date.now();
      const names = peersRef.current
        .filter((p) => !p.isMuted && !p.isLocalMuted)
        .filter((p) => now - (lastSpoke.current[(p.peerId || p.id) as string] || 0) < TALK_HOLD_MS)
        .map((p) => p.username);
      setTalking((prev) => (prev.join('\n') === names.join('\n') ? prev : names));
    }, TALK_TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, []);
  return talking;
}

/** The tab's icon with a red dot (or back to the plain one) */
function useIconDot(on: boolean): void {
  const original = useRef<string | null>(null);
  const dotted = useRef<string | null>(null);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return undefined;
    if (original.current === null) original.current = link.getAttribute('href');
    if (!on) {
      if (original.current) link.setAttribute('href', original.current);
      return undefined;
    }
    if (dotted.current) {
      link.href = dotted.current;
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 64, 64);
        ctx.beginPath();
        ctx.arc(48, 16, 14, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3b4e';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        dotted.current = c.toDataURL('image/png');
        link.href = dotted.current;
      } catch {
        /* no canvas: the title still says it */
      }
    };
    img.src = original.current || '/favicon.svg';
    return () => {
      cancelled = true;
    };
  }, [on]);
}

export default function TabTitle({ roomId, peers, reconnecting, game, invite, nowPlaying, messages }: TabTitleProps) {
  const away = useAway();
  const talking = useTalking(peers);

  // Messages from the others since you went away (none while you're here)
  const seenRef = useRef(messages.length);
  if (!away) seenRef.current = messages.length;
  useEffect(() => {
    if (!roomId) seenRef.current = 0;
  }, [roomId]);
  const fresh = away ? messages.slice(seenRef.current).filter((m) => !m.isSelf) : [];
  const last = fresh[fresh.length - 1];

  const others = useMemo(() => peers.map((p) => p.username), [peers]);
  const input: TitleInput = {
    roomId,
    others,
    reconnecting,
    game,
    invite,
    talking,
    nowPlaying,
    unread: fresh.length,
    lastMessage: last ? { name: last.sender, text: last.text || (last.image ? '📷 photo' : '') } : null
  };
  const title = composeTitle(input);
  const yourTurn = Boolean(away && game?.attention);

  // Your turn while you're away: blink, so it catches the eye in a row of tabs
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!yourTurn) {
      setBlink(false);
      return undefined;
    }
    const t = setInterval(() => setBlink((b) => !b), BLINK_MS);
    return () => clearInterval(t);
  }, [yourTurn]);

  const defaultTitle = useRef<string | null>(null);
  useEffect(() => {
    if (defaultTitle.current === null) defaultTitle.current = document.title;
    const shown = title && blink && yourTurn ? `🔔 ${(game?.label || 'Your turn').toUpperCase()} — ${game?.name}` : title;
    document.title = shown || defaultTitle.current || document.title;
  }, [title, blink, yourTurn, game?.label, game?.name]);
  useEffect(() => () => {
    if (defaultTitle.current) document.title = defaultTitle.current;
  }, []);

  useIconDot(Boolean(roomId && away && (game?.attention || fresh.length > 0)));
  return null;
}
