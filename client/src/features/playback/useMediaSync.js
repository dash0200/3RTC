/**
 * Catching up: when a channel to a peer opens we ask what they are watching ('yt-request-sync'),
 * and answer the same question from others with our player's position, the queue and skip votes.
 * The host controls lock also uses it: a guest whose change was blocked asks the host and is put
 * back to the host's state.
 *
 * Wire: 'yt-request-sync' -> 'yt-sync-state' { videoId, currentTime, isPlaying, queue, skipVotes,
 * activeVideoTitle } | { nothingPlaying: true }, or 'local-video-sync-state' { fileName, fileSize, ... }.
 */
import { useEffect } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';

export function useMediaSync({ room, playback, queue, hostControls }) {
    const { bus } = room;

    useEffect(() => bus.onEvent('peer-open', (peerId) => bus.send(peerId, 'yt-request-sync', {})), [bus]);

    usePeerMessageOn(bus, 'yt-request-sync', (_data, from) => {
        const state = playback.syncStateGetterRef.current?.();
        if (state?.mediaType === 'local' && state.fileName) {
            bus.send(from, 'local-video-sync-state', { ...state });
            return;
        }
        if (state?.videoId) {
            bus.send(from, 'yt-sync-state', {
                ...state,
                queue: queue.queueRef.current,
                skipVotes: queue.skipVotesRef.current,
                activeVideoTitle: playback.activeVideoTitleRef.current
            });
            return;
        }
        const file = playback.localVideoFileRef.current;
        if (file) {
            bus.send(from, 'local-video-sync-state', { mediaType: 'local', fileName: file.name, fileSize: file.size, currentTime: 0, isPlaying: false });
            return;
        }
        // Nothing playing here (lets a guest under the host controls lock drop what it opened)
        bus.send(from, 'yt-sync-state', { videoId: null, nothingPlaying: true });
    });

    usePeerMessageOn(bus, 'yt-sync-state', (data) => {
        const isLockRevert = hostControls.consumeLockRevert();
        if (data.nothingPlaying) {
            // Host controls lock: we opened something the host doesn't have, so close it
            if (isLockRevert) playback.closeAllQuietly();
            return;
        }
        if (!data.videoId) return;
        playback.setLocalVideoFile(null);
        playback.setRemoteLocalVideoMeta(null);
        playback.setActiveVideoId(data.videoId);
        if (data.activeVideoTitle) playback.setActiveVideoTitle(data.activeVideoTitle);
        if (Array.isArray(data.queue)) queue.setQueue(data.queue);
        if (Array.isArray(data.skipVotes)) queue.setSkipVotes(data.skipVotes);
        playback.setRemoteAction({ action: data.isPlaying ? 'play' : 'pause', currentTime: data.currentTime, newVideoId: data.videoId });
        room.log('🔄 Synced YouTube playback & queue with room');
    });

    usePeerMessageOn(bus, 'local-video-sync-state', (data) => {
        hostControls.consumeLockRevert();
        if (!data.fileName) return;
        playback.setActiveVideoId(null);
        playback.setRemoteLocalVideoMeta({ fileName: data.fileName, fileSize: data.fileSize, sender: data.sender });
        playback.setRemoteAction({
            action: data.isPlaying ? 'play' : 'pause',
            currentTime: data.currentTime,
            fileName: data.fileName,
            sender: data.sender,
            subtitleInfo: data.subtitleInfo
        });
        room.log(`🔄 Synced with room's local video session: "${data.fileName}"`);
    });
}
