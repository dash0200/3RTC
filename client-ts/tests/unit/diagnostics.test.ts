import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, ceilingKbps, reportText } from '../../src/features/diagnostics/verdict';
import type { PhaseResult, StreamTestReport } from '../../src/features/diagnostics/speedTest';
import type { LiveSnapshot, Rates } from '../../src/features/diagnostics/telemetry';
import * as telemetry from '../../src/features/diagnostics/telemetry';
import { percentile } from '../../src/features/diagnostics/speedTest';

const rates = (extra: Partial<Rates> = {}): Rates => ({
  seconds: 120,
  sendKbps: 0,
  recvKbps: 0,
  drainWaitPct: 0,
  readMsAvg: null,
  reads: 0,
  blocksDone: 0,
  blockLatencyMs: { p50: null, p95: null, max: null, samples: 0 },
  playerWaits: 0,
  playerWaitMs: 0,
  reasks: 0,
  stalls: 0,
  stallMs: 0,
  ...extra
});

const live = (extra: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  at: 0,
  windowS: 120,
  watching: null,
  sharing: { viewers: 0, relays: 0, fileSize: null, bitrateKbps: null },
  video: { present: false, paused: null, durationS: null, currentS: null, bufferedAheadS: null, resolution: null, droppedFrames: null, totalFrames: null },
  recent: rates({ seconds: 10 }),
  overall: rates(),
  ...extra
});

const pair = (localType = 'srflx', remoteType = 'srflx', protocol = 'udp') => ({
  at: 0,
  iceState: 'connected',
  connectionState: 'connected',
  pair: {
    localType, remoteType, protocol, relayProtocol: null, networkType: null, localIsPrivate: true, localIsIpv6: false,
    currentRttMs: 150, avgRttMs: 150, availableOutgoingKbps: null, availableIncomingKbps: null,
    bytesSent: 0, bytesReceived: 0, packetsSent: null, packetsReceived: null, requestsSent: null, responsesReceived: null
  },
  candidatePairs: 4,
  selectedPairChanges: 1,
  audio: null,
  dataChannels: []
});

function phase(direction: 'download' | 'upload', highKB: number, kbps: number, extra: Partial<PhaseResult> = {}, gaps: number[] = []): PhaseResult {
  return {
    direction,
    high: highKB * 1024,
    low: (highKB * 1024) / 2,
    meter: {
      frames: 100, bytes: 1, outOfOrder: 0, firstAtMs: 0, spanMs: 4000, rateKbps: kbps, steadyKbps: kbps,
      maxGapMs: Math.max(20, ...gaps), gaps: gaps.map((ms, i) => ({ atMs: i * 500, ms })), bins: []
    },
    sender: { frames: 100, bytes: 1, durationMs: 4000, blockedPct: 80, maxBufferedKB: highKB, high: highKB * 1024, low: 0, stoppedEarly: null, drainMs: 0, leftKB: 0 },
    loadedPing: { samples: [], p50: 160, p95: 170, lost: 0 },
    networkRtt: [151, 152],
    audioLossInPct: 0,
    linkBefore: null,
    linkAfter: null,
    remoteLinkAfter: null,
    error: null,
    ...extra
  };
}

function report(phases: PhaseResult[], extra: Partial<StreamTestReport> = {}): StreamTestReport {
  const dev = { browser: 'Chrome 140', platform: 'Windows', cores: 8, memoryGb: 8, phoneLike: false, connection: null, hidden: false };
  return {
    version: 1,
    startedAt: '2026-10-20T15:00:00Z',
    durationMs: 30000,
    peer: { id: 'p2', name: 'Ben' },
    self: { name: 'Asha' },
    local: { device: dev, live: live(), linkStart: pair(), linkEnd: pair() },
    remote: { device: dev, live: live(), linkStart: pair(), linkEnd: pair(), v: 1 },
    idlePing: { samples: [150, 150, 151], lost: 0, min: 148, p50: 150, p95: 155, max: 156, jitterMs: 2 },
    phases,
    streamingDuringTest: false,
    aborted: null,
    ...extra
  };
}

