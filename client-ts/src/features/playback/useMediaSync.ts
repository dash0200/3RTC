/**
 * Catching up: when a channel to a peer opens we ask what they are watching ('yt-request-sync'),
 * and answer the same question from others with our player's position, the queue and skip votes.
 * The host controls lock also uses it: a guest whose change was blocked asks the host and is put
 * back to the host's state.
 *
 * Wire: 'yt-request-sync' -> 'yt-sync-state' { videoId, currentTime, isPlaying, queue, skipVotes,
 * activeVideoTitle } | { nothingPlaying: true }, or 'local-video-sync-state' { fileName, fileSize, ... },
 * or 'media-sync-state' { media, currentTime, isPlaying, queue, skipVotes } for a link source.
 */
import { useEffect, type RefObject } from 'react';
import type { RoomBus, MediaItem, QueueItem } from '../../types';
import { usePeerMessageOn } from '../../core/RoomContext';
import { normalizeMedia } from '../media/sources';
import type { PlaybackSyncState } from './drift';

export interface UseMediaSyncPlayback {
  syncStateGetterRef: { current: (() => PlaybackSyncState | null | undefined) | null };
  activeMediaRef: { current: MediaItem | null };
  activeVideoTitleRef: { current: string };
  localVideoFileRef: { current: File | null };
  remoteLocalVideoMeta: { fileName: string; fileSize?: number; sender?: string } | null;
  streamVideoUrlRef?: { current: string | null };
  activeVideoIdRef: { current: string | null };
  closeAllQuietly: () => void;
  setLocalVideoFile: (file: File | null) => void;
  setRemoteLocalVideoMeta: (meta: { fileName: string; fileSize?: number; sender?: string } | null) => void;
  setActiveMedia: (media: MediaItem | null) => void;
  setActiveVideoId: (id: string | null) => void;
  setActiveVideoTitle: (title: string) => void;
  setRemoteAction: (action: Record<string, unknown>) => void;
}

export interface UseMediaSyncQueue {
  queueRef: RefObject<QueueItem[]>;
  skipVotesRef: RefObject<string[]>;
  setQueue: (queue: QueueItem[]) => void;
  setSkipVotes: (votes: string[]) => void;
}

export interface UseMediaSyncProps {
  room: {
    bus: RoomBus;
    log: (msg: string) => void;
  };
  playback: UseMediaSyncPlayback;
  queue: UseMediaSyncQueue;
  hostControls: {
    consumeLockRevert: () => boolean;
  };
}

