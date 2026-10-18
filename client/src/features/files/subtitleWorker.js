/** Reads a whole MKV in the background and sends back the text or PGS bitstream of its subtitle tracks. */
import { extractMkvSubtitles, extractMkvPgsSubtitles } from './mkv';

self.onmessage = async ({ data }) => {
    const { file, tracks, timecodeScale, isPgs, trackNumber } = data;
    const readAt = async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
    try {
        let last = 0;
        if (isPgs) {
            const supBytes = await extractMkvPgsSubtitles(readAt, file.size, trackNumber, {
                timecodeScale,
                onProgress: (p) => {
                    if (p - last >= 0.02 || p === 1) {
                        last = p;
                        self.postMessage({ progress: p });
                    }
                }
            });
            self.postMessage({ done: true, isPgs: true, supBytes, trackNumber }, [supBytes.buffer]);
            return;
        }

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

