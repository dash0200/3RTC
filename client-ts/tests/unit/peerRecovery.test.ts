import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { attachPeerRecovery, type PeerRecoveryEntry } from '../../src/webrtc/peerRecovery.ts';

// A peer connection that never comes back until `heal()`: enough of RTCPeerConnection for the recovery.
class FakePc {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  onconnectionstatechange: (() => void) | null = null;
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
  async setLocalDescription() { /* offer stays answered-less */ }
  set(state: RTCPeerConnectionState) { this.connectionState = state; this.onconnectionstatechange?.(); }
}

function world({ initiator }: { initiator: boolean }) {
  const peersRef = { current: new Map<string, PeerRecoveryEntry>() };
  const log: string[] = [];
  const pcs: FakePc[] = [];
  let cleaned = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket ??= { OPEN: 1 };
  const ws = { readyState: 1 } as unknown as WebSocket;
  const ctx = {
    targetPeerId: 'friend',
    peersRef,
    wsRef: { current: ws },
    sendSignal: () => {},
    logLocalDebug: () => {},
    addSystemMessage: (t: string) => log.push(t),
    showToast: (t: string) => log.push(`toast:${t}`),
    cleanupPeer: (id: string) => { cleaned++; peersRef.current.delete(id); },
    setPeerCount: () => {},
    updateP2PStatus: () => {},
    getOrCreatePeerConnectionRef: { current: null as ((id: string, init: boolean) => PeerRecoveryEntry) | null }
  };
  const create = (id: string, isInitiator: boolean): PeerRecoveryEntry => {
    const pc = new FakePc();
    pcs.push(pc);
    const entry: PeerRecoveryEntry = { pc: pc as unknown as RTCPeerConnection, isInitiator };
    peersRef.current.set(id, entry);
    attachPeerRecovery(pc as unknown as RTCPeerConnection, { ...ctx, peerEntry: entry });
    return entry;
  };
  ctx.getOrCreatePeerConnectionRef.current = create;
  create('friend', initiator);
  return { peersRef, log, pcs, cleaned: () => cleaned, current: () => peersRef.current.get('friend'), pc: () => pcs[pcs.length - 1] };
}

describe('peer recovery: a long drop while both are still in the room', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
  afterEach(() => mock.timers.reset());

  const minutes = async (n: number) => {
    for (let s = 0; s < n * 60; s++) { mock.timers.tick(1000); await Promise.resolve(); }
  };

  it('the side that recovers keeps trying (no "rejoin the room") and the call comes back', async () => {
    const w = world({ initiator: true });
    w.pc().set('connected');
    w.pc().set('disconnected');
    await minutes(10);
    assert.ok(w.current(), 'still trying after 10 minutes');
    assert.ok(!w.log.some((t) => /Could not reconnect|rejoin/i.test(t)), w.log.join(' | '));
    assert.ok(w.pcs.length >= 3, `rebuilt more than once (${w.pcs.length} connections)`);
    assert.equal(w.log.filter((t) => /interrupted/.test(t)).length, 1, 'says "reconnecting" once');
    w.pc().set('connected'); // the network is back
    assert.ok(w.log.some((t) => /restored/.test(t)), w.log.join(' | '));
  });

  it('the other side keeps its end open for the offers', async () => {
    const w = world({ initiator: false });
    w.pc().set('connected');
    w.pc().set('failed');
    await minutes(5);
    assert.ok(w.current(), 'not dropped while the room server still has them');
    assert.equal(w.cleaned(), 0);
  });

  it('when they leave the room (signaling gone) it stops', async () => {
    const w = world({ initiator: true });
    w.pc().set('connected');
    const entry = w.current()!;
    entry.signalingGone = true;
    w.pc().set('disconnected');
    await minutes(1);
    assert.equal(w.current(), undefined);
  });

  it('a connection that never worked still gives up (and says the network may be blocking it)', async () => {
    const w = world({ initiator: true });
    w.pc().set('failed');
    await minutes(5);
    assert.equal(w.current(), undefined);
  });
});