export function useMediaSync({ room, playback, queue, hostControls }: UseMediaSyncProps): void {
  const { bus } = room;

  useEffect(
    () => bus.onEvent('peer-open', (peerId) => bus.send(peerId as string, 'yt-request-sync', {})),
    [bus]
  );

  usePeerMessageOn(bus, 'yt-request-sync', (_data, from) => {
    const state = playback.syncStateGetterRef.current?.();
    if (state?.mediaType === 'local' && state.fileName) {
      bus.send(from, 'local-video-sync-state', { ...state });
      return;
    }
    if (state?.mediaType === 'link' && state.media && playback.activeMediaRef.current) {
      bus.send(from, 'media-sync-state', {
        media: playback.activeMediaRef.current,
        currentTime: state.currentTime,
        isPlaying: state.isPlaying,
        queue: queue.queueRef.current,
        skipVotes: queue.skipVotesRef.current
      });
      return;
    }
    if (playback.activeMediaRef.current) {
      // Link open but its player isn't up yet: say what, not where (where would be 0:00)
      bus.send(from, 'media-sync-state', {
        media: playback.activeMediaRef.current,
        queue: queue.queueRef.current,
        skipVotes: queue.skipVotesRef.current
      });
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
      bus.send(from, 'local-video-sync-state', {
        mediaType: 'local',
        fileName: file.name,
        fileSize: file.size,
        currentTime: 0,
        isPlaying: false
      });
      return;
    }
    if (playback.remoteLocalVideoMeta) {
      bus.send(from, 'local-video-sync-state', {
        mediaType: 'local',
        fileName: playback.remoteLocalVideoMeta.fileName,
        fileSize: playback.remoteLocalVideoMeta.fileSize,
        currentTime: 0,
        isPlaying: false
      });
      return;
    }
    // Nothing playing here (lets a guest under the host controls lock drop what it opened)
    bus.send(from, 'yt-sync-state', { videoId: null, nothingPlaying: true });
  });

  usePeerMessageOn<{
    nothingPlaying?: boolean;
    videoId?: string | null;
    queue?: QueueItem[];
    skipVotes?: string[];
    activeVideoTitle?: string;
    isPlaying?: boolean;
    currentTime?: number;
  }>(bus, 'yt-sync-state', (data) => {
    const isLockRevert = hostControls.consumeLockRevert();
    if (data.nothingPlaying) {
      // Host controls lock: we opened something the host doesn't have, so close it
      if (isLockRevert) playback.closeAllQuietly();
      return;
    }
    if (!data.videoId) return;
    // If we are currently watching or hosting our own local video, ignore incoming yt-sync-state
    // from peers unless it's a host lock revert
    if (
      (playback.localVideoFileRef.current ||
        playback.streamVideoUrlRef?.current ||
        playback.remoteLocalVideoMeta) &&
      !isLockRevert
    ) {
      return;
    }
    // Already watching this video: the answer came from someone who just joined (their player
    // may still be at 0:00), so only take the queue; the host-lock revert is the exception
    const alreadyHere = data.videoId === playback.activeVideoIdRef.current;
    if (Array.isArray(data.queue) && !alreadyHere) queue.setQueue(data.queue);
    if (Array.isArray(data.skipVotes)) queue.setSkipVotes(data.skipVotes);
    if (alreadyHere && !isLockRevert) return;
    playback.setLocalVideoFile(null);
    playback.setRemoteLocalVideoMeta(null);
    playback.setActiveMedia(null);
    playback.setActiveVideoId(data.videoId);
    if (data.activeVideoTitle) playback.setActiveVideoTitle(data.activeVideoTitle);
    playback.setRemoteAction({
      action: data.isPlaying ? 'play' : 'pause',
      currentTime: data.currentTime,
      newVideoId: data.videoId
    });
    room.log('🔄 Synced YouTube playback & queue with room');
  });

  usePeerMessageOn<{
    media?: MediaItem;
    queue?: QueueItem[];
    skipVotes?: string[];
    currentTime?: number;
    isPlaying?: boolean;
    sender?: string;
  }>(bus, 'media-sync-state', (data) => {
    const isLockRevert = hostControls.consumeLockRevert();
    const media = normalizeMedia(data.media);
    if (!media) return;
    // If we are currently watching or hosting our own local video, ignore incoming media-sync-state
    // from peers unless it's a host lock revert
    if (
      (playback.localVideoFileRef.current ||
        playback.streamVideoUrlRef?.current ||
        playback.remoteLocalVideoMeta) &&
      !isLockRevert
    ) {
      return;
    }
    // Already watching this: the answer came from someone who just joined (see yt-sync-state)
    const alreadyHere = playback.activeMediaRef.current?.url === media.url;
    if (alreadyHere && !isLockRevert) return;
    playback.setActiveVideoId(null);
    playback.setLocalVideoFile(null);
    playback.setRemoteLocalVideoMeta(null);
    if (!alreadyHere) playback.setActiveMedia(media);
    if (Array.isArray(data.queue)) queue.setQueue(data.queue);
    if (Array.isArray(data.skipVotes)) queue.setSkipVotes(data.skipVotes);
    if (typeof data.currentTime !== 'number') return; // they don't know where yet
    playback.setRemoteAction({
      type: 'media-action',
      action: data.isPlaying ? 'play' : 'pause',
      currentTime: data.currentTime,
      sender: data.sender
    });
    room.log(`🔄 Synced with the room's video: "${media.title || media.url}"`);
  });

  usePeerMessageOn<{
    fileName?: string;
    fileSize?: number;
    sender?: string;
    isPlaying?: boolean;
    currentTime?: number;
    subtitleInfo?: unknown;
  }>(bus, 'local-video-sync-state', (data) => {
    const isLockRevert = hostControls.consumeLockRevert();
    if (!data.fileName) return;
    // If we already have the local file loaded locally on disk as owner, keep it!
    if (playback.localVideoFileRef.current && !isLockRevert) return;
    // Already watching this file: don't jump to a newcomer's spot (see yt-sync-state)
    const here = playback.localVideoFileRef.current?.name || playback.remoteLocalVideoMeta?.fileName;
    if (here === data.fileName && !isLockRevert) return;
    playback.setActiveVideoId(null);
    playback.setActiveMedia(null);
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
