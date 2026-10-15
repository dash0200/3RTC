/** The auto re-sync's decisions (see useDriftSync.js); plain functions, unit-tested. */
import { mediaKey } from '../media/sources';

export const HEARTBEAT_MS = 4000;
export const DRIFT_LIMIT_S = 1.5;
const SETTLE_MS = 5000;          // after any play/pause/seek/load, let things settle first
const LEAD_S = 0.3;              // land slightly ahead (the jump itself takes a moment)

/** "What is playing" for a state getter's result: same key on two apps = same video. */
export function playingKey(state) {
    if (!state) return '';
    if (state.mediaType === 'link') return `link:${mediaKey(state.media)}`;
    if (state.mediaType === 'local') return state.fileName ? `local:${state.fileName}:${state.fileSize || 0}` : '';
    return state.videoId ? `yt:${state.videoId}` : '';
}

/**
 * Pure decision (tested in tests/unit): given the reference's heartbeat and our own state, the
 * time to jump to, or null.
 */
export function driftCorrection(heartbeat, mine, { now, lastChangeAt, backoffUntil }) {
    if (!heartbeat || !mine) return null;
    if (now < backoffUntil || now - lastChangeAt < SETTLE_MS) return null;
    if (!heartbeat.isPlaying || !mine.isPlaying || mine.isBuffering || mine.live) return null;
    if (playingKey(mine) !== heartbeat.key) return null;
    const there = Number(heartbeat.currentTime);
    const here = Number(mine.currentTime);
    if (!Number.isFinite(there) || !Number.isFinite(here)) return null;
    if (Math.abs(here - there) <= DRIFT_LIMIT_S) return null;
    return there + LEAD_S;
}

