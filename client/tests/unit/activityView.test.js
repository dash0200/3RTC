import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextActivityView, snapSpot, bubbleXY } from '../../src/features/activities/activityHost.js';

const base = { view: 'full', mediaActive: false, wasMediaActive: false, isPhone: false, activityOpen: true, activityJustOpened: false };

test('a video starting during a game: docked in sidebar on computers, bubble on phones', () => {
    assert.equal(nextActivityView({ ...base, mediaActive: true }), 'sidebar');
    assert.equal(nextActivityView({ ...base, mediaActive: true, isPhone: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, view: 'bubble', mediaActive: true }), 'bubble', 'already put away: stays');
});

test('the video ending brings the game back', () => {
    assert.equal(nextActivityView({ ...base, view: 'sidebar', wasMediaActive: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'window', wasMediaActive: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'bubble', wasMediaActive: true, isPhone: true }), 'full');
});

test('a game opened while a video plays starts aside; otherwise full; the person\'s choice is kept', () => {
    assert.equal(nextActivityView({ ...base, activityJustOpened: true, mediaActive: true, wasMediaActive: true }), 'sidebar');
    assert.equal(nextActivityView({ ...base, activityJustOpened: true, mediaActive: true, wasMediaActive: true, isPhone: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, activityJustOpened: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'full', mediaActive: true, wasMediaActive: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'bubble', mediaActive: true, wasMediaActive: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, view: 'window', isPhone: true, mediaActive: true, wasMediaActive: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, view: 'sidebar', isPhone: true, mediaActive: true, wasMediaActive: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, activityOpen: false, view: 'bubble' }), 'full');
});

test('the bubble snaps to the nearest side edge and stays on screen', () => {
    // Let go left of the middle: left edge; right of it: right edge
    assert.deepEqual(snapSpot(100, 300, 50, 390, 800), { side: 'left', y: 300 / 800 });
    assert.equal(snapSpot(200, 300, 50, 390, 800).side, 'right');
    // Above the top or below the bottom: kept on screen
    assert.equal(snapSpot(0, -80, 50, 390, 800).y, 10 / 800);
    assert.equal(snapSpot(0, 2000, 50, 390, 800).y, 740 / 800);
    // Back to screen px, also after the screen gets smaller (rotated)
    assert.deepEqual(bubbleXY({ side: 'left', y: 0.5 }, 50, 390, 800), { x: 10, y: 400 });
    assert.deepEqual(bubbleXY({ side: 'right', y: 0.5 }, 50, 390, 800), { x: 330, y: 400 });
    assert.deepEqual(bubbleXY({ side: 'right', y: 0.95 }, 50, 800, 390), { x: 740, y: 330 });
});
