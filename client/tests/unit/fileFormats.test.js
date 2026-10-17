import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVint, readElementHeader } from '../../src/features/files/ebml.js';
import { parseMkvHeader, extractMkvSubtitles, extractMkvAudioTrack, extractMkvPgsSubtitles, assEventText, unlaceBlock, makeAdtsHeader } from '../../src/features/files/mkv.js';
import { parseMp4 } from '../../src/features/files/mp4.js';
import { probeFile, checkPlayable, cleanFormat, describeFormat, sniffContainer, subtitleTrackLabel, deviceName } from '../../src/features/files/formats.js';
import { canExtract, isPgsTrack } from '../../src/features/files/extractSubtitles.js';

// ---- building test files ----------------------------------------------------------------------
const enc = new TextEncoder();
const idBytes = (id) => { const out = []; let v = id; while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); } return out; };
const sizeBytes = (n) => { // 8-byte size vint
    const out = [0x01]; for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff); return out;
};
const el = (id, ...children) => {
    const body = children.flatMap((c) => (typeof c === 'string' ? [...enc.encode(c)] : Array.isArray(c) ? c : [...c]));
    return [...idBytes(id), ...sizeBytes(body.length), ...body];
};
const uint = (id, v, len = 1) => el(id, Array.from({ length: len }, (_, i) => (v >> (8 * (len - 1 - i))) & 0xff));
const float8 = (id, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, [...b]); };
const block = (track, rel, text) => [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, 0x80, ...enc.encode(text)];
const rawBlock = (track, rel, dataBytes) => [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, 0x80, ...dataBytes];

function mkvFile() {
    const track = (n, type, codec, lang, name = '') => el(0xae, uint(0xd7, n), uint(0x83, type), el(0x86, codec), el(0x22b59c, lang), ...(name ? [el(0x536e, name)] : []));
    return new Uint8Array([
        ...el(0x1a45dfa3, el(0x4282, 'matroska')),
        ...el(0x18538067,
            el(0x1549a966, uint(0x2ad7b1, 1000000, 3), float8(0x4489, 20000)),
            el(0x1654ae6b,
                track(1, 1, 'V_MPEG4/ISO/AVC', 'und'),
                track(2, 2, 'A_AC3', 'eng'),
                track(3, 2, 'A_AAC', 'hin', 'Hindi dub'),
                track(4, 17, 'S_TEXT/UTF8', 'eng'),
                track(5, 17, 'S_TEXT/ASS', 'spa', 'Latin American'),
                track(6, 17, 'S_HDMV/PGS', 'eng')),
            el(0x1f43b675, uint(0xe7, 1000, 2),
                el(0xa3, block(1, 0, 'videodata')),
                el(0xa3, block(2, 0, 'ac3_payload_frame_1')),
                el(0xa3, block(4, 0, 'First line\r\nsecond row')),
                el(0xa0, el(0xa1, block(5, 500, '0,0,Default,,0,0,0,,{\\i1}Hola{\\i0}\\Nmundo')), uint(0x9b, 2000, 2)),
                el(0xa3, rawBlock(6, 0, [0x16, 0x00, 0x02, 0xaa, 0xbb]))),
            el(0x1f43b675, uint(0xe7, 5000, 2),
                el(0xa3, block(2, 0, 'ac3_payload_frame_2')),
                el(0xa3, block(4, 0, 'Third')),
                el(0xa3, block(4, 1000, 'Fourth'))))
    ]);
}

const reader = (bytes) => async (pos, len) => bytes.subarray(pos, Math.min(bytes.length, pos + len));

// ---- tests --------------------------------------------------------------------------------------
test('EBML variable-length integers', () => {
    assert.deepEqual(readVint(new Uint8Array([0x81]), 0).value, 1);
    assert.deepEqual(readVint(new Uint8Array([0x40, 0x02]), 0).value, 2);
    assert.equal(readVint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, { keepMarker: true }).value, 0x1a45dfa3);
    assert.equal(readElementHeader(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0).size, -1); // unknown size
    assert.equal(readVint(new Uint8Array([0x40]), 0), null); // cut off
});

