import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { blockedNetworkHint, candidateType } from '../../src/webrtc/networkHint.ts';
import { addViewer, detachViewer, markDirect, RELAY_FANOUT } from '../../src/webrtc/streamTree.ts';
import { normalizeSender } from '../../src/webrtc/peerMessages.ts';
import { tuneSdpForDiscordAudio } from '../../src/webrtc/sdp.ts';
import { attachRemoteAudio } from '../../src/webrtc/remoteAudio.ts';
import { teardownPeerEntry } from '../../src/webrtc/peerEntry.ts';

describe('TypeScript networkHint', () => {
  it('identifies local network block when no public candidate exists', () => {
    assert.equal(blockedNetworkHint([]).side, 'ours');
    assert.equal(blockedNetworkHint(['host']).side, 'ours');
    assert.match(blockedNetworkHint(['host']).message, /your network seems to block/);
  });

  it('identifies either side when public srflx candidate is found', () => {
    assert.equal(blockedNetworkHint(['host', 'srflx']).side, 'either');
    assert.match(blockedNetworkHint(['srflx']).message, /your network or theirs/);
  });

  it('parses candidate type from object or raw string', () => {
    assert.equal(candidateType({ type: 'srflx' }), 'srflx');
    assert.equal(
      candidateType({
        candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0'
      }),
      'host'
    );
    assert.equal(candidateType(null), '');
  });
});

describe('TypeScript streamTree', () => {
  const parents = (tree: Map<string, { parent: string | null }>) =>
    Object.fromEntries([...tree].map(([id, n]) => [id, n.parent]));

  it(`feeds ${RELAY_FANOUT} viewers directly, and later ones via relay`, () => {
    const tree = new Map();
    for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) addViewer(tree, v, true);
    const p = parents(tree);
    assert.equal(Object.values(p).filter((x) => x === null).length, RELAY_FANOUT);
  });

  it('ensures phones never relay to other peers', () => {
    const tree = new Map();
    for (const [id, canRelay] of [
      ['v1', true],
      ['phone', false],
      ['v3', true],
      ['v4', true]
    ] as [string, boolean][]) {
      addViewer(tree, id, canRelay);
    }
    assert.ok(!Object.values(parents(tree)).includes('phone'));
  });

  it('detaching a viewer reassigns its children to the owner', () => {
    const tree = new Map();
    for (const v of ['v1', 'v2', 'v3']) addViewer(tree, v, true);
    const parentOfV3 = tree.get('v3').parent;
    assert.notEqual(parentOfV3, null);
    detachViewer(tree, parentOfV3!);
    assert.equal(tree.get('v3').parent, null);
  });

  it('marks direct viewer connection properly', () => {
    const tree = new Map();
    addViewer(tree, 'v1', true);
    addViewer(tree, 'v2', true);
    addViewer(tree, 'v3', true);
    markDirect(tree, 'v3');
    assert.equal(tree.get('v3').parent, null);
  });
});

describe('TypeScript normalizeSender', () => {
  it('overrides spoofed isHost flag with authoritative server state', () => {
    const hostPeerIdRef = { current: 'peer-host-123' };
    const spoofedMsg = { type: 'chat', isHost: true, text: 'I am host' };

    normalizeSender(spoofedMsg, 'imposter-peer', hostPeerIdRef);
    assert.equal(spoofedMsg.isHost, false);

    normalizeSender(spoofedMsg, 'peer-host-123', hostPeerIdRef);
    assert.equal(spoofedMsg.isHost, true);
  });

  it('guarantees unestablished host never trusts sender-asserted isHost', () => {
    const none = { type: 'chat', isHost: true };
    normalizeSender(none, 'guest-1', { current: null });
    assert.equal(none.isHost, false);

    const unestablished = { type: 'chat', isHost: true };
    normalizeSender(unestablished, 'guest-1', { current: undefined });
    assert.equal(unestablished.isHost, false);
  });

  it('leaves messages without isHost untouched', () => {
    const msg = { type: 'queue-action', action: 'add' };
    normalizeSender(msg, 'p', { current: 'h' });
    assert.deepEqual(msg, { type: 'queue-action', action: 'add' });
  });

  it('sanitizes display names cleanly with zero-width character stripping', () => {
    const msg = { type: 'chat', sender: '  Alice \u200B\u200C  ' };
    normalizeSender(msg, 'p1');
    assert.equal(msg.sender, 'Alice');

    const empty = { type: 'chat', sender: '   ' };
    normalizeSender(empty, 'p1');
    assert.equal(empty.sender, undefined);
  });
});

