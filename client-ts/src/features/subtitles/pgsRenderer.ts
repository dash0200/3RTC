/**
 * In-browser WebAssembly PGS (Presentation Graphic Stream) subtitle renderer using libbitsub.
 * Renders Blu-ray BD-PGS bitmap subtitles on an overlay canvas synchronized with HTML5 video.
 */

import type { PgsRenderer, VideoSubtitleOptions } from 'libbitsub';

let libbitsubPromise: Promise<typeof PgsRenderer> | null = null;

export async function getPgsRendererClass(): Promise<typeof PgsRenderer> {
  if (!libbitsubPromise) {
    libbitsubPromise = (async () => {
      const mod = await import('libbitsub');
      if (typeof mod.initWasm === 'function') {
        await mod.initWasm();
      }
      return mod.PgsRenderer;
    })();
  }
  return libbitsubPromise;
}

export interface CreatePgsRendererOptions {
  video: HTMLVideoElement;
  canvas?: HTMLCanvasElement;
  supBytes: Uint8Array | ArrayBuffer;
  onLoaded?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Creates and initializes a PgsRenderer instance.
 */
export async function createPgsRenderer({
  video,
  canvas,
  supBytes,
  onLoaded,
  onError
}: CreatePgsRendererOptions): Promise<PgsRenderer> {
  if (!video || !supBytes) {
    throw new Error('Missing video or supBytes for PGS renderer');
  }

  const PgsRendererClass = await getPgsRendererClass();
  const buffer =
    supBytes instanceof Uint8Array
      ? supBytes.buffer.slice(supBytes.byteOffset, supBytes.byteOffset + supBytes.byteLength)
      : supBytes;

  const options: VideoSubtitleOptions = {
    video,
    subContent: buffer as ArrayBuffer,
    onLoaded: () => {
      onLoaded?.();
    },
    onError: (err: Error) => {
      console.error('[libbitsub] PGS rendering error:', err);
      onError?.(err);
    }
  };
  if (canvas) {
    options.canvas = canvas;
  }

  const renderer = new PgsRendererClass(options);
  return renderer;
}
