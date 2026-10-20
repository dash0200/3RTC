import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractYouTubeId } from '../../src/utils/youtubeId.ts';
import { splitTimestamps } from '../../src/utils/chatTimestamps.ts';
import { splitLinks } from '../../src/utils/chatLinks.ts';
import { saveLastRoom, readLastRoom, forgetLastRoom, LAST_ROOM_FRESH_MS } from '../../src/utils/lastRoom.ts';
import { isSingleEmoji, splitEmojis } from '../../src/utils/emoji.ts';
import { generateQrMatrix, getServerTag, getMobileJoinUrl } from '../../src/utils/qrCode.ts';
import { parseSrt, parseVtt, timeStringToSeconds, secondsToVttTimestamp, getActiveCues } from '../../src/utils/subtitleParser.ts';
import {
  sanitizeImageMimeType,
  safeImageDownloadName,
  formatFileSize,
  createImagePacket,
  parseImagePacket,
  P2PImageReceiver
} from '../../src/utils/p2pImageShare.ts';
import {
  sanitizeMediaMimeType,
  getVideoMimeType,
  P2PRangeReceiver,
  RANGE_BLOCK_SIZE
} from '../../src/utils/p2pStreamer.ts';
import {
  getNetworkHealthGrade,
  parseCandidateConnectionType,
  extractPeerConnectionStats
} from '../../src/utils/networkMonitor.ts';
import { devicesToLists, matchDevice } from '../../src/utils/audioDevices.ts';

describe('TypeScript youtubeId', () => {
  it('extracts 11-char IDs from links and bare IDs', () => {
    assert.equal(extractYouTubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractYouTubeId('https://example.com/invalid'), null);
    assert.equal(extractYouTubeId(''), null);
    assert.equal(extractYouTubeId(null), null);
  });
});

describe('TypeScript chatTimestamps', () => {
  it('splits timestamps from text and converts to seconds', () => {
    const parts = splitTimestamps('Check 1:23 and 01:02:03 now');
    assert.equal(parts.length, 5);
    assert.deepEqual(parts[0], { text: 'Check ' });
    assert.deepEqual(parts[1], { text: '1:23', seconds: 83 });
    assert.deepEqual(parts[2], { text: ' and ' });
    assert.deepEqual(parts[3], { text: '01:02:03', seconds: 3723 });
    assert.deepEqual(parts[4], { text: ' now' });
  });

  it('leaves clock times as plain text', () => {
    const parts = splitTimestamps('Meeting at 9:30 pm');
    assert.equal(parts.length, 1);
    assert.equal(parts[0].text, 'Meeting at 9:30 pm');
  });
});

describe('TypeScript chatLinks', () => {
  it('splits URLs and handles trailing punctuation correctly', () => {
    const parts = splitLinks('Visit https://3rtc.me/room?id=1, (or www.google.com).');
    assert.equal(parts.length, 5);
    assert.equal(parts[1].href, 'https://3rtc.me/room?id=1');
    assert.equal(parts[3].href, 'https://www.google.com');
  });
});

describe('TypeScript lastRoom', () => {
  it('saves, reads, and clears room records within 30 minutes', () => {
    // Mock localStorage
    const store = new Map<string, string>();
    const originalLocalStorage = globalThis.localStorage;
    const mockStorage: Storage = {
      getItem: (k: string) => store.get(k) || null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] || null,
      length: store.size
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      configurable: true,
      writable: true
    });

    try {
      const now = Date.now();
      saveLastRoom('12345', true, 'secret-host-token');
      const rec = readLastRoom(now);
      assert.ok(rec);
      assert.equal(rec!.roomId, '12345');
      assert.equal(rec!.wasHost, true);
      assert.equal(rec!.hostToken, 'secret-host-token');

      // Stale room > 30 mins
      const staleRec = readLastRoom(now + LAST_ROOM_FRESH_MS + 1000);
      assert.equal(staleRec, null);

      forgetLastRoom();
      assert.equal(readLastRoom(now), null);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true
      });
    }
  });
});

