/**
 * In-browser WebAssembly Audio Transcoder (e.g. E-AC-3 / AC-3 -> AAC).
 * Runs single-threaded FFmpeg WASM inside a Web Worker so the UI never stutters.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { extractMkvAudioTrack } from '../files/mkv';

// Cache of transcoded audio by file signature: key -> { blob, url, trackNumber, codec }
const transcodeCache = new Map();

let ffmpegInstance = null;
let loadPromise = null;

const readerFor = (file) => async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());

/**
 * Initializes and loads the WebAssembly FFmpeg core.
 * Attempts local assets first, then falls back to jsdelivr CDN.
 */
export async function getFFmpeg(onLog) {
    if (ffmpegInstance?.loaded) return ffmpegInstance;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        const ffmpeg = new FFmpeg();
        if (onLog) {
            ffmpeg.on('log', ({ message }) => onLog(message));
        }

        const CORE_VERSION = '0.12.10';
        const CDN_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

        let loaded = false;
        // Try local assets first (/ffmpeg/ffmpeg-core.js)
        try {
            const coreURL = await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript');
            const wasmURL = await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm');
            await ffmpeg.load({ coreURL, wasmURL });
            loaded = true;
        } catch {
            // Local load failed or not available, fallback to CDN
        }

        if (!loaded) {
            try {
                const coreURL = await toBlobURL(`${CDN_BASE}/ffmpeg-core.js`, 'text/javascript');
                const wasmURL = await toBlobURL(`${CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm');
                await ffmpeg.load({ coreURL, wasmURL });
                loaded = true;
            } catch (cdnErr) {
                throw new Error(`Failed to load audio transcoding engine: ${cdnErr?.message || 'Network error'}`);
            }
        }

        ffmpegInstance = ffmpeg;
        return ffmpeg;
    })();

    try {
        return await loadPromise;
    } finally {
        loadPromise = null;
    }
}

/**
 * Transcode an unsupported audio track (e.g. E-AC-3) in the video file to AAC (.m4a).
 * @param {File} file
 * @param {object} options
 * @param {object} options.format - parsed file format from formats.js
 * @param {number} [options.trackNumber] - optional specific track number to transcode
 * @param {(p: number, stage: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ blob: Blob, url: string, trackNumber: number, codec: string }>}
 */
export async function transcodeAudioTrack(file, { format, trackNumber, onProgress, signal } = {}) {
    if (!file) throw new Error('No video file provided');

    // Pick target audio track
    const audioTracks = format?.audio || [];
    const targetTrack = trackNumber
        ? audioTracks.find((a) => a.number === trackNumber) || audioTracks[0]
        : audioTracks[0];

    const targetNumber = targetTrack?.number || 1;
    const cacheKey = `${file.name}-${file.size}-${file.lastModified}-${targetNumber}`;

    if (transcodeCache.has(cacheKey)) {
        onProgress?.(1, 'Ready');
        return transcodeCache.get(cacheKey);
    }

    if (signal?.aborted) throw new Error('Transcoding aborted');

    onProgress?.(0.02, 'Preparing transcoder…');
    const ffmpeg = await getFFmpeg();

    if (signal?.aborted) throw new Error('Transcoding aborted');

    let inputBytes = null;
    let inputName = 'input.audio';

    const isMkv = format?.container === 'matroska' || format?.container === 'webm' || /\.mkv$/i.test(file.name);

    if (isMkv && targetTrack?.number) {
        onProgress?.(0.05, 'Extracting audio bitstream…');
        const readAt = readerFor(file);
        inputBytes = await extractMkvAudioTrack(readAt, file.size, targetTrack.number, {
            onProgress: (p) => {
                if (signal?.aborted) throw new Error('Transcoding aborted');
                onProgress?.(0.05 + p * 0.25, `Extracting audio track (${Math.round(p * 100)}%)…`);
            },
            isCancelled: () => Boolean(signal?.aborted)
        });
    }

    if (!inputBytes || inputBytes.length === 0) {
        // Fallback: If smaller file or couldn't extract stream separately, read slice or file directly
        if (file.size > 500 * 1024 * 1024) {
            throw new Error('Video file is too large to transcode entirely in browser memory. Please check audio track selection.');
        }
        onProgress?.(0.15, 'Reading file audio…');
        inputBytes = new Uint8Array(await file.arrayBuffer());
        inputName = `input.${isMkv ? 'mkv' : 'mp4'}`;
    }

    if (signal?.aborted) throw new Error('Transcoding aborted');

    onProgress?.(0.35, 'Initializing WebAssembly encoder…');
    await ffmpeg.writeFile(inputName, inputBytes);

    // Free memory from JS side
    inputBytes = null;

    const outputName = 'output.m4a';

    const progressHandler = ({ progress }) => {
        if (typeof progress === 'number' && progress >= 0 && progress <= 1) {
            const overall = 0.35 + progress * 0.60;
            onProgress?.(Math.min(0.98, overall), `Transcoding to AAC (${Math.round(progress * 100)}%)…`);
        }
    };

    ffmpeg.on('progress', progressHandler);

    try {
        onProgress?.(0.40, 'Transcoding audio to AAC…');
        // Command: extract/transcode to standard 192k stereo AAC (.m4a)
        const args = ['-i', inputName, '-vn', '-c:a', 'aac', '-b:a', '192k', outputName];
        await ffmpeg.exec(args);

        if (signal?.aborted) throw new Error('Transcoding aborted');

        onProgress?.(0.96, 'Finalizing audio track…');
        const outputData = await ffmpeg.readFile(outputName);
        const blob = new Blob([outputData.buffer], { type: 'audio/mp4' });
        const url = URL.createObjectURL(blob);

        const result = { blob, url, trackNumber: targetNumber, codec: 'aac' };
        transcodeCache.set(cacheKey, result);

        onProgress?.(1, 'Audio converted successfully');
        return result;
    } finally {
        ffmpeg.off('progress', progressHandler);
        // Clean up virtual files
        try { await ffmpeg.deleteFile(inputName); } catch {}
        try { await ffmpeg.deleteFile(outputName); } catch {}
    }
}
