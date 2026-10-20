/** Twitch videos and live channels (https://dev.twitch.tv/docs/embed/video-and-clips/). */
import { loadScript } from './loadScript';
import type { PlayerAdapter, PlayerEmitEvent } from './html5';
import type { TwitchMedia } from '../../../types';

interface TwitchPlayerInstance {
  addEventListener(event: string, callback: (data?: { position?: number }) => void): void;
  play(): void;
  pause(): void;
  seek(timestamp: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
}

interface TwitchSDK {
  Player: (new (elementId: string, options: Record<string, unknown>) => TwitchPlayerInstance) & {
    READY: string;
    PLAY: string;
    PAUSE: string;
    SEEK?: string;
    ENDED: string;
    OFFLINE?: string;
  };
}

let seq = 0;

export async function createTwitchAdapter(
  container: HTMLElement,
  media: TwitchMedia,
  emit: (event: PlayerEmitEvent) => void
): Promise<PlayerAdapter> {
  const Twitch = await loadScript<TwitchSDK>('https://player.twitch.tv/js/embed/v1.js', 'Twitch');
  const box = document.createElement('div');
  box.className = 'link-player-embed';
  box.id = `twitch-player-${++seq}`;
  container.appendChild(box);
  const live = Boolean(media.channel);
  const player = new Twitch.Player(box.id, {
    width: '100%',
    height: '100%',
    autoplay: false, // LinkPlayer starts it once ready
    parent: [window.location.hostname],
    ...(live ? { channel: media.channel } : { video: media.video })
  });
  const P = Twitch.Player;
  player.addEventListener(P.READY, () => emit({ type: 'ready', duration: live ? Infinity : player.getDuration?.() }));
  player.addEventListener(P.PLAY, () => emit({ type: 'play', time: player.getCurrentTime?.() }));
  player.addEventListener(P.PAUSE, () => emit({ type: 'pause', time: player.getCurrentTime?.() }));
  if (P.SEEK) player.addEventListener(P.SEEK, (d?: { position?: number }) => emit({ type: 'seek', time: d?.position ?? player.getCurrentTime?.() }));
  player.addEventListener(P.ENDED, () => emit({ type: 'ended' }));
  if (P.OFFLINE) player.addEventListener(P.OFFLINE, () => emit({ type: 'error', message: `${media.channel} isn't live right now` }));

  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (t: number) => { if (!live) player.seek(t); },
    getTime: () => (live ? 0 : player.getCurrentTime()),
    isPaused: () => player.isPaused(),
    isBuffering: () => false,
    getDuration: () => (live ? Infinity : player.getDuration()),
    isLive: () => live,
    destroy: () => {
      try { player.pause(); } catch { /* gone */ }
      box.remove();
    }
  };
}
