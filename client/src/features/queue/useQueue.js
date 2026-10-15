/**
 * Shared watch queue and vote-to-skip. Everyone can add; playing from the queue follows the host
 * controls lock; a passed skip vote is the room deciding, so it goes through the lock.
 * An item is a YouTube video { videoId } or a link source { media } (features/media/sources.js).
 *
 * Wire: 'queue-action' { action: add | remove | reorder | clear | play-item | next | vote-skip | vote-skip-passed, ... }
 * Listens to 'media-changed' (clears skip votes) and 'room-left'.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { sound } from '../../utils/sound';
import { fetchYouTubeTitle } from '../../components/YouTubeSyncPlayer';
import { usePeerMessageOn } from '../../core/RoomContext';
import { normalizeMedia, fallbackTitle } from '../media/sources';

// A queue item from someone else: a YouTube video or a link source (checked), else dropped
const cleanItem = (item) => {
    if (!item || typeof item.id !== 'string') return null;
    if (item.media) {
        const media = normalizeMedia(item.media);
        return media ? { ...item, media, videoId: undefined } : null;
    }
    return typeof item.videoId === 'string' ? item : null;
};
const cleanQueue = (list) => list.map(cleanItem).filter(Boolean);

export function useQueue({ room, playback, hostControls, peerCount }) {
    const { bus } = room;
    const [queue, setQueueState] = useState([]);
    const [skipVotes, setSkipVotesState] = useState([]);
    const queueRef = useRef([]);
    const skipVotesRef = useRef([]);

    // Keep the refs in step with state, for handlers that run outside React (messages, timers)
    const setQueue = useCallback((next) => {
        setQueueState((prev) => {
            const value = typeof next === 'function' ? next(prev) : next;
            queueRef.current = value;
            return value;
        });
    }, []);
    const setSkipVotes = useCallback((value) => {
        skipVotesRef.current = value;
        setSkipVotesState(value);
    }, []);

    const send = useCallback((action, payload = {}) => bus.broadcast('queue-action', { action, ...payload }), [bus]);

    useEffect(() => {
        const offMedia = bus.onEvent('media-changed', () => setSkipVotes([]));
        const offLeft = bus.onEvent('room-left', () => {
            setQueue([]);
            setSkipVotes([]);
        });
        return () => {
            offMedia();
            offLeft();
        };
    }, [bus, setQueue, setSkipVotes]);

    usePeerMessageOn(bus, 'queue-action', (data) => {
        const who = data.sender || 'Peer';
        switch (data.action) {
            case 'add': {
                const item = cleanItem(data.item);
                if (!item) break;
                setQueue((prev) => (prev.some((q) => q.id === item.id) ? prev : [...prev, item]));
                room.log(`📑 ${who} queued: "${item.title}"`);
                room.notify(`📑 ${who} added to queue`);
                break;
            }
            case 'remove': {
                if (!data.itemId) break;
                const removed = queueRef.current.find((q) => q.id === data.itemId);
                setQueue((prev) => prev.filter((q) => q.id !== data.itemId));
                if (removed) room.log(`🗑️ ${who} removed "${removed.title}" from queue`);
                break;
            }
            case 'reorder':
                if (Array.isArray(data.queue)) setQueue(cleanQueue(data.queue));
                break;
            case 'clear':
                setQueue([]);
                room.log(`🗑️ ${who} cleared the queue`);
                break;
            case 'play-item':
                if (data.itemId) {
                    setQueue((prev) => prev.filter((q) => q.id !== data.itemId));
                    setSkipVotes([]);
                }
                break;
            case 'next':
                if (Array.isArray(data.remainingQueue)) setQueue(cleanQueue(data.remainingQueue));
                else if (data.nextVideoId) setQueue((prev) => prev.filter((q) => q.videoId !== data.nextVideoId));
                setSkipVotes([]);
                if (data.nextTitle) {
                    playback.setActiveVideoTitle(data.nextTitle);
                    room.log(`⏭️ Now playing next queued: "${data.nextTitle}"`);
                }
                break;
            case 'vote-skip':
                if (Array.isArray(data.skipVotes)) setSkipVotes(data.skipVotes);
                break;
            case 'vote-skip-passed':
                setSkipVotes([]);
                room.log('⏭️ Skip vote passed by consensus');
                break;
            default:
                break;
        }
    });

    // autoplay: with nothing playing, the first video added starts right away. Quick Watch passes
    // false so several videos can be lined up first (then "Play queue").
    const addToQueue = useCallback(async ({ videoId, media, title }, { autoplay = true } = {}) => {
        const cleanMedia = media ? normalizeMedia({ ...media, title: title || media.title }) : null;
        if (!videoId && !cleanMedia) return;
        const finalTitle = cleanMedia ? (cleanMedia.title || fallbackTitle(cleanMedia)) : (title || await fetchYouTubeTitle(videoId));
        const nothingPlaying = !playback.activeVideoIdRef.current && !playback.activeMediaRef.current && !playback.localVideoFile && !playback.remoteLocalVideoMeta;
        if (autoplay && nothingPlaying) {
            if (cleanMedia) playback.playLink(cleanMedia);
            else playback.playYouTube(videoId, finalTitle);
            room.notify(`▶️ Now playing: "${finalTitle}"`);
            room.log(`🎬 Now playing: "${finalTitle}"`);
            return;
        }
        const item = cleanMedia
            ? { id: crypto.randomUUID(), media: cleanMedia, title: finalTitle, addedBy: room.getSelf().username, timestamp: Date.now() }
            : { id: crypto.randomUUID(), videoId, title: finalTitle, addedBy: room.getSelf().username, timestamp: Date.now() };
        setQueue((prev) => [...prev, item]);
        send('add', { item });
        room.notify(`📑 Added to queue: "${finalTitle}"`);
        room.log(`📑 You added "${finalTitle}" to the watch queue`);
    }, [playback, room, send, setQueue]);

    const removeFromQueue = useCallback((itemId) => {
        const removed = queueRef.current.find((item) => item.id === itemId);
        setQueue((prev) => prev.filter((item) => item.id !== itemId));
        if (removed) {
            room.log(`🗑️ You removed "${removed.title}" from queue`);
            room.notify('Removed from queue');
        }
        send('remove', { itemId });
    }, [room, send, setQueue]);

    const reorderQueue = useCallback((newQueue) => {
        setQueue(newQueue);
        send('reorder', { queue: newQueue });
    }, [send, setQueue]);

    const clearQueue = useCallback(() => {
        setQueue([]);
        send('clear');
        room.notify('Queue cleared');
        room.log('🗑️ You cleared the queue');
    }, [room, send, setQueue]);

    const playQueueItem = useCallback((itemId) => {
        const item = queueRef.current.find((q) => q.id === itemId);
        if (!item) return;
        if (hostControls.isLockedForMe()) {
            hostControls.onBlocked();
            return;
        }
        setQueue((prev) => prev.filter((q) => q.id !== itemId));
        if (item.media) playback.playLink(item.media);
        else playback.playYouTube(item.videoId, item.title);
        send('play-item', { itemId });
        room.notify(`▶️ Now playing from queue: "${item.title}"`);
        room.log(`🎬 Playing queued video: "${item.title}"`);
    }, [hostControls, playback, room, send, setQueue]);

    // byVote: a passed vote-skip is the room deciding, so it goes through the host controls lock
    // auto: the video ended or failed on this device; with the lock on, the host's app moves on
    const playNextInQueue = useCallback(({ byVote = false, auto = false } = {}) => {
        if (hostControls.isLockedForMe() && !byVote) {
            if (!auto) hostControls.onBlocked();
            return;
        }
        const [nextItem, ...remaining] = queueRef.current;
        if (!nextItem) {
            room.notify('Queue is empty');
            return;
        }
        setQueue(remaining);
        if (nextItem.media) playback.playLink(nextItem.media, byVote ? { byVote: true } : {});
        else playback.playYouTube(nextItem.videoId, nextItem.title, byVote ? { byVote: true } : {});
        send('next', { nextVideoId: nextItem.videoId || null, nextTitle: nextItem.title, remainingQueue: remaining });
        sound.playPop();
        room.notify(`▶️ Next Up: "${nextItem.title}"`);
        room.log(`⏭️ Autoplaying next in queue: "${nextItem.title}"`);
    }, [hostControls, playback, room, send, setQueue]);

    const voteSkip = useCallback(() => {
        if (!playback.activeVideoIdRef.current && !playback.activeMediaRef.current) return;
        const { username } = room.getSelf();
        const current = skipVotesRef.current;
        const alreadyVoted = current.includes(username);
        const updated = alreadyVoted ? current.filter((u) => u !== username) : [...current, username];
        setSkipVotes(updated);
        const required = Math.max(1, Math.ceil(Math.max(1, peerCount || 1) / 2));
        send('vote-skip', { skipVotes: updated });

        if (updated.length < required) {
            room.notify(alreadyVoted ? 'Removed skip vote' : `Voted to skip (${updated.length}/${required})`);
            return;
        }
        room.notify(`⏭️ Vote skip passed (${updated.length}/${required})!`);
        room.log(`⏭️ Vote skip passed (${updated.length}/${required} votes). Skipping video...`);
        setSkipVotes([]);
        send('vote-skip-passed');
        if (queueRef.current.length > 0) {
            playNextInQueue({ byVote: true });
        } else {
            playback.closeByVote();
            room.log('🎬 Queue ended. Exited video player.');
        }
    }, [peerCount, playback, playNextInQueue, room, send, setSkipVotes]);

    return {
        queue, skipVotes, queueRef, skipVotesRef, setQueue, setSkipVotes,
        addToQueue, removeFromQueue, reorderQueue, clearQueue, playQueueItem, playNextInQueue, voteSkip
    };
}
