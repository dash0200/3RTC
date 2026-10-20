/** Reads a whole MKV in the background and sends back the text or PGS bitstream of its subtitle tracks. */
import { extractMkvSubtitles, extractMkvPgsSubtitles } from './mkv';

interface SubtitleWorkerInput {
  file: Blob;
  tracks: Array<{ number: number; codecId: string }>;
  timecodeScale?: number;
  isPgs?: boolean;
  trackNumber: number;
}

self.onmessage = async ({ data }: MessageEvent<SubtitleWorkerInput>) => {
  const { file, tracks, timecodeScale, isPgs, trackNumber } = data;
  const readAt = async (pos: number, len: number): Promise<Uint8Array> =>
    new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());

  const postWorkerMessage = (message: unknown, transfer?: Transferable[]): void => {
    (self as unknown as Worker).postMessage(message, transfer ?? []);
  };

  try {
    let last = 0;
    if (isPgs) {
      const supBytes = await extractMkvPgsSubtitles(readAt, file.size, trackNumber, {
        timecodeScale,
        onProgress: (p) => {
          if (p - last >= 0.02 || p === 1) {
            last = p;
            postWorkerMessage({ progress: p });
          }
        }
      });
      postWorkerMessage({ done: true, isPgs: true, supBytes, trackNumber }, [supBytes.buffer as ArrayBuffer]);
      return;
    }

    const cues = await extractMkvSubtitles(readAt, file.size, tracks, {
      timecodeScale,
      onProgress: (p) => {
        if (p - last >= 0.02 || p === 1) {
          last = p;
          postWorkerMessage({ progress: p });
        }
      }
    });
    postWorkerMessage({ done: true, cues: [...cues.entries()] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err || 'Could not read the subtitles');
    postWorkerMessage({ error: message });
  }
};
