import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveness, SIGNAL_LIVENESS } from '../../src/webrtc/liveness.ts';

// A fake clock: timers run when time is moved on
function world({ hidden = false, sendOk = true } = {}) {
  let t = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const sent: number[] = [];
  let dead = 0;
  const state = { hidden, sendOk };
  const live = createLiveness({
    sendPing: () => { sent.push(t); return state.sendOk; },
    isHidden: () => state.hidden,
    onDead: () => { dead++; },
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); }
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((x) => x !== due);
      t = due.at;
      due.fn();
    }
    t = end;
  };
  return { live, advance, sent, state, deadCount: () => dead };
}

const { answerWithinMs, minProbeGapMs } = SIGNAL_LIVENESS;

describe('signaling liveness', () => {
  it('an answered ping keeps the socket', () => {
    const w = world();
    w.live.probe(true);
    w.advance(100);
    w.live.heard();
    w.advance(answerWithinMs * 3);
    assert.equal(w.deadCount(), 0);
  });

  it('an unanswered ping means the socket is dead (once)', () => {
    const w = world();
    w.live.probe(true);
    w.advance(answerWithinMs - 1);
    assert.equal(w.deadCount(), 0);
    w.advance(1);
    assert.equal(w.deadCount(), 1);
    w.live.probe(true);
    w.advance(answerWithinMs * 2);
    assert.equal(w.deadCount(), 1, 'not again');
  });

  it('a ping the socket refuses means dead at once', () => {
    const w = world({ sendOk: false });
    w.live.probe(true);
    assert.equal(w.deadCount(), 1);
  });

  it('in a background tab it waits once more before giving up', () => {
    const w = world({ hidden: true });
    w.live.probe(true);
    w.advance(answerWithinMs);
    assert.equal(w.deadCount(), 0);
    w.advance(answerWithinMs);
    assert.equal(w.deadCount(), 1);

    const late = world({ hidden: true });
    late.live.probe(true);
    late.advance(answerWithinMs + 10);
    late.live.heard(); // the answer was only held back
    late.advance(answerWithinMs);
    assert.equal(late.deadCount(), 0);
  });

  it('network-change probes are spaced out; the keep-alive always goes', () => {
    const w = world();
    w.live.probe();
    w.live.heard();
    w.live.probe();
    w.live.probe();
    assert.equal(w.sent.length, 1, 'a burst of change events sends one ping');
    w.live.probe(true);
    assert.equal(w.sent.length, 2, 'the keep-alive is not skipped');
    w.advance(minProbeGapMs);
    w.live.probe();
    assert.equal(w.sent.length, 3);
  });

  it('stop() ends the checks', () => {
    const w = world();
    w.live.probe(true);
    w.live.stop();
    w.advance(answerWithinMs * 3);
    assert.equal(w.deadCount(), 0);
  });
});
