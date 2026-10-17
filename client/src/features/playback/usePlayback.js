/**
 * What the room is watching: a YouTube video, a local video file one person shares (played by
 * the others through the P2P stream, see useStreamTransfer), or a link source (Vimeo, Twitch, a
 * direct video file, an HLS stream: features/media). Holds that state, sends play / pause /
 * seek / load / close to the room, and applies the ones that arrive.
 *
 * Players get remote commands through `remoteAction` (a new object each time) and report local
 * changes through `broadcastAction`.
 *
 * Wire: 'yt-action', 'local-video-action' and 'media-action' { action, fromHost, ...details }
 * ('media-action' load carries { media }, see features/media/sources.js). YouTube and local files
 * keep their own message types so apps from before link sources still sync them.
 * Events: emits 'media-changed' whenever the video changes or closes.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchYouTubeTitle } from '../../components/YouTubeSyncPlayer';
import { detectOnDemandStreaming, canChecksum } from '../../utils/p2pStreamer';
import { usePeerMessageOn } from '../../core/RoomContext';
import { normalizeMedia, fallbackTitle } from '../media/sources';

const isPhoneLikeDevice = () => {
    try {
        return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch {
        return false;
    }
};

// Tests: act like an app from before the swarm (relay tree only), to check both work in one room
const olderAppForTests = () => {
    try { return localStorage.getItem('3rtc_no_swarm') === '1'; } catch { return false; }
};

const clock = (seconds = 0) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function usePlayback({ room, hostControls }) {
    const { bus } = room;
    const [activeVideoId, setActiveVideoId] = useState(null);
    const [activeVideoTitle, setActiveVideoTitle] = useState('');
    const [localVideoFile, setLocalVideoFile] = useState(null);
    const [remoteLocalVideoMeta, setRemoteLocalVideoMeta] = useState(null);
    const [remoteAction, setRemoteAction] = useState(null);
    const [streamProgress, setStreamProgress] = useState(null);
    const [streamVideoUrl, setStreamVideoUrl] = useState(null);
    const [activeMedia, setActiveMediaState] = useState(null); // a link source, see features/media

    const activeVideoIdRef = useRef(null);
    activeVideoIdRef.current = activeVideoId;
    const activeVideoTitleRef = useRef('');
    activeVideoTitleRef.current = activeVideoTitle;
    const localVideoFileRef = useRef(null);
    localVideoFileRef.current = localVideoFile;
    const streamVideoUrlRef = useRef(null);
    streamVideoUrlRef.current = streamVideoUrl;
    const activeMediaRef = useRef(null);
    const setActiveMedia = useCallback((m) => {
        activeMediaRef.current = m;
        setActiveMediaState(m);
    }, []);
    // When playback last changed (by anyone): the auto re-sync leaves a moment after a change alone
    const lastChangeAtRef = useRef(0);
    // The player's current state, for people joining later (registered by the player)
    const syncStateGetterRef = useRef(null);
    // P2P stream of a local video (owned by useStreamTransfer, reset here when the video changes)
    const streamReceiverRef = useRef(null);
    const activeStreamSendersRef = useRef(new Map());

    const mediaChanged = useCallback(() => bus.emitEvent('media-changed'), [bus]);

    /** Stop receiving the P2P stream we are watching (if any). */
    const stopReceiving = useCallback(() => {
        streamReceiverRef.current?.abort();
        streamReceiverRef.current = null;
        if (streamVideoUrlRef.current) {
            try { URL.revokeObjectURL(streamVideoUrlRef.current); } catch { }
            setStreamVideoUrl(null);
        }
        setStreamProgress(null);
    }, []);

    const stopSending = useCallback(() => {
        for (const sender of activeStreamSendersRef.current.values()) sender.abort();
        activeStreamSendersRef.current.clear();
    }, []);

    /** Send a playback change to the room (stopped by the host controls lock when it applies). */
    const broadcastAction = useCallback((action, payload = {}) => {
        const type = payload.type || 'yt-action';
        if (!hostControls.allowPlaybackChange(type, action, payload)) return;
        lastChangeAtRef.current = Date.now();
        bus.broadcast(type, { action, fromHost: room.getSelf().isHost, ...payload, type });
    }, [bus, room, hostControls]);

    // ---- remote changes ---------------------------------------------------------------------
    usePeerMessageOn(bus, 'yt-action', async (data, from) => {
        if (!hostControls.acceptRemotePlayback(data)) return;
        lastChangeAtRef.current = Date.now();
        const who = room.peerName(from) || data.sender || 'Peer';
        if (data.action === 'close' || data.action === 'unload') {
            setActiveVideoId(null);
            setActiveVideoTitle('');
            mediaChanged();
            setRemoteAction(data);
            room.log(`🎬 ${who} exited the video`);
            room.notify(`${who} exited the video`);
            return;
        }
        if (data.action === 'load') {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            setActiveMedia(null);
            const newId = data.newVideoId || data.videoId;
            setActiveVideoId(newId);
            mediaChanged();
            const title = data.title || await fetchYouTubeTitle(newId);
            setActiveVideoTitle(title);
            room.log(`🎬 ${who} loaded a YouTube video${title ? `: "${title}"` : ''}`);
            room.notify(`${who} loaded ${title || 'video'}`);
        } else if (data.action === 'play') {
            room.log(`▶️ ${who} played the video`);
        } else if (data.action === 'pause') {
            room.log(`⏸️ ${who} paused the video`);
        } else if (data.action === 'seek') {
            room.log(`⏩ ${who} seeked to ${clock(data.currentTime)}`);
        }
        setRemoteAction(data);
    });

    usePeerMessageOn(bus, 'local-video-action', (data, from) => {
        if (!hostControls.acceptRemotePlayback(data)) return;
        lastChangeAtRef.current = Date.now();
        const who = room.peerName(from) || data.sender || 'Peer';
        if (data.action === 'load') {
            setActiveVideoId(null);
            setActiveMedia(null);
            setRemoteLocalVideoMeta({ fileName: data.fileName, fileSize: data.fileSize, sender: who });
            mediaChanged();
            setRemoteAction(data);
            room.log(`📁 ${who} loaded local video: "${data.fileName}"`);
            room.notify(`${who} loaded: ${data.fileName}`);
        } else if (data.action === 'close') {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            mediaChanged();
            setRemoteAction(data);
            room.log(`📁 ${who} exited the local video`);
            room.notify(`${who} exited local video`);
        } else if (data.action === 'subtitle-share') {
            setRemoteAction(data);
            room.log(`💬 ${who} shared subtitles: "${data.fileName || 'captions'}"`);
            room.notify(`Subtitles loaded from ${who}`);
        } else {
            setRemoteAction(data);
            if (data.action === 'play') room.log(`▶️ ${who} played local video`);
            else if (data.action === 'pause') room.log(`⏸️ ${who} paused local video`);
            else if (data.action === 'seek') room.log(`⏩ ${who} seeked to ${clock(data.currentTime)}`);
        }
    });

    usePeerMessageOn(bus, 'media-action', (data, from) => {
        if (!hostControls.acceptRemotePlayback(data)) return;
        lastChangeAtRef.current = Date.now();
        const who = room.peerName(from) || data.sender || 'Peer';
        if (data.action === 'load') {
            const media = normalizeMedia(data.media);
            if (!media) return;
            setActiveVideoId(null);
            setActiveVideoTitle('');
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            stopReceiving();
            setActiveMedia(media);
            mediaChanged();
            setRemoteAction(data);
            const title = media.title || fallbackTitle(media);
            room.log(`🎬 ${who} opened: "${title}"`);
            room.notify(`${who} opened ${title}`);
            return;
        }
        if (data.action === 'close' || data.action === 'unload') {
            if (!activeMediaRef.current) return;
            setActiveMedia(null);
            mediaChanged();
            setRemoteAction(data);
            room.log(`🎬 ${who} exited the video`);
            room.notify(`${who} exited the video`);
            return;
        }
        if (!activeMediaRef.current) return;
        if (data.action === 'play') room.log(`▶️ ${who} played the video`);
        else if (data.action === 'pause') room.log(`⏸️ ${who} paused the video`);
        else if (data.action === 'seek') room.log(`⏩ ${who} seeked to ${clock(data.currentTime)}`);
        setRemoteAction(data);
    });

    // ---- local changes ----------------------------------------------------------------------
    /** Show a YouTube video here (the caller tells the room). `newId` null closes it. */
    const changeVideo = useCallback(async (newId, customTitle = '') => {
        if (newId) {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            setActiveMedia(null);
        }
        setActiveVideoId(newId);
        mediaChanged();
        if (newId) {
            const title = customTitle || await fetchYouTubeTitle(newId);
            setActiveVideoTitle(title);
            room.log(`🎬 You loaded: "${title}"`);
        } else {
            setActiveVideoTitle('');
            room.log('🎬 You exited the video');
        }
    }, [room, mediaChanged]);

    /** Show a YouTube video here and tell the room (queue, quick picks). */
    const playYouTube = useCallback((videoId, title, extra = {}) => {
        if (hostControls.isLockedForMe()) {
            hostControls.onBlocked();
            return;
        }
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        setActiveMedia(null);
        setActiveVideoId(videoId);
        setActiveVideoTitle(title);
        mediaChanged();
        broadcastAction('load', { type: 'yt-action', action: 'load', newVideoId: videoId, title, ...extra });
    }, [broadcastAction, hostControls, mediaChanged, setActiveMedia]);

    /** Open a link source here and tell the room (paste box, queue). */
    const playLink = useCallback((media, extra = {}) => {
        const clean = normalizeMedia(media);
        if (!clean) return;
        if (hostControls.isLockedForMe()) {
            hostControls.onBlocked();
            return;
        }
        setActiveVideoId(null);
        setActiveVideoTitle('');
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        stopReceiving();
        setActiveMedia(clean);
        mediaChanged();
        broadcastAction('load', { type: 'media-action', media: clean, ...extra });
        room.log(`🎬 You opened: "${clean.title || fallbackTitle(clean)}"`);
    }, [broadcastAction, hostControls, mediaChanged, room, setActiveMedia, stopReceiving]);

    const selectLocalFile = useCallback((file) => {
        if (!file) return;
        localVideoFileRef.current = file;
        stopReceiving();
        setActiveVideoId(null);
        setActiveMedia(null);
        setLocalVideoFile(file);
        setRemoteLocalVideoMeta(null);
        mediaChanged();
        room.log(`📁 You loaded local video: "${file.name}"`);
        room.notify(`Loaded "${file.name}"`);
        broadcastAction('load', { type: 'local-video-action', fileName: file.name, fileSize: file.size });
    }, [broadcastAction, room, stopReceiving, mediaChanged, setActiveMedia]);

    const closeLocalVideo = useCallback(() => {
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        stopReceiving();
        stopSending();
        mediaChanged();
        room.log('📁 You exited the local video');
    }, [room, stopReceiving, stopSending, mediaChanged]);

    const requestStream = useCallback(async () => {
        if (!remoteLocalVideoMeta) return;
        // On-demand streaming needs this page's service worker; otherwise the owner sends the whole file
        const supportsRange = await detectOnDemandStreaming();
        bus.broadcast('p2p-stream-request', {
            requester: room.getSelf().username,
            fileName: remoteLocalVideoMeta.fileName,
            supportsRange,
            // Computers can pass the video on to other viewers; phones (battery, upload) don't
            canRelay: supportsRange && !isPhoneLikeDevice(),
            // Fetch from other viewers too (owners with an older app ignore it and use the relay tree)
            swarm: supportsRange && canChecksum() && !olderAppForTests()
        });
        setStreamProgress({
            percent: 0, speedMBs: 0, receivedBytes: 0, totalBytes: remoteLocalVideoMeta.fileSize || 0,
            receivedChunksCount: 0, totalChunks: 0, fileName: remoteLocalVideoMeta.fileName, isReady: false
        });
        room.log('📡 Requesting direct P2P video stream from peer...');
        room.notify('Requesting video stream...');
    }, [bus, room, remoteLocalVideoMeta]);

    const cancelStream = useCallback(() => {
        stopReceiving();
        bus.broadcast('p2p-stream-cancel', {});
        room.log('Cancelled P2P stream');
        room.notify('Stream cancelled');
    }, [bus, room, stopReceiving]);

    const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta || streamVideoUrl || activeMedia);

    const exitVideo = useCallback(() => {
        if (activeMediaRef.current) {
            setActiveMedia(null);
            mediaChanged();
            broadcastAction('close', { type: 'media-action' });
            room.log('🎬 You exited the video');
        } else if (localVideoFile || remoteLocalVideoMeta || streamVideoUrl) {
            closeLocalVideo();
            broadcastAction('close', { type: 'local-video-action' });
        } else if (activeVideoId) {
            changeVideo(null);
            broadcastAction('close', {});
        }
    }, [localVideoFile, remoteLocalVideoMeta, streamVideoUrl, activeVideoId, closeLocalVideo, changeVideo, broadcastAction, mediaChanged, room, setActiveMedia]);

    /** A passed skip vote with nothing queued: close what's playing for everyone. */
    const closeByVote = useCallback(() => {
        if (activeMediaRef.current) {
            setActiveMedia(null);
            mediaChanged();
            broadcastAction('close', { type: 'media-action', byVote: true });
        } else {
            setActiveVideoId(null);
            setActiveVideoTitle('');
            broadcastAction('close', { byVote: true });
        }
    }, [broadcastAction, mediaChanged, setActiveMedia]);

    /** A timestamp clicked in chat: jump everyone there (respects the host controls lock). */
    const seekEveryone = useCallback((seconds) => {
        if (!hostControls.allowPlaybackChange(null)) return;
        const type = activeVideoIdRef.current ? 'yt-action' : activeMediaRef.current ? 'media-action' : 'local-video-action';
        const self = room.getSelf();
        setRemoteAction({ action: 'seek', currentTime: seconds, type, fromHost: self.isHost, sender: self.username, timestamp: Date.now() });
        broadcastAction('seek', { type, currentTime: seconds });
        const m = Math.floor(seconds / 60);
        room.notify(`⏩ Jumped to ${m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`);
    }, [broadcastAction, hostControls, room]);

    /** Close whatever is open without telling anyone (host controls revert). */
    const closeAllQuietly = useCallback(() => {
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        setActiveVideoId(null);
        setActiveVideoTitle('');
        setActiveMedia(null);
        mediaChanged();
        setRemoteAction({ action: 'close', type: 'yt-action', fromHost: true });
    }, [mediaChanged, setActiveMedia]);

    useEffect(() => bus.onEvent('room-left', () => {
        setActiveVideoId(null);
        setActiveVideoTitle('');
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        setRemoteAction(null);
        setActiveMedia(null);
        stopReceiving();
        stopSending();
    }), [bus, stopReceiving, stopSending, setActiveMedia]);

    return {
        // state
        activeVideoId, activeVideoTitle, localVideoFile, remoteLocalVideoMeta, remoteAction,
        streamProgress, streamVideoUrl, isMediaActive, activeMedia,
        // setters used by sync and streaming
        setActiveVideoId, setActiveVideoTitle, setLocalVideoFile, setRemoteLocalVideoMeta, setRemoteAction,
        setStreamProgress, setStreamVideoUrl, setActiveMedia,
        // refs
        activeVideoIdRef, activeVideoTitleRef, localVideoFileRef, syncStateGetterRef, streamReceiverRef, activeStreamSendersRef,
        activeMediaRef, lastChangeAtRef,
        // actions
        broadcastAction, changeVideo, playYouTube, playLink, selectLocalFile, closeLocalVideo, requestStream, cancelStream,
        exitVideo, closeByVote, seekEveryone, closeAllQuietly, stopReceiving
    };
}
