/**
 * Floating emoji reactions over the video. Wire message: 'reaction' { id, emoji, lane, driftVariant, scale, rot }.
 */
import { useState, useCallback } from 'react';
import { sound } from '../../utils/sound';
import { usePeerMessageOn } from '../../core/RoomContext';

const MAX_ON_SCREEN = 25;
const FLOAT_MS = 2600;

export function useReactions({ room, isAudioBlockedRef }) {
    const { bus } = room;
    const [floatingReactions, setFloatingReactions] = useState([]);

    const show = useCallback((item) => {
        setFloatingReactions((prev) => [...prev.slice(-MAX_ON_SCREEN), item]);
        setTimeout(() => setFloatingReactions((prev) => prev.filter((r) => r.id !== item.id)), FLOAT_MS);
    }, []);

    usePeerMessageOn(bus, 'reaction', (data) => {
        if (!data?.emoji) return;
        if (!isAudioBlockedRef.current) sound.playReactionPop();
        show({
            id: data.id || crypto.randomUUID(),
            emoji: data.emoji,
            sender: data.sender || 'Peer',
            isSelf: false,
            lane: typeof data.lane === 'number' ? data.lane : (20 + Math.random() * 60),
            driftVariant: data.driftVariant || Math.floor(1 + Math.random() * 4),
            scale: data.scale || (1.05 + Math.random() * 0.35),
            rot: typeof data.rot === 'number' ? data.rot : ((Math.random() - 0.5) * 30),
            createdAt: Date.now()
        });
    });

    const sendReaction = useCallback((emoji) => {
        if (!emoji) return;
        const look = {
            id: crypto.randomUUID(),
            emoji,
            lane: 20 + Math.random() * 60,
            driftVariant: Math.floor(1 + Math.random() * 4),
            scale: 1.05 + Math.random() * 0.35,
            rot: (Math.random() - 0.5) * 30
        };
        sound.playReactionPop();
        show({ ...look, sender: room.getSelf().username, isSelf: true, createdAt: Date.now() });
        bus.broadcast('reaction', look);
    }, [bus, room, show]);

    return { floatingReactions, sendReaction };
}
