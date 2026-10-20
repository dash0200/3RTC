import { extractMkvSubtitles, extractMkvPgsSubtitles, type SubtitleCue } from './mkv';
import type { SubtitleFormat } from './formats';
import { cuesToWebVTT } from '../../utils/subtitleParser';

export interface PgsExtractionResult {
  isPgs: true;
  supBytes: Uint8Array;
  trackNumber: number;
}

export type ExtractedSubtitleResult = SubtitleCue[] | PgsExtractionResult;

export const isPgsTrack = (track: SubtitleFormat | null | undefined): boolean =>
  Boolean(track) &&
  (track?.codec === 'S_HDMV/PGS' || /pgs/i.test(track?.codec || '') || /pgs/i.test(track?.label || ''));

/** Can we turn this track (from format.subtitles) into subtitles the player can display? */
export const canExtract = (track: SubtitleFormat | null | undefined): boolean =>
  Boolean(track) && (track?.kind === 'text' || isPgsTrack(track)) && !track?.embeddedMp4;

interface WorkerSuccessPgs {
  done: true;
  isPgs: true;
  supBytes: Uint8Array;
  trackNumber: number;
}

interface WorkerSuccessText {
  done: true;
  isPgs?: false;
  cues: [number, SubtitleCue[]][];
}

interface WorkerProgress {
  progress: number;
}

interface WorkerError {
  error: string;
}

type WorkerResponse = (WorkerSuccessPgs | WorkerSuccessText | WorkerProgress | WorkerError) & {
  done?: boolean;
  progress?: number;
  error?: string;
  isPgs?: boolean;
  supBytes?: Uint8Array;
  trackNumber?: number;
  cues?: [number, SubtitleCue[]][];
};

function runInWorker(
  file: Blob,
  tracks: Array<{ number: number; codecId: string }>,
  timecodeScale: number,
  onProgress: ((p: number) => void) | undefined,
  isPgs: boolean,
  trackNumber: number
): Promise<PgsExtractionResult | Map<number, SubtitleCue[]>> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./subtitleWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.progress !== undefined) onProgress?.(data.progress);
      if (data.done) {
        worker.terminate();
        if (data.isPgs && data.supBytes) {
          resolve({ isPgs: true, supBytes: data.supBytes, trackNumber: data.trackNumber ?? trackNumber });
        } else if (data.cues) {
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

export interface ExtractSubtitleTrackOptions {
  timecodeScale?: number;
  onProgress?: (progress: number) => void;
}

/**
 * The cues of one subtitle track: [{ startSec, endSec, text }] OR { isPgs: true, supBytes, trackNumber }.
 */
export async function extractSubtitleTrack(
  file: Blob,
  track: SubtitleFormat,
  { timecodeScale = 1000000, onProgress }: ExtractSubtitleTrackOptions = {}
): Promise<ExtractedSubtitleResult> {
  const isPgs = isPgsTrack(track);
  const tracks = [{ number: track.number, codecId: track.codec }];
  let result: PgsExtractionResult | Map<number, SubtitleCue[]>;
  try {
    result = await runInWorker(file, tracks, timecodeScale, onProgress, isPgs, track.number);
  } catch (err: unknown) {
    const errorObj = err as { message?: string };
    if (typeof Worker !== 'undefined' && !/worker/i.test(String(errorObj?.message))) throw err;
    // Fallback: read on this thread
    const readAt = async (pos: number, len: number): Promise<Uint8Array> =>
      new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
    if (isPgs) {
      const supBytes = await extractMkvPgsSubtitles(readAt, file.size, track.number, { timecodeScale, onProgress });
      return { isPgs: true, supBytes, trackNumber: track.number };
    }
    const cues = await extractMkvSubtitles(readAt, file.size, tracks, { timecodeScale, onProgress });
    return cues.get(track.number) || [];
  }

  if ('isPgs' in result && result.isPgs) {
    return result;
  }
  return (result as Map<number, SubtitleCue[]>).get(track.number) || [];
}

export const cuesToVtt = (cues: SubtitleCue[]): string => cuesToWebVTT(cues);