describe('TypeScript emoji', () => {
  it('validates single emojis including regional indicators and multi-code points', () => {
    assert.ok(isSingleEmoji('🔥'));
    assert.ok(isSingleEmoji('🎉'));
    assert.ok(!isSingleEmoji(''));
    assert.ok(!isSingleEmoji('abc'));
    assert.ok(!isSingleEmoji('🔥🎉'));
  });

  it('splits multiple emojis in text', () => {
    const emojis = splitEmojis('Hello 😀 and 🔥 world');
    assert.deepEqual(emojis, ['😀', '🔥']);
  });
});

describe('TypeScript qrCode', () => {
  it('generates boolean module matrix', () => {
    const { matrix, size, version } = generateQrMatrix('https://3rtc.me/?room=12345');
    assert.ok(size > 20);
    assert.equal(matrix.length, size);
    assert.equal(matrix[0].length, size);
    assert.ok(version >= 1);
  });

  it('parses server tags and formats mobile join URL', () => {
    assert.equal(getServerTag('wss://orc.3rtc.me:443'), 'orc');
    assert.equal(getServerTag('wss://gcp.3rtc.me'), 'gcp');
    assert.equal(getServerTag('ws://localhost:8080'), 'local');

    const joinUrl = getMobileJoinUrl('12345', 'https://3rtc.me', 'Alice', 'orc');
    assert.equal(joinUrl, 'https://3rtc.me/?room=12345&from=Alice&s=orc');
  });
});

describe('TypeScript subtitleParser', () => {
  it('parses timestamps and converts to/from seconds', () => {
    assert.equal(timeStringToSeconds('00:01:23,456'), 83.456);
    assert.equal(timeStringToSeconds('01:23.456'), 83.456);
    assert.equal(secondsToVttTimestamp(83.456), '00:01:23.456');
  });

  it('parses SRT content into structured cues', () => {
    const srt = `1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond line`;
    const cues = parseSrt(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].startSec, 1);
    assert.equal(cues[0].endSec, 4);
    assert.equal(cues[0].text, 'Hello world');

    const active = getActiveCues(cues, 2.5);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 1);
  });

  it('parses WebVTT content with headers and notes', () => {
    const vtt = `WEBVTT\n\nNOTE This is a comment\n\n00:00:02.000 --> 00:00:05.000\nVTT line`;
    const cues = parseVtt(vtt);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].startSec, 2);
    assert.equal(cues[0].endSec, 5);
    assert.equal(cues[0].text, 'VTT line');
  });
});

