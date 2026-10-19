/** Vimeo, through its player API (https://developer.vimeo.com/player/sdk). */
import { loadScript } from './loadScript';
import type { PlayerAdapter, PlayerEmitEvent } from './html5';
import type { VimeoMedia } from '../../../types';

export async function createVimeoAdapter(
  container: HTMLElement,
  media: VimeoMedia,
  emit: (event: PlayerEmitEvent) => void
): Promise<PlayerAdapter> {
  const Vimeo = await loadScript<any>('https://player.vimeo.com/api/player.js', 'Vimeo');
  const box = document.createElement('div');
  box.className = 'link-player-embed';
  container.appendChild(box);
  const player = new Vimeo.Player(box, {
    url: media.url,
    autoplay: false,
    playsinline: true,
    dnt: true,
    title: false,
    byline: false,
    portrait: false
  });
  let paused = true;
  let duration = 0;
  player.on('loaded', async () => {
    duration = await player.getDuration().catch(() => 0);
    emit({ type: 'ready', duration });
  });
  player.on('play', (d: any) => { paused = false; emit({ type: 'play', time: d?.seconds }); });
  player.on('pause', (d: any) => { paused = true; emit({ type: 'pause', time: d?.seconds }); });
  player.on('seeked', (d: any) => emit({ type: 'seek', time: d?.seconds }));
  player.on('ended', () => { paused = true; emit({ type: 'ended' }); });
  player.on('bufferstart', () => emit({ type: 'buffering' }));
  player.on('bufferend', () => emit({ type: 'playing' }));
  player.on('error', (e: any) =>
    emit({
      type: 'error',
      message: e?.name === 'PrivacyError' ? 'This Vimeo video can\'t be played on other sites' : (e?.message || 'Vimeo couldn\'t play this video')
    })
  );
  player.ready().catch((e: any) =>
    emit({
      type: 'error',
      message: e?.name === 'PrivacyError' ? 'This Vimeo video can\'t be played on other sites' : 'Vimeo couldn\'t load this video'
    })
  );

  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (t: number) => player.setCurrentTime(t),
    getTime: () => player.getCurrentTime(),
    isPaused: () => paused,
    isBuffering: () => false,
    getDuration: () => duration,
    isLive: () => false,
    destroy: () => {
      player.destroy().catch(() => { });
      box.remove();
    }
  };
}
