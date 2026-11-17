import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostChangeNotice } from '../../src/webrtc/hostChange.ts';

describe('host migration (web)', () => {
  it('the host left: everyone is told who the host is now, with no one "making" them host', () => {
    assert.deepEqual(hostChangeNotice({ hostPeerId: 'a', reason: 'host-left' }), { host: 'a', from: null });
  });
  it('a hand-over still names who did it', () => {
    assert.deepEqual(hostChangeNotice({ hostPeerId: 'a', from: 'h' }), { host: 'a', from: 'h' });
  });
  it('a plain host update (joining, the host coming back) says nothing', () => {
    assert.equal(hostChangeNotice({ hostPeerId: 'h' }), null);
    assert.equal(hostChangeNotice({ hostPeerId: null, reason: 'host-left' }), null);
    assert.equal(hostChangeNotice({ hostPeerId: 'h', reason: 'something-new' }), null);
  });
});