const ids = (r: StreamTestReport) => analyze(r).findings.map((f) => f.id);

describe('stream doctor verdicts', () => {
  it('ceiling: 192 KB per 150 ms round trip is about 10.5 Mbps', () => {
    assert.equal(ceilingKbps(192 * 1024, 150), 10486);
  });

  it('spots the send buffer as the limit when a bigger buffer is much faster', () => {
    const r = report([
      phase('download', 192, 9800),
      phase('download', 1024, 30000),
      phase('download', 4096, 41000),
      phase('upload', 192, 9500),
      phase('upload', 4096, 12000)
    ]);
    const v = analyze(r);
    assert.ok(ids(r).includes('buffer-download'));
    assert.ok(!ids(r).includes('buffer-upload')); // 12 vs 9.5 Mbps: under the 35% bar
    assert.equal(v.severity, 'bad');
    assert.match(v.headline, /192 KB send buffer/);
    assert.equal(v.numbers.downBestKbps, 41000);
  });

  it('says the buffer is fine when a bigger one does not help, and flags a full link', () => {
    const full = phase('download', 4096, 6100, { loadedPing: { samples: [], p50: 400, p95: 520, lost: 0 }, networkRtt: [150, 260, 330] });
    const r = report([phase('download', 192, 6000), phase('download', 1024, 6050), full]);
    const found = ids(r);
    assert.ok(found.includes('buffer-ok-download'));
    assert.ok(found.includes('full-download'));
    assert.ok(found.includes('control-delay-download'));
    assert.ok(!found.includes('window-download')); // the network was full: not the transport window
  });

  it('a slow app ping alone is not a full network; same speed at every setting points at the transport window', () => {
    const r = report([
      phase('download', 192, 5000, { loadedPing: { samples: [], p50: 300, p95: 450, lost: 0 } }),
      phase('download', 4096, 5200)
    ]);
    const found = ids(r);
    assert.ok(!found.includes('full-download'));
    assert.ok(found.includes('control-delay-download'));
    assert.ok(found.includes('window-download'));
  });

  it('does not blame the buffer when today\'s speed is far below what 192 KB allows', () => {
    // 150 ms ping: 192 KB allows ~10.5 Mbps; 3.6 Mbps is something else
    const r = report([phase('download', 192, 3600), phase('download', 4096, 6500)]);
    assert.ok(!ids(r).includes('buffer-download'));
  });

  it('ignores warm-up steps and takes the better of the two runs at today\'s setting', () => {
    const r = report([
      phase('download', 1024, 500, { warmup: true }),
      phase('download', 192, 4000),
      phase('download', 4096, 9800),
      phase('download', 192, 9500)
    ]);
    const v = analyze(r);
    assert.equal(v.numbers.downNowKbps, 9500);
    assert.ok(!ids(r).includes('buffer-download'));
  });

  it('finds pauses from lost packets', () => {
    const r = report([phase('download', 192, 9000), phase('download', 4096, 20000, {}, [700, 900, 1800])]);
    const f = analyze(r).findings.find((x) => x.id === 'pauses-download');
    assert.ok(f);
    assert.equal(f!.severity, 'bad'); // longest pause over 1.5 s
  });

  it('compares with the video: fixable vs too big', () => {
    const watching = live({
      watching: { role: 'watching', fileSize: 2e9, ownerId: 'p2', startedAt: 0, bitrateKbps: 12000 }
    });
    const fixable = report([phase('download', 192, 9000), phase('download', 4096, 30000)], {
      local: { ...report([]).local, live: watching }
    });
    assert.ok(ids(fixable).includes('video-fits-with-fix'));
    assert.equal(analyze(fixable).numbers.videoDirection, 'download');
    const tooBig = report([phase('download', 192, 9000), phase('download', 4096, 9500)], {
      local: { ...report([]).local, live: watching }
    });
    assert.ok(ids(tooBig).includes('video-too-big'));
  });

  it('uses the upload direction when I am the one sharing', () => {
    const sharing = live({ sharing: { viewers: 1, relays: 0, fileSize: 1e9, bitrateKbps: 5000 } });
    const r = report([phase('upload', 192, 8000), phase('upload', 4096, 8100)], { local: { ...report([]).local, live: sharing } });
    const v = analyze(r);
    assert.equal(v.numbers.videoDirection, 'upload');
    assert.ok(ids(r).includes('video-fits'));
  });

  it('flags relays, TCP, slow disks, stalls and an unsteady ping', () => {
    const r = report([phase('download', 192, 9000)], {
      local: {
        ...report([]).local,
        linkStart: pair('relay', 'srflx', 'tcp'),
        live: live({
          sharing: { viewers: 1, relays: 0, fileSize: 1e9, bitrateKbps: 5000 },
          overall: rates({ readMsAvg: 150, reads: 40, sendKbps: 3000 })
        })
      },
      remote: {
        ...report([]).remote,
        live: live({
          watching: { role: 'watching', fileSize: 1e9, ownerId: 'p1', startedAt: 0, bitrateKbps: 5000 },
          overall: rates({ stalls: 4, stallMs: 9000, recvKbps: 2000 })
        })
      },
      idlePing: { samples: [], lost: 2, min: 90, p50: 150, p95: 420, max: 600, jitterMs: 80 }
    });
    const found = ids(r);
    for (const id of ['relay', 'tcp', 'disk-you', 'stalls-Ben', 'unsteady-ping', 'high-ping']) assert.ok(found.includes(id), id);
  });

  it('reports freezes: a ping of many seconds or a step with no answer', () => {
    const frozen = phase('download', 384, 100, { loadedPing: { samples: [{ atMs: 0, rttMs: 26113 }], p50: 11000, p95: 26113, lost: 0 } });
    const r = report([phase('download', 1024, 900, { warmup: true, error: 'no answer from the other side' }), frozen]);
    const v = analyze(r);
    assert.equal(v.findings[0].id, 'freeze');
    assert.match(v.findings[0].title, /26 s/);
  });

  it('writes a copyable report with the raw numbers', () => {
    const r = report([phase('download', 192, 9800), phase('download', 4096, 41000)]);
    const text = reportText(r, analyze(r));
    assert.match(text, /Verdict: /);
    assert.match(text, /download\s+192 KB\s+9\.8 Mbps/);
    assert.match(text, /"phases"/);
  });
});

