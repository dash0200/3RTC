import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD, BUILD_LABEL, compareBuilds } from '../../src/version.js';

test('builds compare by when they were built', () => {
    assert.equal(compareBuilds('261014.1750', '261015.0900'), -1);
    assert.equal(compareBuilds('261015.0900', '261014.1750'), 1);
    assert.equal(compareBuilds('261014.0959', '261014.1000'), -1); // same day, later time
    assert.equal(compareBuilds('261231.2359', '270101.0000'), -1); // new year
    assert.equal(compareBuilds('261014.1750', '261014.1750'), 0);
});

test('unknown builds never count as older or newer', () => {
    assert.equal(compareBuilds('dev', '261014.1750'), 0);
    assert.equal(compareBuilds(undefined, '261014.1750'), 0);
    assert.equal(compareBuilds('261014.1750', null), 0);
});

test('outside a build (tests, local dev) the app calls itself a development build', () => {
    assert.equal(BUILD.number, 'dev');
    assert.equal(BUILD_LABEL, 'Development build');
});
