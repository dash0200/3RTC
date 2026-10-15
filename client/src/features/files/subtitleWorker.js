/** Reads a whole MKV in the background and sends back the text of its subtitle tracks (see mkv.js). */
import { extractMkvSubtitles } from './mkv';

self.onmessage = async ({ data }) => {
    const { file, tracks, timecodeScale } = data;
    const readAt = async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
    try {
        let last = 0;
        const cues = await extractMkvSubtitles(readAt, file.size, tracks, {
            timecodeScale,
            onProgress: (p) => {
                if (p - last >= 0.02 || p === 1) {
                    last = p;
                    self.postMessage({ progress: p });
                }
            }
        });
        self.postMessage({ done: true, cues: [...cues.entries()] });
    } catch (err) {
        self.postMessage({ error: err?.message || 'Could not read the subtitles' });
    }
};