describe('TypeScript sdp tuning', () => {
  it('tunes opus codec bitrate and forward error correction', () => {
    const rawSdp = 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2';
    const tuned = tuneSdpForDiscordAudio(rawSdp);
    assert.match(tuned!, /a=fmtp:111.*maxaveragebitrate=128000/);
    assert.match(tuned!, /useinbandfec=1/);
  });
});

describe('remote screen audio playback and teardown', () => {
  class FakeAudioElement {
    id = '';
    autoplay = false;
    playsInline = false;
    style = { position: '', left: '', top: '', width: '', height: '', opacity: '' };
    srcObject: unknown = null;
    muted = false;
    volume = 1.0;
    paused = false;
    async play() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
    remove() {}
  }

  const oldDoc = (globalThis as unknown as { document?: unknown }).document;
  const oldWin = (globalThis as unknown as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => (tag === 'audio' ? new FakeAudioElement() : {}),
      body: { appendChild: () => {} }
    };
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {}
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = oldDoc;
    (globalThis as unknown as { window: unknown }).window = oldWin;
  });

  it('routes screen-audio track to screenAudioElement without touching voice audioElement', () => {
    const pc = {} as RTCPeerConnection;
    const peerEntry: Record<string, unknown> = {};
    let screenAudioStreamEmitted = false;

    attachRemoteAudio(pc, {
      targetPeerId: 'peer-1',
      peerEntry,
      peerVolumesRef: { current: { 'peer-1': 1.0 } },
      localMutedPeersRef: { current: {} },
      isAudioBlockedRef: { current: false },
      logLocalDebug: () => {},
      onRemoteScreenAudioStream: () => {
        screenAudioStreamEmitted = true;
      }
    });

    // 1. Regular voice track arrives (e.g. stream id 'voice')
    const voiceTrack = { kind: 'audio', id: 'voice-1', onunmute: null, onmute: null };
    const voiceStream = { id: 'voice', getAudioTracks: () => [voiceTrack] };
    (pc as { ontrack?: (e: unknown) => void }).ontrack?.({ track: voiceTrack, streams: [voiceStream] });

    assert.ok(peerEntry.audioElement, 'Voice audioElement should be created');
    assert.equal((peerEntry.audioElement as FakeAudioElement).id, 'remote-audio-peer-1');
    assert.equal(peerEntry.screenAudioElement, undefined, 'Screen audio element should not be created for voice');

    // 2. Desktop screen-audio track arrives (stream id 'screen-audio')
    const screenAudioTrack = { kind: 'audio', id: 'screen-audio', onunmute: null, onmute: null };
    const screenAudioStream = { id: 'screen-audio', getAudioTracks: () => [screenAudioTrack] };
    (pc as { ontrack?: (e: unknown) => void }).ontrack?.({ track: screenAudioTrack, streams: [screenAudioStream] });

    assert.ok(peerEntry.screenAudioElement, 'Screen audio element should be created');
    assert.equal((peerEntry.screenAudioElement as FakeAudioElement).id, 'remote-screen-audio-peer-1');
    assert.equal((peerEntry.audioElement as FakeAudioElement).id, 'remote-audio-peer-1', 'Voice audioElement must not be overwritten');
    assert.equal(screenAudioStreamEmitted, true, 'onRemoteScreenAudioStream must be called');
  });

  it('teardownPeerEntry cleans up both audioElement and screenAudioElement', () => {
    const audioEl = new FakeAudioElement();
    const screenAudioEl = new FakeAudioElement();
    const entry: Record<string, unknown> = {
      audioElement: audioEl,
      screenAudioElement: screenAudioEl
    };

    teardownPeerEntry(entry);

    assert.equal(entry.audioElement, null);
    assert.equal(audioEl.paused, true);
    assert.equal(audioEl.srcObject, null);

    assert.equal(entry.screenAudioElement, null);
    assert.equal(screenAudioEl.paused, true);
    assert.equal(screenAudioEl.srcObject, null);
  });
});

