/** The player for each link source (all with the same commands; see ../LinkPlayer.jsx). */
export async function createAdapter(container, media, emit) {
    switch (media.provider) {
        case 'vimeo': return (await import('./vimeo')).createVimeoAdapter(container, media, emit);
        case 'twitch': return (await import('./twitch')).createTwitchAdapter(container, media, emit);
        case 'file':
        case 'hls': return (await import('./html5')).createHtml5Adapter(container, media, emit);
        default: throw new Error(`No player for ${media.provider}`);
    }
}
