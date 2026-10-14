/**
 * Floating emoji reactions over the video, keys 1-6 or the buttons.
 *
 * Spam-safe by design:
 * - sending: at most ~8 a second per person (holding a key streams at that rate)
 * - receiving: each person is limited to ~10 a second (token bucket), whatever their app sends
 * - sound: at most one pop every 70 ms in total, pitch rising with a combo
 * - display: animated outside React (reactionFeed + FloatingReactions), so bursts don't
 *   re-render the app; the layer caps how many are on screen
 *
 * Wire: 'reaction' { id, emoji, lane, combo } (older apps also send driftVariant/scale/rot, ignored).
 */
import { useCallback, useEffect, useRef } from 'react';
import { sound } from '../../utils/sound';
import { usePeerMessageOn } from '../../core/RoomContext';
import { createReactionFeed } from './reactionFeed';
import { LIVE_REACTIONS } from '../../components/FloatingReactions';

const SEND_GAP_MS = 115;          // ~8.7 per second while holding a key
const COMBO_WINDOW_MS = 1200;     // same emoji again within this: the combo grows
const BUCKET_SIZE = 10;           // incoming: burst allowance per person
const BUCKET_REFILL_PER_S = 10;   // incoming: sustained rate per person
const SOUND_GAP_MS = 70;
const ALLOWED = new Set(LIVE_REACTIONS.map((r) => r.emoji));

const isTypingTarget = (el) => {
    const tag = el?.tagName?.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable;
};

export function useReactions({ room, isAudioBlockedRef, inRoom }) {
    const { bus } = room;
    const feedRef = useRef(null);
    if (!feedRef.current) feedRef.current = createReactionFeed();
    const feed = feedRef.current;

    const lastSentRef = useRef(0);
    const myComboRef = useRef({ emoji: null, at: 0, n: 0 });
    const peerComboRef = useRef(new Map());   // peerId -> { emoji, at, n }
    const bucketsRef = useRef(new Map());     // peerId -> { tokens, at }
    const lastSoundRef = useRef(0);

    const pop = useCallback((combo, isSelf) => {
        if (isAudioBlockedRef.current) return;
        const now = performance.now();
        if (now - lastSoundRef.current < SOUND_GAP_MS) return;
        lastSoundRef.current = now;
        sound.playReactionPop({ pitch: 1 + Math.min(combo - 1, 12) * 0.06, volume: isSelf ? 1 : 0.8 });
    }, [isAudioBlockedRef]);

    const nextCombo = (state, emoji, now) => {
        if (state.emoji === emoji && now - state.at < COMBO_WINDOW_MS) state.n += 1;
        else state.n = 1;
        state.emoji = emoji;
        state.at = now;
        return state.n;
    };

    usePeerMessageOn(bus, 'reaction', (data, from) => {
        if (!data || !ALLOWED.has(data.emoji)) return;
        // token bucket per person: a flood is cut down to a steady trickle
        const now = performance.now();
        const bucket = bucketsRef.current.get(from) || { tokens: BUCKET_SIZE, at: now };
        bucket.tokens = Math.min(BUCKET_SIZE, bucket.tokens + ((now - bucket.at) / 1000) * BUCKET_REFILL_PER_S);
        bucket.at = now;
        bucketsRef.current.set(from, bucket);
        if (bucket.tokens < 1) return;
        bucket.tokens -= 1;

        if (!peerComboRef.current.has(from)) peerComboRef.current.set(from, { emoji: null, at: 0, n: 0 });
        const derived = nextCombo(peerComboRef.current.get(from), data.emoji, now);
        const combo = Number.isInteger(data.combo) && data.combo > 0 ? Math.min(data.combo, 999) : derived;
        pop(combo, false);
        feed.emit({
            id: typeof data.id === 'string' ? data.id.slice(0, 40) : crypto.randomUUID(),
            emoji: data.emoji,
            sender: String(data.sender || 'Peer').slice(0, 24),
            isSelf: false,
            lane: typeof data.lane === 'number' ? Math.max(10, Math.min(90, data.lane)) : 20 + Math.random() * 60,
            combo,
            peerKey: from
        });
    });

    /** Returns the combo count (1 = first of a burst), or 0 when dropped by the rate limit. */
    const sendReaction = useCallback((emoji) => {
        if (!ALLOWED.has(emoji)) return 0;
        const now = performance.now();
        if (now - lastSentRef.current < SEND_GAP_MS) return 0;
        lastSentRef.current = now;
        const combo = nextCombo(myComboRef.current, emoji, now);
        const item = { id: crypto.randomUUID(), emoji, lane: 20 + Math.random() * 60, combo };
        pop(combo, true);
        try {
            if (window.matchMedia('(hover: none)').matches) navigator.vibrate?.(8);
        } catch { /* no haptics */ }
        feed.emit({ ...item, sender: room.getSelf().username, isSelf: true, peerKey: 'self' });
        bus.broadcast('reaction', item);
        return combo;
    }, [bus, feed, pop, room]);

    // Keys 1-6 (holding one streams reactions at the send rate)
    useEffect(() => {
        if (!inRoom) return undefined;
        const onKey = (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(document.activeElement)) return;
            const match = LIVE_REACTIONS.find((r) => r.key === e.key);
            if (!match) return;
            e.preventDefault();
            sendReaction(match.emoji);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [inRoom, sendReaction]);

    useEffect(() => bus.onEvent('peer-close', (peerId) => {
        bucketsRef.current.delete(peerId);
        peerComboRef.current.delete(peerId);
    }), [bus]);

    return { reactionFeed: feed, sendReaction };
}
