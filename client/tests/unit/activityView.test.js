import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextActivityView } from '../../src/features/activities/activityHost.js';

const base = { view: 'full', mediaActive: false, wasMediaActive: false, isPhone: false, activityOpen: true, activityJustOpened: false };

test('a video starting during a game: small window on computers, bubble on phones', () => {
    assert.equal(nextActivityView({ ...base, mediaActive: true }), 'window');
    assert.equal(nextActivityView({ ...base, mediaActive: true, isPhone: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, view: 'bubble', mediaActive: true }), 'bubble', 'already put away: stays');
});

test('the video ending brings the game back', () => {
    assert.equal(nextActivityView({ ...base, view: 'window', wasMediaActive: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'bubble', wasMediaActive: true, isPhone: true }), 'full');
});

test('a game opened while a video plays starts aside; otherwise full; the person\'s choice is kept', () => {
    assert.equal(nextActivityView({ ...base, activityJustOpened: true, mediaActive: true, wasMediaActive: true }), 'window');
    assert.equal(nextActivityView({ ...base, activityJustOpened: true, mediaActive: true, wasMediaActive: true, isPhone: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, activityJustOpened: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'full', mediaActive: true, wasMediaActive: true }), 'full');
    assert.equal(nextActivityView({ ...base, view: 'bubble', mediaActive: true, wasMediaActive: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, view: 'window', isPhone: true, mediaActive: true, wasMediaActive: true }), 'bubble');
    assert.equal(nextActivityView({ ...base, activityOpen: false, view: 'bubble' }), 'full');
});
