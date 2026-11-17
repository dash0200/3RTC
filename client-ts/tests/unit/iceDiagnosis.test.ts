import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describePairs,
  diagnoseIce,
  formatIceReport,
  parseCandidate,
  summarizePairs,
  summarizeSide
} from '../../src/webrtc/iceDiagnosis.ts';

const host = 'candidate:1 1 udp 2122260223 abc.local 50000 typ host generation 0';
const srflx = (ip: string, port: number, raddr = '0.0.0.0', rport = 0) =>
  `candidate:2 1 udp 1686052607 ${ip} ${port} typ srflx raddr ${raddr} rport ${rport} generation 0`;

// A normal NAT: both STUN servers see the same public port (the browser keeps one)
const normal = [host, srflx('49.36.1.10', 61000)];
// A strict NAT: a new public port per STUN server
const strict = [host, srflx('106.200.5.7', 40001), srflx('106.200.5.7', 40377)];
// UDP blocked: only local addresses
const blocked = [host, 'candidate:3 1 tcp 1518280447 abc.local 9 typ host tcptype active'];

describe('parseCandidate', () => {
  it('reads the fields of a candidate line', () => {
    const c = parseCandidate('a=' + srflx('1.2.3.4', 5000, '192.168.1.5', 6000));
    assert.deepEqual(c, {
      protocol: 'udp', address: '1.2.3.4', port: 5000, type: 'srflx', relatedAddress: '192.168.1.5', relatedPort: 6000
    });
  });
  it('ignores junk', () => {
    assert.equal(parseCandidate(''), null);
    assert.equal(parseCandidate('candidate:1 1 udp'), null);
  });
});

describe('summarizeSide', () => {
  it('tells normal, strict and blocked networks apart', () => {
    assert.equal(summarizeSide(normal).mapping, 'normal');
    assert.equal(summarizeSide(strict).mapping, 'strict');
    assert.equal(summarizeSide(blocked).mapping, 'blocked');
    assert.equal(summarizeSide([]).mapping, 'unknown');
  });
  it('two local sockets with one port each are not a strict NAT', () => {
    const twoSockets = [srflx('1.1.1.1', 100, '10.0.0.2', 5000), srflx('1.1.1.1', 200, '10.0.0.3', 5001)];
    assert.equal(summarizeSide(twoSockets).mapping, 'normal');
  });
});

describe('summarizePairs', () => {
  it('adds up the candidate pairs of a stats report', () => {
    const report = new Map<string, unknown>([
      ['a', { type: 'candidate-pair', state: 'failed', requestsSent: 5, responsesReceived: 0 }],
      ['b', { type: 'candidate-pair', state: 'in-progress', requestsSent: 3 }],
      ['c', { type: 'local-candidate' }]
    ]);
    assert.deepEqual(summarizePairs(report), { pairs: 2, succeeded: 0, failed: 1, requestsSent: 8, responsesReceived: 0 });
    assert.equal(summarizePairs(null), null);
  });
});

describe('diagnoseIce', () => {
  const cause = (local: string[], remote: string[], succeeded = 0) =>
    diagnoseIce({
      localCandidates: local,
      remoteCandidates: remote,
      pairs: { pairs: 4, succeeded, failed: 4 - succeeded, requestsSent: 10, responsesReceived: succeeded }
    }).cause;

  it('names the side that is at fault', () => {
    assert.equal(cause(strict, strict), 'both-strict-nat');
    assert.equal(cause(strict, normal), 'local-strict-nat');
    assert.equal(cause(normal, strict), 'remote-strict-nat');
    assert.equal(cause(blocked, normal), 'local-udp-blocked');
    assert.equal(cause(normal, blocked), 'remote-udp-blocked');
    assert.equal(cause(blocked, blocked), 'both-udp-blocked');
    assert.equal(cause(normal, normal), 'filtered');
    assert.equal(cause([], normal), 'no-local-candidates');
    assert.equal(cause(normal, []), 'no-remote-candidates');
    assert.equal(cause(strict, strict, 1), 'path-ok-setup-failed');
  });

  it('keeps IP addresses out of the room-log text', () => {
    const d = diagnoseIce({ localCandidates: strict, remoteCandidates: normal });
    const text = [d.summary, ...d.details].join(' ');
    assert.ok(!text.includes('106.200') && !text.includes('49.36'), text);
    assert.match(text, /strict NAT/);
  });
});

describe('formatIceReport', () => {
  it('has the reason, both sides and the paths tried, with addresses partly hidden', () => {
    const d = diagnoseIce({ localCandidates: strict, remoteCandidates: normal });
    const stats = new Map<string, unknown>([
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
      ['r', { id: 'r', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
      ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', state: 'failed', requestsSent: 7 }]
    ]);
    const log = formatIceReport(d, {
      peerId: 'p2',
      localCandidates: strict.map((l) => `${l} ufrag abcd`),
      remoteCandidates: normal,
      pairLines: describePairs(stats)
    });
    assert.match(log, /Cause: local-strict-nat/);
    assert.match(log, /106\.200\.5\.x 40001/);
    assert.match(log, /106\.200\.5\.x 40377/);
    assert.match(log, /srflx\/udp -> srflx\/udp failed, 7 sent, 0 answered/);
    assert.ok(!log.includes('106.200.5.7') && !log.includes('49.36.1.10') && !log.includes('ufrag'), log);
  });
});