test('MKV tracks: codecs, languages, names, subtitle kinds', async () => {
    const bytes = mkvFile();
    const header = parseMkvHeader(bytes);
    assert.equal(header.tracks.length, 6);
    const f = await probeFile({ size: bytes.length }, { readAt: reader(bytes) });
    assert.equal(f.container, 'matroska');
    assert.equal(f.duration, 20);
    assert.equal(f.video.codec, 'h264');
    assert.deepEqual(f.audio.map((a) => [a.codec, a.language, a.name]), [['ac3', 'eng', ''], ['aac', 'hin', 'Hindi dub']]);
    assert.deepEqual(f.subtitles.map((s) => [s.number, s.kind, s.label]), [[4, 'text', 'SRT'], [5, 'text', 'ASS'], [6, 'image', 'PGS (picture)']]);
    assert.equal(subtitleTrackLabel(f.subtitles[1]), 'Spanish – Latin American · ASS');
    assert.equal(describeFormat(f), 'MKV · H.264 · Dolby Digital (AC-3) + 1 more audio · 3 subtitles');
});

test('MKV subtitle text: SRT and ASS, timing, durations', async () => {
    const bytes = mkvFile();
    const cues = await extractMkvSubtitles(reader(bytes), bytes.length, [{ number: 4, codecId: 'S_TEXT/UTF8' }, { number: 5, codecId: 'S_TEXT/ASS' }]);
    assert.deepEqual(cues.get(4), [
        { startSec: 1, endSec: 5, text: 'First line\nsecond row' }, // no duration: until the next one
        { startSec: 5, endSec: 6, text: 'Third' },
        { startSec: 6, endSec: 9, text: 'Fourth' }
    ]);
    assert.deepEqual(cues.get(5), [{ startSec: 1.5, endSec: 3.5, text: 'Hola\nmundo' }]);
    assert.equal(assEventText('0,0,Default,,0,0,0,,Hi, there {\\pos(1,2)}you'), 'Hi, there you');
});

test('MKV audio bitstream extraction', async () => {
    const bytes = mkvFile();
    const rawAudio = await extractMkvAudioTrack(reader(bytes), bytes.length, 2);
    const text = new TextDecoder().decode(rawAudio);
    assert.equal(text, 'ac3_payload_frame_1ac3_payload_frame_2');
});

test('MKV PGS subtitle extraction and Blu-ray .sup packet framing', async () => {
    const bytes = mkvFile();
    assert.equal(canExtract({ codec: 's_hdmv/pgs' }), true);
    assert.equal(isPgsTrack({ codec: 's_hdmv/pgs' }), true);
    assert.equal(isPgsTrack({ codec: 's_text/utf8' }), false);

    const supBytes = await extractMkvPgsSubtitles(reader(bytes), bytes.length, 6);
    assert.ok(supBytes instanceof Uint8Array);
    assert.equal(supBytes.length, 15);
    // Header should start with 'PG' (0x50, 0x47)
    assert.equal(supBytes[0], 0x50);
    assert.equal(supBytes[1], 0x47);
    // PTS at 1000ms: 1000 * 90 = 90,000 = 0x00015f90
    assert.deepEqual(Array.from(supBytes.subarray(2, 6)), [0x00, 0x01, 0x5f, 0x90]);
    // Segment data payload
    assert.deepEqual(Array.from(supBytes.subarray(10)), [0x16, 0x00, 0x02, 0xaa, 0xbb]);
});

function box(type, ...children) {
    const body = children.flat();
    const size = 8 + body.length;
    return [(size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...enc.encode(type), ...body];
}
const zeros = (n) => new Array(n).fill(0);
function mp4File({ moovAtEnd }) {
    const hdlr = (h) => box('hdlr', zeros(8), [...enc.encode(h)], zeros(12), [0]);
    // language 'eng' packed: ((e-0x60)<<10)|((n-0x60)<<5)|(g-0x60)
    const lang = ((5) << 10) | ((14) << 5) | 7;
    const mdhd = box('mdhd', zeros(20), [lang >> 8, lang & 0xff], zeros(2));
    const stsd = (entry) => box('stsd', zeros(4), [0, 0, 0, 1], entry);
    const trak = (h, entry) => box('trak', box('mdia', mdhd, hdlr(h), box('minf', box('stbl', stsd(entry)))));
    const esds = box('esds', zeros(4), [0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x40, 0x15]);
    const moov = box('moov',
        box('mvhd', zeros(12), [0, 0, 0x03, 0xe8], [0, 0, 0x75, 0x30], zeros(80)),
        trak('vide', box('hvc1', zeros(78))),
        trak('soun', box('mp4a', zeros(28), esds)),
        trak('soun', box('ec-3', zeros(28))),
        trak('sbtl', box('tx3g', zeros(30))));
    const ftyp = box('ftyp', [...enc.encode('isom')], zeros(4));
    const mdat = box('mdat', zeros(1000));
    return new Uint8Array(moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat]);
}