describe('TypeScript p2pImageShare', () => {
  it('sanitizes MIME types and download filenames', () => {
    assert.equal(sanitizeImageMimeType('image/png'), 'image/png');
    assert.equal(sanitizeImageMimeType('text/html'), 'image/png');
    assert.equal(safeImageDownloadName('../../hack.exe', 'image/png'), 'hack.png');
    assert.equal(formatFileSize(1048576), '1.0 MB');
  });

  it('packs and unpacks binary image packets', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const packet = createImagePacket('transfer-1', 2, 10, payload);
    const parsed = parseImagePacket(packet);

    assert.ok(parsed);
    assert.equal(parsed!.transferId, 'transfer-1');
    assert.equal(parsed!.chunkIndex, 2);
    assert.equal(parsed!.totalChunks, 10);
    assert.deepEqual(new Uint8Array(parsed!.data), new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('P2PImageReceiver guards against abnormal chunk counts', () => {
    const receiver = new P2PImageReceiver();
    receiver.handleStart({ transferId: 't-invalid', totalChunks: -5 });
    assert.equal(receiver.transfers.has('t-invalid'), false);

    receiver.handleStart({ transferId: 't-valid', totalChunks: 3 });
    assert.equal(receiver.transfers.has('t-valid'), true);
  });
});

describe('TypeScript p2pStreamer', () => {
  it('sanitizes media MIME types and detects container types', () => {
    assert.equal(sanitizeMediaMimeType('video/mp4'), 'video/mp4');
    assert.equal(sanitizeMediaMimeType('application/javascript'), 'video/mp4');
    assert.equal(getVideoMimeType({ name: 'movie.webm' }), 'video/webm');
    assert.equal(getVideoMimeType({ name: 'clip.mp4' }), 'video/mp4');
  });

  it('P2PRangeReceiver calculates blocks correctly', () => {
    const receiver = new P2PRangeReceiver({
      streamNo: 1,
      fileName: 'film.mp4',
      fileSize: 1024 * 1024,
      blockSize: RANGE_BLOCK_SIZE
    });

    assert.equal(receiver.totalBlocks, 4);
    assert.equal(receiver.url, '/__p2p-stream/1/film.mp4');
  });
});

describe('TypeScript networkMonitor', () => {
  it('grades network health and classifies candidate connections', () => {
    assert.equal(getNetworkHealthGrade(30, 0).grade, 'A+');
    assert.equal(getNetworkHealthGrade(85, 1).grade, 'A');
    assert.equal(getNetworkHealthGrade(150, 4).grade, 'B');
    assert.equal(getNetworkHealthGrade(250, 10).grade, 'C');
    assert.equal(getNetworkHealthGrade(null).grade, '?');

    assert.equal(parseCandidateConnectionType('relay', 'host'), 'Relay (TURN)');
    assert.equal(parseCandidateConnectionType('host', 'host'), 'Direct LAN (Host)');
    assert.equal(parseCandidateConnectionType('srflx', 'srflx'), 'Direct P2P (STUN)');
  });

  it('extracts peer connection stats from WebRTC stats report', async () => {
    const mockReport = new Map<string, Record<string, unknown>>([
      [
        'local-1',
        { id: 'local-1', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', address: '1.2.3.4', port: 5000 }
      ],
      [
        'remote-1',
        { id: 'remote-1', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp', address: '5.6.7.8', port: 6000 }
      ],
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'local-1',
          remoteCandidateId: 'remote-1',
          currentRoundTripTime: 0.042,
          bytesReceived: 10240,
          bytesSent: 20480
        }
      ],
      [
        'audio-in-1',
        { id: 'audio-in-1', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 2, jitter: 0.005 }
      ]
    ]);

    const mockPc = {
      getStats: async () => mockReport as unknown as RTCStatsReport
    } as unknown as RTCPeerConnection;

    const stats = await extractPeerConnectionStats(mockPc);
    assert.ok(stats);
    assert.equal(stats!.rttMs, 42);
    assert.equal(stats!.connectionType, 'Direct P2P (STUN)');
    assert.equal(stats!.protocol, 'UDP');
    assert.equal(stats!.totalBytesReceived, 10240);
    assert.equal(stats!.totalBytesSent, 20480);
    assert.equal(stats!.packetLossPercent, 2);
    assert.equal(stats!.jitterMs, 5);
  });
});

describe('TypeScript audioDevices', () => {
  it('converts enumerateDevices list into input and output options', () => {
    const mockDevices: MediaDeviceInfo[] = [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic', groupId: '', toJSON: () => ({}) },
      { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Headphones', groupId: '', toJSON: () => ({}) },
      { deviceId: 'default', kind: 'audiooutput', label: 'Default - Headphones', groupId: '', toJSON: () => ({}) },
      { deviceId: 'communications', kind: 'audiooutput', label: 'Communications', groupId: '', toJSON: () => ({}) }
    ];

    const lists = devicesToLists(mockDevices);
    assert.equal(lists.labelsHidden, false);
    assert.ok(lists.inputs.some((d) => d.id === 'mic-1' && d.label === 'USB Mic'));
    assert.ok(lists.outputs.some((d) => d.id === '' && d.label === 'Default - Headphones'));
    assert.ok(lists.outputs.some((d) => d.id === 'speaker-1' && d.label === 'Headphones'));
    // Communications device is filtered out
    assert.ok(!lists.outputs.some((d) => d.id === 'communications'));
  });

  it('matches devices by id or fallback label', () => {
    const list = [
      { id: '', label: 'System default' },
      { id: 'dev-1', label: 'Studio Mic' }
    ];

    assert.equal(matchDevice(list, 'dev-1', 'Studio Mic'), 'dev-1');
    assert.equal(matchDevice(list, 'dev-old', 'Studio Mic'), 'dev-1');
    assert.equal(matchDevice(list, 'dev-old', 'Unknown'), '');
    assert.equal(matchDevice(list, ''), '');
  });
});
