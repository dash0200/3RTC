/**
 * Subtitle tracks inside a video file, as WebVTT text the player (and the room) can use.
 * MKV/WebM text tracks (SRT, ASS/SSA, WebVTT) are read in a worker, so a 2 GB file doesn't
 * freeze the page; picture subtitles (PGS, VobSub) can't be turned into text.
 */
import { extractMkvSubtitles } from './mkv';
import { cuesToWebVTT } from '../../utils/subtitleParser';

/** Can we turn this track (from format.subtitles) into text? */
export const canExtract = (track) => Boolean(track) && track.kind === 'text' && !track.embeddedMp4;

function runInWorker(file, tracks, timecodeScale, onProgress) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(new URL('./subtitleWorker.js', import.meta.url), { type: 'module' });
        } catch (err) {
            reject(err);
            return;
        }
        worker.onmessage = ({ data }) => {
            if (data.progress !== undefined) onProgress?.(data.progress);
            if (data.done) {
                worker.terminate();
                resolve(new Map(data.cues));
            } else if (data.error) {
                worker.terminate();
                reject(new Error(data.error));
            }
        };
        worker.onerror = (e) => {
            worker.terminate();
            reject(new Error(e.message || 'worker failed'));
        };
        worker.postMessage({ file, tracks, timecodeScale });
    });
}

/**
 * The cues of one subtitle track: [{ startSec, endSec, text }]. `track` is from format.subtitles.
 */
export async function extractSubtitleTrack(file, track, { timecodeScale = 1000000, onProgress } = {}) {
    const tracks = [{ number: track.number, codecId: track.codec }];
    let cues;
    try {
        cues = await runInWorker(file, tracks, timecodeScale, onProgress);
    } catch (err) {
        if (typeof Worker !== 'undefined' && !/worker/i.test(String(err?.message))) throw err;
        // No module workers here: read on this thread instead
        const readAt = async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
        cues = await extractMkvSubtitles(readAt, file.size, tracks, { timecodeScale, onProgress });
    }
    return cues.get(track.number) || [];
}

export const cuesToVtt = (cues) => cuesToWebVTT(cues);