test('MP4 tracks, with moov at the start or the end', async () => {
    for (const moovAtEnd of [false, true]) {
        const bytes = mp4File({ moovAtEnd });
        const info = await parseMp4(reader(bytes), bytes.length);
        assert.equal(info.moovAtEnd, moovAtEnd);
        assert.equal(info.duration, 30);
        assert.deepEqual(info.tracks.map((t) => [t.type, t.codec, t.language]),
            [['video', 'hevc', 'eng'], ['audio', 'aac', 'eng'], ['audio', 'eac3', 'eng'], ['subtitle', 'tx3g', 'eng']]);
        const f = await probeFile({ size: bytes.length }, { readAt: reader(bytes) });
        assert.equal(describeFormat(f), 'MP4 · HEVC (H.265) · AAC + 1 more audio · 1 subtitle');
    }
});

test('other containers are recognised by their first bytes', () => {
    const b = (s) => enc.encode(s.padEnd(400, '\0'));
    assert.equal(sniffContainer(b('RIFF\0\0\0\0AVI LIST')), 'avi');
    assert.equal(sniffContainer(b('FLV\x01')), 'flv');
    const ts = new Uint8Array(400); ts[0] = ts[188] = ts[376] = 0x47;
    assert.equal(sniffContainer(ts), 'mpegts');
    assert.equal(sniffContainer(b('hello')), 'unknown');
});

test('playability: per device, picture vs sound', () => {
    const chrome = { canPlay: (t) => (/avc1|vp9|vp09|av01|mp4a|opus|vorbis|flac|audio\/mpeg|webm/.test(t) ? 'probably' : ''), chromium: true };
    const safari = { canPlay: (t) => (/avc1|hvc1|mp4a|ac-3|ec-3|audio\/mpeg|flac/.test(t) ? 'probably' : ''), chromium: false };
    const fmt = (container, v, ...a) => ({ container, video: v ? { codec: v, label: v } : null, audio: a.map((codec) => ({ codec, label: codec })), subtitles: [] });
    assert.equal(checkPlayable(fmt('mp4', 'h264', 'aac'), chrome).verdict, 'ok');
    assert.equal(checkPlayable(fmt('mp4', 'h264', 'ac3'), chrome).verdict, 'no-audio');
    assert.equal(checkPlayable(fmt('mp4', 'h264', 'ac3'), safari).verdict, 'ok');
    assert.equal(checkPlayable(fmt('mp4', 'hevc', 'aac'), chrome).verdict, 'no-video');
    assert.equal(checkPlayable(fmt('mp4', 'hevc', 'aac'), safari).verdict, 'ok');
    assert.equal(checkPlayable(fmt('matroska', 'h264', 'aac'), chrome).verdict, 'ok');
    assert.equal(checkPlayable(fmt('matroska', 'h264', 'aac'), safari).verdict, 'maybe');
    assert.equal(checkPlayable(fmt('avi', 'mpeg4', 'mp3'), chrome).verdict, 'no-video');
    assert.equal(checkPlayable(fmt('matroska', 'mpeg4', 'mp3'), chrome).verdict, 'no-video');
    assert.equal(checkPlayable(fmt('mp4', 'h264', 'dts'), chrome).verdict, 'no-audio');
    assert.match(checkPlayable(fmt('mp4', 'h264', 'ac3'), chrome).message, /no sound/);
});

