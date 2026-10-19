/**
 * In-browser WebAssembly Audio Transcoder (e.g. E-AC-3 / AC-3 -> AAC).
 * Runs single-threaded FFmpeg WASM inside a Web Worker so the UI never stutters.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { extractMkvAudioTrack } from '../files/mkv';
import type { FileFormat } from '../files/formats';

export interface TranscodeResult {
  blob: Blob;
  url: string;
  trackNumber: number;
  codec: string;
}

// Cache of transcoded audio by file signature: key -> { blob, url, trackNumber, codec }
const transcodeCache = new Map<string, TranscodeResult>();

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

const readerFor = (file: Blob) => async (pos: number, len: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());

/**
 * Initializes and loads the WebAssembly FFmpeg core.
 * Attempts local assets first, then falls back to jsdelivr CDN.
 */
export async function getFFmpeg(onLog?: (message: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) {
      ffmpeg.on('log', ({ message }: { message: string }) => onLog(message));
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
      } catch (cdnErr: unknown) {
        const errMessage = cdnErr instanceof Error ? cdnErr.message : 'Network error';
        throw new Error(`Failed to load audio transcoding engine: ${errMessage}`);
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

export function getAudioExtension(codec?: string): string {
  const c = (codec || '').toLowerCase();
  if (c.includes('eac3') || c.includes('ec-3') || c.includes('dolby digital plus')) return 'eac3';
  if (c.includes('ac3') || c.includes('ac-3') || c.includes('dolby')) return 'ac3';
  if (c.includes('aac')) return 'aac';
  if (c.includes('dts')) return 'dts';
  if (c.includes('mp3') || c.includes('mpeg')) return 'mp3';
  if (c.includes('flac')) return 'flac';
  if (c.includes('opus')) return 'opus';
  if (c.includes('vorbis') || c.includes('ogg')) return 'ogg';
  return 'audio';
}

export interface TranscodeAudioOptions {
  format?: FileFormat | null;
  trackNumber?: number | null;
  onProgress?: (progress: number, stage: string) => void;
  signal?: AbortSignal;
}

/**
 * Transcode an unsupported audio track (e.g. E-AC-3) in the video file to AAC (.m4a).
 */
export async function transcodeAudioTrack(
  file: File,
  { format, trackNumber, onProgress, signal }: TranscodeAudioOptions = {}
): Promise<TranscodeResult> {
  if (!file) throw new Error('No video file provided');

  // Pick target audio track
  const audioTracks = format?.audio || [];
  const targetTrack = trackNumber !== undefined && trackNumber !== null
    ? audioTracks.find((a) => a.number === trackNumber) || audioTracks[0]
    : audioTracks[0];

  const targetNumber = targetTrack?.number ?? 1;
  const cacheKey = `${file.name}-${file.size}-${file.lastModified}-${targetNumber}`;

  const cached = transcodeCache.get(cacheKey);
  if (cached) {
    onProgress?.(1, 'Ready');
    return cached;
  }

  if (signal?.aborted) throw new Error('Transcoding aborted');

  onProgress?.(0.02, 'Preparing transcoder…');
  const ffmpeg = await getFFmpeg();

  if (signal?.aborted) throw new Error('Transcoding aborted');

  const ext = getAudioExtension(targetTrack?.codec);
  let inputName = `input.${ext}`;
  let inputBytes: Uint8Array | null = null;

  const isMkv = format?.container === 'matroska' || format?.container === 'webm' || /\.mkv$/i.test(file.name);

  if (isMkv && targetTrack?.number !== undefined) {
    onProgress?.(0.05, 'Extracting audio bitstream…');
    const readAt = readerFor(file);
    inputBytes = await extractMkvAudioTrack(readAt, file.size, targetTrack.number, {
      codec: targetTrack.codec,
      codecPrivate: targetTrack.codecPrivate,
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

  const outputName = 'output.m4a';
  onProgress?.(0.35, 'Initializing WebAssembly encoder…');
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}
  await ffmpeg.writeFile(inputName, inputBytes);

  // Free memory from JS side
  inputBytes = null;

  const logs: string[] = [];

  const logHandler = ({ message }: { message: string }): void => {
    logs.push(message);
    if (logs.length > 40) logs.shift();
  };

  const progressHandler = ({ progress }: { progress: number }): void => {
    if (typeof progress === 'number' && progress >= 0 && progress <= 1) {
      const overall = 0.35 + progress * 0.60;
      onProgress?.(Math.min(0.98, overall), `Transcoding to AAC (${Math.round(progress * 100)}%)…`);
    }
  };

  ffmpeg.on('log', logHandler);
  ffmpeg.on('progress', progressHandler);

  try {
    onProgress?.(0.40, 'Transcoding audio to AAC…');
    const isContainerInput = inputName.endsWith('.mp4') || inputName.endsWith('.mkv');
    const audioIndex = audioTracks.findIndex((a) => a.number === targetNumber);
    const mapArgs = isContainerInput
      ? ['-map', `0:a:${audioIndex >= 0 ? audioIndex : 0}`]
      : [];
    // Command: extract/transcode to standard 192k stereo AAC (.m4a)
    const args = ['-y', '-i', inputName, ...mapArgs, '-vn', '-c:a', 'aac', '-b:a', '192k', outputName];
    const exitCode = await ffmpeg.exec(args);

    if (signal?.aborted) throw new Error('Transcoding aborted');
    if (exitCode !== 0) {
      const lastLog = logs.slice(-4).join('; ');
      throw new Error(`FFmpeg transcoding failed (code ${exitCode}): ${lastLog || 'Unknown error'}`);
    }

    onProgress?.(0.96, 'Finalizing audio track…');
    const outputData = await ffmpeg.readFile(outputName);
    const outputBytes = typeof outputData === 'string'
      ? new TextEncoder().encode(outputData)
      : outputData;
    const blob = new Blob([outputBytes.buffer as ArrayBuffer], { type: 'audio/mp4' });
    const url = URL.createObjectURL(blob);

    const result: TranscodeResult = { blob, url, trackNumber: targetNumber, codec: 'aac' };
    transcodeCache.set(cacheKey, result);

    onProgress?.(1, 'Audio converted successfully');
    return result;
  } finally {
    ffmpeg.off('log', logHandler);
    ffmpeg.off('progress', progressHandler);
    // Clean up virtual files
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}
