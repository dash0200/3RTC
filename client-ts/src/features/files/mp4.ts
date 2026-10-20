/**
 * MP4 / MOV: the tracks in a file (codec of each video, audio and subtitle track, language) from
 * its "moov" box, which can be at the start or at the end of the file.
 *   readAt(pos, length) -> Promise<Uint8Array>
 */

export interface Mp4Box {
  type: string;
  start: number;
  end: number;
}

export interface Mp4Track {
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  fourcc: string;
  language: string;
  id?: number;
}

export interface ParsedMp4 {
  brand: string;
  tracks: Mp4Track[];
  duration: number;
  moovAtEnd: boolean;
}

export type ReadAtFn = (pos: number, length: number) => Promise<Uint8Array>;

const MAX_MOOV = 64 * 1024 * 1024;

const u32 = (b: Uint8Array, p: number): number =>
  ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];

const fourcc = (b: Uint8Array, p: number): string =>
  String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Is this the start of an MP4/MOV file (an "ftyp" box, or a "moov"/"mdat"/"free"/"wide" box)? */
export function isMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(fourcc(bytes, 4));
}

/** The boxes directly inside bytes[start, end): [{ type, start (of contents), end }] */
function boxes(b: Uint8Array, start: number, end: number): Mp4Box[] {
  const out: Mp4Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) break;
    out.push({ type, start: p + header, end: Math.min(p + size, end) });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Mp4Box | undefined, type: string): Mp4Box | undefined =>
  box ? boxes(b, box.start, box.end).find((x) => x.type === type) : undefined;

// The language in an "mdhd" box (three letters packed in 15 bits)
function mdhdLanguage(b: Uint8Array, box: Mp4Box | undefined): string {
  if (!box) return 'und';
  const version = b[box.start];
  const p = box.start + (version === 1 ? 32 : 20);
  const packed = (b[p] << 8) | b[p + 1];
  const s = String.fromCharCode(((packed >> 10) & 31) + 0x60, ((packed >> 5) & 31) + 0x60, (packed & 31) + 0x60);
  return /^[a-z]{3}$/.test(s) ? s : 'und';
}

// "mp4a": the codec is in its esds box (object type: 0x40 AAC, 0x69/0x6B MP3 ...)
function mp4aObjectType(b: Uint8Array, entry: Mp4Box): number | null {
  // sample entry: 8 reserved/index + 20 audio fields (v0); v1/v2 (QuickTime) add 16/36
  const version = (b[entry.start + 8] << 8) | b[entry.start + 9];
  const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
  const inner = boxes(b, entry.start + 28 + extra, entry.end);
  let esds = inner.find((x) => x.type === 'esds');
  if (!esds) {
    // QuickTime: inside a "wave" box
    const wave = inner.find((x) => x.type === 'wave');
    esds = wave ? boxes(b, wave.start, wave.end).find((x) => x.type === 'esds') : undefined;
  }
  if (!esds) return null;
  // Find the DecoderConfigDescriptor (tag 4); its first byte is the object type
  for (let p = esds.start + 4; p < esds.end - 2; p++) {
    if (b[p] === 0x04) {
      let q = p + 1;
      for (let i = 0; i < 4 && (b[q] & 0x80); i++) q++;
      return b[q + 1];
    }
  }
  return null;
}

const VIDEO_FOURCC: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8',
  mp4v: 'mpeg4', 'mp4v ': 'mpeg4', s263: 'h263', mjpa: 'mjpeg', jpeg: 'mjpeg',
  apcn: 'prores', apch: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores',
  dvh1: 'hevc', dvhe: 'hevc'
};

const AUDIO_FOURCC: Record<string, string> = {
  'ac-3': 'ac3', 'ec-3': 'eac3', 'ac-4': 'ac4', Opus: 'opus', fLaC: 'flac', '.mp3': 'mp3', alac: 'alac',
  dtsc: 'dts', dtsh: 'dts', dtsl: 'dts', dtse: 'dts', samr: 'amr', sowt: 'pcm', twos: 'pcm',
  lpcm: 'pcm', ipcm: 'pcm', 'raw ': 'pcm'
};

const SUB_HANDLERS = new Set(['subt', 'text', 'sbtl', 'clcp']);

function parseMoov(b: Uint8Array, moov: Mp4Box): { tracks: Mp4Track[]; duration: number } {
  const tracks: Mp4Track[] = [];
  let duration = 0;
  const mvhd = child(b, moov, 'mvhd');
  if (mvhd) {
    const v = b[mvhd.start];
    const scale = v === 1 ? u32(b, mvhd.start + 20) : u32(b, mvhd.start + 12);
    const dur = v === 1 ? u32(b, mvhd.start + 24) * 2 ** 32 + u32(b, mvhd.start + 28) : u32(b, mvhd.start + 16);
    if (scale) duration = dur / scale;
  }
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = child(b, mdia, 'hdlr');
    const handler = hdlr ? fourcc(b, hdlr.start + 8) : '';
    const minf = child(b, mdia, 'minf');
    const stbl = child(b, minf, 'stbl');
    const stsd = child(b, stbl, 'stsd');
    const entry = stsd ? boxes(b, stsd.start + 8, stsd.end)[0] : undefined;
    const sampleType = entry?.type || '';
    const language = mdhdLanguage(b, child(b, mdia, 'mdhd'));
    let type: Mp4Track['type'] = 'other';
    let codec = sampleType || 'unknown';
    if (handler === 'vide') {
      type = 'video';
      codec = VIDEO_FOURCC[sampleType] || `other:${sampleType}`;
    } else if (handler === 'soun') {
      type = 'audio';
      if (sampleType === 'mp4a' && entry) {
        const ot = mp4aObjectType(b, entry);
        codec = ot === 0x69 || ot === 0x6b ? 'mp3' : ot === 0xa5 ? 'ac3' : ot === 0xa6 ? 'eac3' : ot === 0xa9 ? 'dts' : 'aac';
      } else {
        codec = AUDIO_FOURCC[sampleType] || `other:${sampleType}`;
      }
    } else if (SUB_HANDLERS.has(handler)) {
      type = 'subtitle';
      codec = sampleType; // tx3g, wvtt, c608 ...
    }
    tracks.push({ type, codec, fourcc: sampleType, language });
  }
  return { tracks, duration };
}

/**
 * The tracks of an MP4/MOV file: { brand, duration, tracks: [{ type, codec, fourcc, language }],
 * moovAtEnd } or null when there is no moov box (not MP4, or cut off).
 */
export async function parseMp4(readAt: ReadAtFn, fileSize: number): Promise<ParsedMp4 | null> {
  const head = await readAt(0, Math.min(fileSize, 64 * 1024));
  if (!isMp4(head)) return null;
  const brand = fourcc(head, 4) === 'ftyp' ? fourcc(head, 8) : '';
  // Walk the top-level boxes by their headers only (mdat can be gigabytes)
  let pos = 0;
  let firstMdat = -1;
  while (pos + 8 <= fileSize) {
    const h = await readAt(pos, 16);
    if (h.length < 8) break;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    let header = 8;
    if (size === 1) {
      size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      header = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < header) break;
    if (type === 'mdat' && firstMdat < 0) firstMdat = pos;
    if (type === 'moov') {
      if (size > MAX_MOOV) return null;
      const moovBytes = await readAt(pos, size);
      const parsed = parseMoov(moovBytes, { type: 'moov', start: header, end: moovBytes.length });
      return { brand, ...parsed, moovAtEnd: firstMdat >= 0 && firstMdat < pos };
    }
    pos += size;
  }
  return null;
}
