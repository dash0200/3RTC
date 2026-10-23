/**
 * Direct video/audio files and HLS (.m3u8) streams, in a plain <video> with the browser's own
 * controls. HLS uses the browser's support where it has it (Safari, iPhone), else hls.js (loaded
 * only when needed).
 */
import type { MediaItem } from '../../../types';

export interface PlayerAdapter {
  play: () => Promise<void> | void;
  pause: () => Promise<void> | void;
  seek: (t: number) => void;
  getTime: () => number | Promise<number>;
  isPaused: () => boolean;
  isBuffering: () => boolean;
  getDuration: () => number;
  isLive: () => boolean;
  destroy: () => void;
}

export type PlayerEmitEvent =
  | { type: 'ready'; duration: number }
  | { type: 'play'; time?: number }
  | { type: 'pause'; time?: number }
  | { type: 'seek'; time?: number }
  | { type: 'ended' }
  | { type: 'buffering' }
  | { type: 'playing' }
  | { type: 'error'; message: string };

const NOT_PLAYABLE = 'This link isn\'t a video the browser can play';

/** Why a direct video link didn't play: gone, private, unreachable, or not a playable format. */
export async function explainLinkFailure(url: string, timeoutMs = 6000): Promise<string> {
  try {
    // One byte is enough to see whether the link answers (a simple range request needs no preflight)
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeoutMs) });
    void res.body?.cancel().catch(() => {});
    if (res.status === 404 || res.status === 410) return 'This link doesn\'t exist any more (the site says 404)';
    if (res.status === 401 || res.status === 403) return 'This link is private: the site won\'t share it with other players';
    if (res.status >= 500) return `The site couldn't send this video right now (error ${res.status})`;
    return NOT_PLAYABLE;
  } catch {
    // Blocked from reading the answer (no CORS) or no answer at all: an opaque request tells them apart
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(timeoutMs) });
      return NOT_PLAYABLE;
    } catch {
      return 'Couldn\'t reach this link: the site may be down, or the address is wrong';
    }
  }
}

export async function createHtml5Adapter(
  container: HTMLElement,
  media: MediaItem,
  emit: (event: PlayerEmitEvent) => void
): Promise<PlayerAdapter> {
  const video = document.createElement('video');
  video.className = 'link-player-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'auto';
  container.appendChild(video);

  let hls: InstanceType<typeof import('hls.js')['default']> | null = null;
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  if (media.provider === 'hls' && !nativeHls) {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) throw new Error('This browser can\'t play HLS streams');
    hls = new Hls({ enableWorker: true });
    hls.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean; type?: string }) => {
      if (data?.fatal) {
        emit({
          type: 'error',
          message: data.type === 'networkError'
            ? 'The stream couldn\'t be loaded (the site may block other players)'
            : 'The stream can\'t be played'
        });
      }
    });
    hls.loadSource(media.url);
    hls.attachMedia(video);
  } else {
    video.src = media.url;
  }

  const on = (type: string, fn: EventListenerOrEventListenerObject): void => video.addEventListener(type, fn);
  on('loadedmetadata', () => emit({ type: 'ready', duration: video.duration }));
  on('play', () => emit({ type: 'play', time: video.currentTime }));
  on('pause', () => { if (!video.ended) emit({ type: 'pause', time: video.currentTime }); });
  on('seeked', () => emit({ type: 'seek', time: video.currentTime }));
  on('ended', () => emit({ type: 'ended' }));
  on('waiting', () => emit({ type: 'buffering' }));
  on('playing', () => emit({ type: 'playing' }));
  on('error', () => {
    if (hls) return;
    // The browser only says "can't play this source" (the same for a dead link and a wrong format):
    // look at the link itself to say which
    void explainLinkFailure(media.url).then((message) => emit({ type: 'error', message }));
  });

  return {
    play: () => video.play(),
    pause: () => video.pause(),
    seek: (t: number) => { video.currentTime = t; },
    getTime: () => video.currentTime,
    isPaused: () => video.paused,
    isBuffering: () => video.seeking || video.readyState < 3,
    getDuration: () => video.duration,
    isLive: () => video.duration === Infinity,
    destroy: () => {
      try { hls?.destroy(); } catch { /* gone */ }
      video.pause();
      video.removeAttribute('src');
      try { video.load(); } catch { /* gone */ }
      video.remove();
    }
  };
}

/** Before telling the room: can this browser open `url` as a video at all? (for guessed links) */
export function probeVideoUrl(url: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      try { v.load(); } catch { /* gone */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    v.onloadedmetadata = () => finish(true);
    v.onerror = () => finish(false);
    v.src = url;
  });
}
