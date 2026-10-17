import { extractMkvSubtitles, extractMkvPgsSubtitles } from './mkv';
import { cuesToWebVTT } from '../../utils/subtitleParser';

export const isPgsTrack = (track) => Boolean(track) && (track.codec === 'S_HDMV/PGS' || /pgs/i.test(track.codec || '') || /pgs/i.test(track.label || ''));

/** Can we turn this track (from format.subtitles) into subtitles the player can display? */
export const canExtract = (track) => Boolean(track) && (track.kind === 'text' || isPgsTrack(track)) && !track.embeddedMp4;

function runInWorker(file, tracks, timecodeScale, onProgress, isPgs, trackNumber) {
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
                if (data.isPgs) {
                    resolve({ isPgs: true, supBytes: data.supBytes, trackNumber: data.trackNumber });
                } else {
                    resolve(new Map(data.cues));
                }
            } else if (data.error) {
                worker.terminate();
                reject(new Error(data.error));
            }
        };
        worker.onerror = (e) => {
            worker.terminate();
            reject(new Error(e.message || 'worker failed'));
        };
        worker.postMessage({ file, tracks, timecodeScale, isPgs, trackNumber });
    });
}

/**
 * The cues of one subtitle track: [{ startSec, endSec, text }] OR { isPgs: true, supBytes, trackNumber }.
 */
export async function extractSubtitleTrack(file, track, { timecodeScale = 1000000, onProgress } = {}) {
    const isPgs = isPgsTrack(track);
    const tracks = [{ number: track.number, codecId: track.codec }];
    let result;
    try {
        result = await runInWorker(file, tracks, timecodeScale, onProgress, isPgs, track.number);
    } catch (err) {
        if (typeof Worker !== 'undefined' && !/worker/i.test(String(err?.message))) throw err;
        // Fallback: read on this thread
        const readAt = async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
        if (isPgs) {
            const supBytes = await extractMkvPgsSubtitles(readAt, file.size, track.number, { timecodeScale, onProgress });
            return { isPgs: true, supBytes, trackNumber: track.number };
        }
        const cues = await extractMkvSubtitles(readAt, file.size, tracks, { timecodeScale, onProgress });
        return cues.get(track.number) || [];
    }

    if (isPgs) {
        return result;
    }
    return result.get(track.number) || [];
}

export const cuesToVtt = (cues) => cuesToWebVTT(cues);

