/**
 * Plays a link source (Vimeo, Twitch, a direct video file, an HLS stream) in sync with the room.
 *
 * This is the sync engine for every link source; the sources themselves are small adapters
 * (./adapters) that all answer the same commands: play, pause, seek(t), getTime, isPaused, plus
 * events (ready, play, pause, seek, ended, error). So a new source never touches sync.
 *
 *   person uses the player  -> adapter event -> sent to the room ('media-action')
 *   the room changed it     -> remoteAction  -> adapter command (and its event is not sent back)
 *
 * Commands we give the player make it report events too; those are expected for a moment and
 * dropped, so only what a person did goes out. The browser's or provider's own controls are used.
 * Players never autoplay on their own: we start them once ready, from what the room is doing
 * (otherwise a provider's autoplay could restart a video the room just paused).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createAdapter, type PlayerAdapter, type PlayerEmitEvent } from './adapters';
import { PROVIDERS, fallbackTitle } from './sources';
import PasteLinkForm, { type PasteLinkFormProps } from './PasteLinkForm';
import type { MediaItem } from '../../types';
import type { PlaybackSyncState } from '../playback/drift';

const fmt = (s = 0): string => {
    const t = Math.max(0, Math.floor(s));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export interface PlayerAction {
    action: string;
    currentTime?: number;
    initial?: boolean;
    sender?: string;
    drift?: boolean;
    newVideoId?: string;
    videoId?: string;
    [key: string]: unknown;
}

export interface LinkPlayerProps {
    media: MediaItem;
    remoteAction?: PlayerAction | null;
    onBroadcastAction?: (action: string, payload?: Record<string, unknown>) => void;
    onRegisterStateGetter?: (getter: (() => PlaybackSyncState | null | undefined) | null) => void;
    onExit?: () => void;
    onEnded?: () => void;
    onVoteSkip?: () => void;
    skipVotes?: string[];
    peerCount?: number;
    username?: string;
    paste?: PasteLinkFormProps | null;
}

export default function LinkPlayer({
    media,
    remoteAction,
    onBroadcastAction,      // (action, payload): tells the room
    onRegisterStateGetter,  // () => { mediaType: 'link', media, currentTime, isPlaying, ... }
    onExit,
    onEnded,
    onVoteSkip,
    skipVotes = [],
    peerCount = 0,
    username = '',
    paste = null            // { onPlayLink, onPlayYouTube, onQueueLink, onQueueYouTube }: the next link
}: LinkPlayerProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const adapterRef = useRef<PlayerAdapter | null>(null);
    const readyRef = useRef<boolean>(false);
    const pendingRef = useRef<PlayerAction | null>({ action: 'play', currentTime: 0, initial: true }); // applied once ready
    const expectRef = useRef<{ play: number; pause: number; seek: number }>({ play: 0, pause: 0, seek: 0 });
    // Last known position (for people asking what we're watching, and the auto re-sync)
    const cacheRef = useRef<{ time: number; at: number; playing: boolean; buffering: boolean }>({ time: 0, at: Date.now(), playing: false, buffering: false });
    // Where the room is (to start from there after "Tap to play")
    const roomRef = useRef<{ time: number; at: number; playing: boolean }>({ time: 0, at: Date.now(), playing: true });
    const [status, setStatus] = useState<string>('Loading…');
    const [error, setError] = useState<string>('');
    const [blocked, setBlocked] = useState<boolean>(false);
    const [isLive, setIsLive] = useState<boolean>(Boolean('live' in media && media.live));
    const canSeek = !isLive && PROVIDERS[media.provider]?.canSeek !== false;
    const canSeekRef = useRef<boolean>(canSeek);
    canSeekRef.current = canSeek;
    const broadcastRef = useRef(onBroadcastAction);
    broadcastRef.current = onBroadcastAction;
    const onEndedRef = useRef(onEnded);
    onEndedRef.current = onEnded;

    const expect = (type: 'play' | 'pause' | 'seek', ms: number) => { expectRef.current[type] = Date.now() + ms; };
    const consume = (type: 'play' | 'pause' | 'seek') => {
        if (Date.now() < expectRef.current[type]) {
            expectRef.current[type] = 0;
            return true;
        }
        return false;
    };
    const note = (patch: Partial<{ time: number; playing: boolean; buffering: boolean }>) => {
        cacheRef.current = { ...cacheRef.current, ...patch, at: Date.now() };
    };
    const nowTime = () => {
        const c = cacheRef.current;
        return c.playing && !c.buffering ? c.time + (Date.now() - c.at) / 1000 : c.time;
    };

    const tryPlay = useCallback(async () => {
        const a = adapterRef.current;
        if (!a) return;
        expect('play', 4000);
        try {
            await a.play();
            setBlocked(false);
        } catch (err: unknown) {
            // Autoplay rule: this browser wants a tap first
            const errName = err instanceof Error ? err.name : '';
            const errMessage = err instanceof Error ? err.message : String(err);
            if (errName === 'NotAllowedError' || /interact|gesture|allowed/i.test(errMessage)) setBlocked(true);
        }
    }, []);

    /** Do what the room did. A newer command cancels an older one still in progress (players answer
     *  asynchronously, so a "play" could otherwise finish after a later "pause"). */
    const applyGenRef = useRef<number>(0);
    const apply = useCallback(async (act: PlayerAction) => {
        const a = adapterRef.current;
        if (!a) return;
        const gen = ++applyGenRef.current;
        const stale = () => gen !== applyGenRef.current;
        const t = typeof act.currentTime === 'number' && Number.isFinite(act.currentTime) ? act.currentTime : undefined;
        const cur = Number(await a.getTime()) || 0;
        if (stale()) return;
        if (act.action === 'play') {
            roomRef.current = { time: t ?? cur, at: Date.now(), playing: true };
            if (canSeekRef.current && t !== undefined && Math.abs(cur - t) > 1.2) {
                expect('seek', 6000);
                await a.seek(t);
                if (stale()) return;
            }
            note({ time: t ?? cur, playing: true });
            if (!act.initial) setStatus(`▶️ ${act.sender || 'Someone'} played`);
            await tryPlay();
        } else if (act.action === 'pause') {
            roomRef.current = { time: t ?? cur, at: Date.now(), playing: false };
            if (canSeekRef.current && t !== undefined && Math.abs(cur - t) > 0.5) {
                expect('seek', 6000);
                await a.seek(t);
                if (stale()) return;
            }
            expect('pause', 3000);
            await a.pause();
            note({ time: t ?? cur, playing: false });
            setStatus(`⏸️ ${act.sender || 'Someone'} paused`);
        } else if (act.action === 'seek' && t !== undefined && canSeekRef.current) {
            roomRef.current = { ...roomRef.current, time: t, at: Date.now() };
            expect('seek', 6000);
            await a.seek(t);
            note({ time: t });
            setStatus(act.drift ? '🔄 Back in sync with the room' : `⏩ ${act.sender || 'Someone'} jumped to ${fmt(t)}`);
        }
    }, [tryPlay]);

    // Create the player for this link (a new link mounts a new LinkPlayer: see Stage)
    useEffect(() => {
        let alive = true;
        const emit = (e: PlayerEmitEvent) => {
            if (!alive) return;
            const send = (action: string, extra: Record<string, unknown> = {}) => broadcastRef.current?.(action, extra);
            switch (e.type) {
                case 'ready': {
                    readyRef.current = true;
                    if (e.duration === Infinity) setIsLive(true);
                    setStatus('Synced with the room');
                    const pending = pendingRef.current;
                    pendingRef.current = null;
                    if (pending) apply(pending);
                    break;
                }
                case 'play':
                    note({ playing: true, ...(typeof e.time === 'number' ? { time: e.time } : {}) });
                    setBlocked(false);
                    if (consume('play')) break;
                    if (!readyRef.current) break; // (players don't autoplay: we start them once ready)
                    roomRef.current = { time: e.time ?? nowTime(), at: Date.now(), playing: true };
                    send('play', { currentTime: e.time ?? nowTime() });
                    setStatus('▶️ You played');
                    break;
                case 'pause':
                    note({ playing: false, ...(typeof e.time === 'number' ? { time: e.time } : {}) });
                    if (consume('pause')) break;
                    roomRef.current = { time: e.time ?? nowTime(), at: Date.now(), playing: false };
                    send('pause', { currentTime: e.time ?? nowTime() });
                    setStatus('⏸️ You paused');
                    break;
                case 'seek':
                    if (typeof e.time === 'number') note({ time: e.time });
                    if (consume('seek') || !canSeekRef.current) break;
                    roomRef.current = { ...roomRef.current, time: e.time ?? nowTime(), at: Date.now() };
                    send('seek', { currentTime: e.time ?? nowTime() });
                    setStatus(`⏩ You jumped to ${fmt(e.time)}`);
                    break;
                case 'buffering':
                    note({ buffering: true });
                    break;
                case 'playing':
                    note({ buffering: false });
                    break;
                case 'ended':
                    note({ playing: false });
                    setStatus('Finished');
                    onEndedRef.current?.();
                    break;
                case 'error':
                    setStatus('');
                    setError(e.message || 'This video can\'t be played here');
                    break;
                default:
                    break;
            }
        };
        if (containerRef.current) {
            createAdapter(containerRef.current, media, emit)
                .then((adapter) => {
                    if (!alive) {
                        adapter.destroy();
                        return;
                    }
                    adapterRef.current = adapter;
                })
                .catch((err) => {
                    if (!alive) return;
                    setStatus('');
                    setError(err?.message || 'This video can\'t be played here');
                });
        }
        // Keep the known position fresh (some players only answer asynchronously)
        const poll = setInterval(async () => {
            const a = adapterRef.current;
            if (!a || !readyRef.current) return;
            try {
                const [time, paused] = await Promise.all([a.getTime(), a.isPaused()]);
                note({ time: Number(time) || 0, playing: !paused, buffering: Boolean(a.isBuffering?.()) });

            } catch { /* player gone */ }
        }, 500);
        return () => {
            alive = false;
            clearInterval(poll);
            adapterRef.current?.destroy();
            adapterRef.current = null;
            readyRef.current = false;
        };
        // media is fixed for this LinkPlayer (keyed by link in Stage)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The room changed something
    useEffect(() => {
        if (!remoteAction || remoteAction.type === 'yt-action' || remoteAction.type === 'local-video-action') return;
        const { action } = remoteAction;
        if (action === 'load' || action === 'close' || action === 'unload') return;
        if (!readyRef.current) {
            pendingRef.current = remoteAction; // the newest wins
            return;
        }
        apply(remoteAction);
    }, [remoteAction, apply]);

    // What we're watching, for people joining and for the auto re-sync
    useEffect(() => {
        onRegisterStateGetter?.(() => ({
            mediaType: 'link',
            media,
            currentTime: nowTime(),
            isPlaying: cacheRef.current.playing,
            isBuffering: cacheRef.current.buffering,
            live: !canSeekRef.current
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onRegisterStateGetter, media]);

    const tapToPlay = async () => {
        const a = adapterRef.current;
        if (!a) return;
        const r = roomRef.current;
        const target = r.playing ? r.time + (Date.now() - r.at) / 1000 : r.time;
        if (canSeek && target > 0) {
            expect('seek', 6000);
            await a.seek(target);
        }
        await tryPlay();
    };

    const title = media.title || fallbackTitle(media);
    const required = Math.max(1, Math.ceil(Math.max(1, peerCount || 1) / 2));
    const voted = skipVotes.includes(username);

    return (
        <div className="link-player" data-provider={media.provider}>
            <div className="link-player-bar">
                <span className={`link-player-badge is-${media.provider}`}>{PROVIDERS[media.provider]?.label || 'Video'}{isLive ? ' · LIVE' : ''}</span>
                <span className="link-player-title" title={title}>{title}</span>
                <span className="link-player-status" aria-live="polite">{status}</span>
                {paste && <PasteLinkForm {...paste} />}
                {typeof onVoteSkip === 'function' && peerCount > 1 && (
                    <button type="button" className={`link-player-btn vote-skip-btn ${voted ? 'is-on' : ''}`} onClick={onVoteSkip} title="Vote to skip this video">
                        ⏭ Skip {skipVotes.length > 0 ? `(${skipVotes.length}/${required})` : ''}
                    </button>
                )}
                <button type="button" className="link-player-btn link-player-exit" onClick={onExit}>✕ Exit Video</button>
            </div>
            <div className="link-player-stage" ref={containerRef}>
                {error && (
                    <div className="link-player-message" role="alert">
                        <p>{error}</p>
                        <p className="link-player-hint">Everyone else may see the same. Try another link, or a YouTube, Vimeo or Twitch link.</p>
                        <button type="button" className="btn btn-secondary" onClick={onExit}>Close video</button>
                    </div>
                )}
                {blocked && !error && (
                    <button type="button" className="link-player-tap" onClick={tapToPlay}>▶ Tap to play with the room</button>
                )}
            </div>
        </div>
    );
}
