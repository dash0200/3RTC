import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLink, normalizeMedia, fallbackTitle, mediaKey } from '../../src/features/media/sources.js';

const media = (text) => {
    const r = detectLink(text);
    assert.ok(r.ok && r.kind === 'media', `${text}: ${JSON.stringify(r)}`);
    return r.media;
};

test('YouTube links stay YouTube', () => {
    for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ']) {
        assert.deepEqual(detectLink(link), { ok: true, kind: 'youtube', videoId: 'dQw4w9WgXcQ' }, link);
    }
    assert.equal(detectLink('https://www.youtube.com/@somechannel').ok, false);
});

test('Vimeo: normal, unlisted, player, channel and showcase links', () => {
    assert.deepEqual(media('https://vimeo.com/76979871'), { provider: 'vimeo', url: 'https://vimeo.com/76979871', id: '76979871' });
    assert.equal(media('vimeo.com/76979871/8272103f6e').url, 'https://vimeo.com/76979871/8272103f6e');
    assert.equal(media('https://player.vimeo.com/video/76979871?h=8272103f6e&badge=0').url, 'https://vimeo.com/76979871/8272103f6e');
    assert.equal(media('https://vimeo.com/channels/staffpicks/76979871').id, '76979871');
    assert.equal(media('https://vimeo.com/showcase/123/video/76979871').id, '76979871');
    assert.equal(detectLink('https://vimeo.com/channels/staffpicks').ok, false);
});

test('Twitch: videos and live channels; clips explained', () => {
    assert.deepEqual(media('https://www.twitch.tv/videos/2190000000'), { provider: 'twitch', url: 'https://www.twitch.tv/videos/2190000000', video: 'v2190000000' });
    assert.deepEqual(media('twitch.tv/SomeStreamer'), { provider: 'twitch', url: 'https://www.twitch.tv/somestreamer', channel: 'somestreamer', live: true });
    assert.equal(media('https://player.twitch.tv/?channel=abc_def&parent=x').channel, 'abc_def');
    assert.equal(media('https://player.twitch.tv/?video=v123456&parent=x').video, 'v123456');
    assert.match(detectLink('https://clips.twitch.tv/FunnySlug').message, /clips/i);
    assert.match(detectLink('https://www.twitch.tv/x/clip/FunnySlug').message, /clips/i);
    assert.equal(detectLink('https://www.twitch.tv/directory').ok, false);
});

test('direct files and HLS streams', () => {
    assert.deepEqual(media('https://cdn.example.com/films/My%20Film.mp4?token=1'), { provider: 'file', url: 'https://cdn.example.com/films/My%20Film.mp4?token=1' });
    assert.equal(media('http://example.com/a.WEBM').provider, 'file');
    assert.equal(media('https://example.com/song.mp3').provider, 'file');
    assert.equal(media('https://example.com/live/index.m3u8').provider, 'hls');
    assert.match(detectLink('https://example.com/stream.mpd').message, /DASH/);
});

test('an unknown page is tried as a video file (checked before loading)', () => {
    const r = detectLink('https://example.com/watch/123');
    assert.equal(r.ok, true);
    assert.equal(r.guessed, true);
    assert.equal(r.media.provider, 'file');
});

test('sites that can\'t be played say why', () => {
    assert.match(detectLink('https://www.netflix.com/watch/80100172').message, /Netflix.*protected/);
    assert.match(detectLink('https://www.hotstar.com/in/movies/x/123').message, /Hotstar/);
    assert.match(detectLink('https://www.instagram.com/reel/abc/').message, /Instagram doesn't/);
    assert.match(detectLink('https://x.com/user/status/1').message, /X doesn't/);
    assert.match(detectLink('https://www.dailymotion.com/video/x8abc').message, /Dailymotion/);
});

test('not links at all', () => {
    for (const text of ['', 'hello there', 'javascript:alert(1)', 'ftp://example.com/a.mp4', 'file:///C:/film.mp4']) {
        assert.equal(detectLink(text).ok, false, text);
    }
});

test('media from other people is rebuilt from its link', () => {
    assert.deepEqual(normalizeMedia({ provider: 'file', url: 'https://vimeo.com/76979871', id: 'evil', title: 'Hi' }),
        { provider: 'vimeo', url: 'https://vimeo.com/76979871', id: '76979871', title: 'Hi' });
    assert.equal(normalizeMedia({ provider: 'file', url: 'javascript:alert(1)' }), null);
    assert.equal(normalizeMedia({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), null, 'YouTube goes through its own messages');
    assert.equal(normalizeMedia(null), null);
    assert.equal(normalizeMedia({ url: 'https://a.com/x.mp4', title: 'x'.repeat(500) }).title.length, 200);
});

test('names and keys', () => {
    assert.equal(fallbackTitle({ provider: 'file', url: 'https://a.com/films/My%20Film.mp4' }), 'My Film.mp4');
    assert.equal(fallbackTitle({ provider: 'twitch', channel: 'abc', url: 'https://www.twitch.tv/abc' }), 'abc on Twitch');
    assert.equal(mediaKey({ provider: 'hls', url: 'https://a.com/x.m3u8' }), 'hls:https://a.com/x.m3u8');
});
