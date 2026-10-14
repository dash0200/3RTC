// Quick picks filtering: no Shorts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isShort, parseDuration } from '../quickPicks.js';

const video = ({ title = 'A video', description = '', duration = 'PT4M10S', w = 480, h = 270, live = 'none', tags } = {}) => ({
    snippet: { title, description, liveBroadcastContent: live, tags },
    contentDetails: { duration },
    player: { embedWidth: String(w), embedHeight: String(h) }
});

describe('no Shorts in quick picks', () => {
    it('reads YouTube durations', () => {
        assert.equal(parseDuration('PT4M13S'), 253);
        assert.equal(parseDuration('PT1H2M3S'), 3723);
        assert.equal(parseDuration('P0D'), 0);
        assert.equal(parseDuration('nope'), null);
    });
    it('keeps normal landscape videos, including 2-3 minute songs and trailers', () => {
        assert.equal(isShort(video()), false);
        assert.equal(isShort(video({ duration: 'PT2M30S' })), false);
    });
    it('drops vertical or square videos (that is what a Short is)', () => {
        assert.equal(isShort(video({ w: 270, h: 480, duration: 'PT2M50S' })), true);
        assert.equal(isShort(video({ w: 480, h: 480 })), true);
    });
    it('drops anything tagged #shorts, and anything a minute or shorter', () => {
        assert.equal(isShort(video({ title: 'Funny cat #Shorts' })), true);
        assert.equal(isShort(video({ description: 'watch more #short' })), true);
        assert.equal(isShort(video({ tags: ['#shorts'] })), true);
        assert.equal(isShort(video({ duration: 'PT45S' })), true);
    });
    it('keeps live streams (they have no length)', () => {
        assert.equal(isShort(video({ duration: 'P0D', live: 'live' })), false);
    });
});