test('the format sent to the room is cleaned', () => {
    const f = cleanFormat({
        container: 'evil', video: { codec: 'x'.repeat(500) }, audio: new Array(40).fill({ codec: 'aac', language: 'eng', name: 'n'.repeat(300) }),
        subtitles: [{ number: 'x', kind: 'weird', codec: 'S_TEXT/UTF8' }], duration: -5, extra: 'dropped'
    });
    assert.equal(f.container, 'unknown');
    assert.equal(f.video.codec.length, 40);
    assert.equal(f.audio.length, 16);
    assert.equal(f.audio[0].name.length, 80);
    assert.deepEqual([f.subtitles[0].number, f.subtitles[0].kind], [0, 'text']);
    assert.equal(f.duration, 0);
    assert.equal(f.extra, undefined);
    assert.equal(cleanFormat(null), null);
});

test('device names', () => {
    assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
    assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome on Android');
});

test('ADTS header generation for AAC access units', () => {
    const h = makeAdtsHeader(100, 3, 2, 1);
    assert.equal(h.length, 7);
    assert.equal(h[0], 0xff);
    assert.equal(h[1], 0xf1); // MPEG-4, no CRC
    // 100 bytes frame + 7 bytes header = 107 (0x6B)
    const len = ((h[3] & 0x03) << 11) | (h[4] << 3) | ((h[5] >> 5) & 0x07);
    assert.equal(len, 107);
});

test('unlaceBlock: no lacing, xiph, fixed-size and ebml lacing', () => {
    // 1. No lacing
    const rawData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const unlaced0 = unlaceBlock(rawData, 0, rawData.length, 0);
    assert.equal(unlaced0.length, 1);
    assert.deepEqual(Array.from(unlaced0[0]), [1, 2, 3, 4]);

    // 2. Fixed-size lacing: 2 frames of 3 bytes each
    // [numFramesMinus1 = 1, f1, f1, f1, f2, f2, f2]
    const fixedBuf = new Uint8Array([1, 10, 11, 12, 20, 21, 22]);
    const unlacedFixed = unlaceBlock(fixedBuf, 0, fixedBuf.length, 2);
    assert.equal(unlacedFixed.length, 2);
    assert.deepEqual(Array.from(unlacedFixed[0]), [10, 11, 12]);
    assert.deepEqual(Array.from(unlacedFixed[1]), [20, 21, 22]);

    // 3. Xiph lacing: 2 frames of 2 bytes and 3 bytes
    // [numFramesMinus1 = 1, size0 = 2, f1, f1, f2, f2, f2]
    const xiphBuf = new Uint8Array([1, 2, 10, 11, 20, 21, 22]);
    const unlacedXiph = unlaceBlock(xiphBuf, 0, xiphBuf.length, 1);
    assert.equal(unlacedXiph.length, 2);
    assert.deepEqual(Array.from(unlacedXiph[0]), [10, 11]);
    assert.deepEqual(Array.from(unlacedXiph[1]), [20, 21, 22]);

    // 4. EBML lacing: 2 frames of 3 bytes and 2 bytes
    // [numFramesMinus1 = 1, vint(3) = 0x83, f1, f1, f1, f2, f2]
    const ebmlBuf = new Uint8Array([1, 0x83, 10, 11, 12, 20, 21]);
    const unlacedEbml = unlaceBlock(ebmlBuf, 0, ebmlBuf.length, 3);
    assert.equal(unlacedEbml.length, 2);
    assert.deepEqual(Array.from(unlacedEbml[0]), [10, 11, 12]);
    assert.deepEqual(Array.from(unlacedEbml[1]), [20, 21]);
});

test('extractMkvAudioTrack extracts raw audio bitstream from MKV', async () => {
    const fileBytes = mkvFile();
    const readAt = reader(fileBytes);

    // Track 2 in mkvFile() is AC-3 with two frames: 'ac3_payload_frame_1' and 'ac3_payload_frame_2'
    const audioTrack2 = await extractMkvAudioTrack(readAt, fileBytes.length, 2, {
        codec: 'ac3'
    });
    assert.ok(audioTrack2.length > 0);
    const text = new TextDecoder().decode(audioTrack2);
    assert.ok(text.includes('ac3_payload_frame_1'));
    assert.ok(text.includes('ac3_payload_frame_2'));
});
