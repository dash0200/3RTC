/** The player for each link source (all with the same commands; see ../LinkPlayer.jsx). */
import type { MediaItem } from '../../../types';
import type { PlayerAdapter, PlayerEmitEvent } from './html5';

export * from './html5';
export * from './loadScript';
export * from './twitch';
export * from './vimeo';

export async function createAdapter(
  container: HTMLElement,
  media: MediaItem,
  emit: (event: PlayerEmitEvent) => void
): Promise<PlayerAdapter> {
  switch (media.provider) {
    case 'vimeo':
      return (await import('./vimeo')).createVimeoAdapter(container, media, emit);
    case 'twitch':
      return (await import('./twitch')).createTwitchAdapter(container, media, emit);
    case 'file':
    case 'hls':
      return (await import('./html5')).createHtml5Adapter(container, media, emit);
    default:
      throw new Error(`No player for ${(media as { provider: string }).provider}`);
  }
}
