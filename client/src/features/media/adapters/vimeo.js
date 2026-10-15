/** Vimeo, through its player API (https://developer.vimeo.com/player/sdk). */
import { loadScript } from './loadScript';

export async function createVimeoAdapter(container, media, emit) {
    const Vimeo = await loadScript('https://player.vimeo.com/api/player.js', 'Vimeo');
    const box = document.createElement('div');
    box.className = 'link-player-embed';
    container.appendChild(box);
    const player = new Vimeo.Player(box, { url: media.url, autoplay: false, playsinline: true, dnt: true, title: false, byline: false, portrait: false });
    let paused = true;
    let duration = 0;
    player.on('loaded', async () => {
        duration = await player.getDuration().catch(() => 0);
        emit({ type: 'ready', duration });
    });
    player.on('play', (d) => { paused = false; emit({ type: 'play', time: d?.seconds }); });
    player.on('pause', (d) => { paused = true; emit({ type: 'pause', time: d?.seconds }); });
    player.on('seeked', (d) => emit({ type: 'seek', time: d?.seconds }));
    player.on('ended', () => { paused = true; emit({ type: 'ended' }); });
    player.on('bufferstart', () => emit({ type: 'buffering' }));
    player.on('bufferend', () => emit({ type: 'playing' }));
    player.on('error', (e) => emit({ type: 'error', message: e?.name === 'PrivacyError' ? 'This Vimeo video can\'t be played on other sites' : (e?.message || 'Vimeo couldn\'t play this video') }));
    player.ready().catch((e) => emit({ type: 'error', message: e?.name === 'PrivacyError' ? 'This Vimeo video can\'t be played on other sites' : 'Vimeo couldn\'t load this video' }));

    return {
        play: () => player.play(),
        pause: () => player.pause(),
        seek: (t) => player.setCurrentTime(t),
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
