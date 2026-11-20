import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { soundboardGain } from '../../src/features/soundboard/gain.ts';

describe('soundboardGain', () => {
  it('plays nothing when muted, ours or theirs', () => {
    assert.equal(soundboardGain({ muted: true, volume: 0.75 }), 0);
    assert.equal(soundboardGain({ muted: true, volume: 1 }), 0);
  });
  it('plays nothing at 0% and the volume otherwise', () => {
    assert.equal(soundboardGain({ muted: false, volume: 0 }), 0);
    assert.equal(soundboardGain({ muted: false, volume: 0.4 }), 0.4);
    assert.equal(soundboardGain({ muted: false }), 0.75);
    assert.equal(soundboardGain({ muted: false, volume: 3 }), 1);
    assert.equal(soundboardGain(null), 0);
  });
});