describe('stream telemetry', () => {
  beforeEach(() => telemetry.resetTelemetry());
  it('adds up sends, waits, reads and block latency', () => {
    telemetry.noteShareStart('k', 1000, 'a.mp4');
    telemetry.noteSent(125000);
    telemetry.noteDrainWait(500);
    telemetry.noteRead(30);
    telemetry.noteRead(50);
    for (const ms of [100, 200, 300, 4000]) telemetry.noteBlockDone(ms);
    const s = telemetry.liveSnapshot();
    assert.equal(s.sharing.viewers, 1);
    // 1 Mbit in the second since it started (two seconds if the clock ticked over meanwhile)
    assert.ok([500, 1000].includes(s.recent.sendKbps), String(s.recent.sendKbps));
    assert.ok([25, 50].includes(s.recent.drainWaitPct), String(s.recent.drainWaitPct));
    assert.equal(s.recent.readMsAvg, 40);
    assert.equal(s.recent.blockLatencyMs.p50, 300);
    assert.equal(s.recent.blockLatencyMs.max, 4000);
    telemetry.noteShareEnd('k');
    assert.equal(telemetry.liveSnapshot().sharing.viewers, 0);
  });
  it('an old watch session ending does not clear a newer one', () => {
    const a = telemetry.noteWatchStart({ fileSize: 1, ownerId: 'x' });
    const b = telemetry.noteWatchStart({ fileSize: 2, ownerId: 'y' });
    telemetry.noteWatchEnd(a);
    assert.equal(telemetry.liveSnapshot().watching?.fileSize, 2);
    telemetry.noteWatchEnd(b);
    assert.equal(telemetry.liveSnapshot().watching, null);
  });
  it('percentile', () => {
    assert.equal(percentile([5, 1, 3], 50), 3);
    assert.equal(percentile([], 50), null);
  });
});
