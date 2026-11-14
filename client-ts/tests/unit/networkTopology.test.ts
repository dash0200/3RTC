import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTechnicalDistance,
  normalizeCandidateType
} from '../../src/hooks/useNetworkStats';
import type { PeerLinkMetric } from '../../src/types/protocol';

describe('Network Topology & Technical Distance (M7)', () => {
  it('normalizes WebRTC candidate pairs accurately', () => {
    // Both host candidates = direct LAN
    assert.equal(normalizeCandidateType('host', 'host'), 'host');
    assert.equal(normalizeCandidateType('HOST', 'HOST'), 'host');

    // Either side relay = TURN relay
    assert.equal(normalizeCandidateType('relay', 'host'), 'relay');
    assert.equal(normalizeCandidateType('host', 'relay'), 'relay');
    assert.equal(normalizeCandidateType('relay', 'srflx'), 'relay');
    assert.equal(normalizeCandidateType('srflx', 'relay'), 'relay');

    // Peer reflexive
    assert.equal(normalizeCandidateType('prflx', 'host'), 'prflx');

    // Default P2P STUN (server reflexive)
    assert.equal(normalizeCandidateType('srflx', 'srflx'), 'srflx');
    assert.equal(normalizeCandidateType(undefined, undefined), 'srflx');
    assert.equal(normalizeCandidateType('', ''), 'srflx');
  });

  it('evaluates LAN connections with minimal technical distance', () => {
    const lanMetric: PeerLinkMetric = {
      rttMs: 6,
      candidateType: 'host',
      lossPct: 0,
      jitterMs: 0.5
    };
    const res = calculateTechnicalDistance(lanMetric);
    assert.equal(res.tier, 'lan');
    assert.ok(res.score < 15, `Score should be < 15, got ${res.score}`);
    assert.ok(res.tierLabel.includes('LAN'));
    assert.equal(res.color, '#00e676');
  });

  it('evaluates near P2P connections under 50ms', () => {
    const nearMetric: PeerLinkMetric = {
      rttMs: 32,
      candidateType: 'srflx',
      lossPct: 0,
      jitterMs: 1.2
    };
    const res = calculateTechnicalDistance(nearMetric);
    assert.equal(res.tier, 'near');
    assert.ok(res.score >= 15 && res.score < 50);
    assert.ok(res.tierLabel.includes('Near'));
  });

  it('evaluates medium P2P connections (50-120ms)', () => {
    const mediumMetric: PeerLinkMetric = {
      rttMs: 75,
      candidateType: 'srflx',
      lossPct: 0.5,
      jitterMs: 3.0
    };
    const res = calculateTechnicalDistance(mediumMetric);
    assert.equal(res.tier, 'medium');
    assert.ok(res.score >= 50 && res.score < 120);
    assert.ok(res.tierLabel.includes('Medium'));
  });

  it('evaluates far P2P connections (120-250ms)', () => {
    const farMetric: PeerLinkMetric = {
      rttMs: 160,
      candidateType: 'srflx',
      lossPct: 1.0,
      jitterMs: 4.0
    };
    const res = calculateTechnicalDistance(farMetric);
    assert.equal(res.tier, 'far');
    assert.ok(res.score >= 120 && res.score < 250);
    assert.ok(res.tierLabel.includes('Far'));
  });

  it('applies relay multiplier penalty to TURN connections', () => {
    // 120ms on TURN relay effectively behaves like 300ms due to packet reflection
    const relayMetric: PeerLinkMetric = {
      rttMs: 120,
      candidateType: 'relay',
      lossPct: 0,
      jitterMs: 2.0
    };
    const res = calculateTechnicalDistance(relayMetric);
    assert.equal(res.tier, 'relayed');
    // 120 * 2.5 = 300 + jitter penalty = 301
    assert.ok(res.score >= 250, `Relayed score should be >= 250, got ${res.score}`);
    assert.ok(res.tierLabel.includes('Relay') || res.tierLabel.includes('Distant'));
  });

  it('penalizes packet loss and jitter in technical distance score', () => {
    const clean: PeerLinkMetric = {
      rttMs: 40,
      candidateType: 'srflx',
      lossPct: 0,
      jitterMs: 0
    };
    const degraded: PeerLinkMetric = {
      rttMs: 40,
      candidateType: 'srflx',
      lossPct: 5.0, // 5% loss = +75 penalty
      jitterMs: 20.0 // 20ms jitter = +10 penalty
    };
    const cleanRes = calculateTechnicalDistance(clean);
    const degradedRes = calculateTechnicalDistance(degraded);

    assert.equal(cleanRes.score, 40);
    assert.equal(degradedRes.score, 125); // 40 + 75 + 10 = 125
    assert.equal(cleanRes.tier, 'near');
    assert.equal(degradedRes.tier, 'far');
  });
});
