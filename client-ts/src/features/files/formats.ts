/**
 * Format check for a local video: what's inside the file (container, video codec, audio tracks,
 * subtitle tracks) and whether this browser can play it.
 *
 *   probeFile(file)          -> format (small, plain object: it's sent to the room)
 *   checkPlayable(format)    -> { verdict: 'ok' | 'maybe' | 'no-video' | 'no-audio', ... } for this device
 *
 * format = { container, video: { codec, label } | null, audio: [{ codec, label, language, name }],
 *            subtitles: [{ number, codec, kind: 'text' | 'image', label, language, name, isDefault }],
 *            duration, moovAtEnd? }
 */
import { parseMkvHeader, isMatroska, isTextSubtitle, type ParsedMkvHeader } from './mkv';
import { parseMp4, isMp4, type ParsedMp4, type ReadAtFn } from './mp4';

export const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  mpeg4: 'MPEG-4 Part 2 (XviD/DivX)', mpeg2: 'MPEG-2', mpeg1: 'MPEG-1',
  theora: 'Theora', h263: 'H.263', mjpeg: 'Motion JPEG', prores: 'ProRes',
  vc1: 'VC-1', wmv: 'WMV', realvideo: 'RealVideo',
  aac: 'AAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis',
  flac: 'FLAC', alac: 'ALAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)',
  ac4: 'Dolby AC-4', dts: 'DTS', truehd: 'Dolby TrueHD', pcm: 'PCM', amr: 'AMR', wma: 'WMA'
};

export const CONTAINER_LABELS: Record<string, string> = {
  mp4: 'MP4', mov: 'MOV', webm: 'WebM', matroska: 'MKV', avi: 'AVI',
  asf: 'WMV/ASF', mpegts: 'MPEG-TS', flv: 'FLV', ogg: 'Ogg', unknown: 'Unknown'
};

export const codecLabel = (codec: string = ''): string =>
  CODEC_LABELS[codec] || (codec.startsWith('other:') ? codec.slice(6).trim() || 'unknown' : codec || 'unknown');

const MKV_VIDEO: [RegExp, string][] = [
  [/^V_MPEG4\/ISO\/AVC/, 'h264'], [/^V_MPEGH\/ISO\/HEVC/, 'hevc'], [/^V_AV1/, 'av1'], [/^V_VP9/, 'vp9'], [/^V_VP8/, 'vp8'],
  [/^V_MPEG4\/ISO\//, 'mpeg4'], [/^V_MS\/VFW\/FOURCC/, 'mpeg4'], [/^V_MPEG2/, 'mpeg2'], [/^V_MPEG1/, 'mpeg1'], [/^V_THEORA/, 'theora'],
  [/^V_REAL/, 'realvideo'], [/^V_MJPEG/, 'mjpeg'], [/^V_PRORES/, 'prores']
];

const MKV_AUDIO: [RegExp, string][] = [
  [/^A_AAC/, 'aac'], [/^A_MPEG\/L3/, 'mp3'], [/^A_MPEG\/L2/, 'mp2'], [/^A_OPUS/, 'opus'], [/^A_VORBIS/, 'vorbis'], [/^A_FLAC/, 'flac'],
  [/^A_EAC3/, 'eac3'], [/^A_AC3/, 'ac3'], [/^A_DTS/, 'dts'], [/^A_TRUEHD/, 'truehd'], [/^A_PCM/, 'pcm'], [/^A_ALAC/, 'alac'], [/^A_MS\/ACM/, 'wma']
];

const mkvCodec = (table: [RegExp, string][], id: string): string =>
  (table.find(([re]) => re.test(id)) || [null, `other:${id}`])[1];

const MKV_SUB_LABELS: Record<string, string> = {
  'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_ASS': 'ASS', 'S_SSA': 'SSA', 'S_TEXT/WEBVTT': 'WebVTT',
  'S_HDMV/PGS': 'PGS (picture)', 'S_VOBSUB': 'VobSub (picture)', 'S_DVBSUB': 'DVB (picture)', 'S_HDMV/TEXTST': 'HDMV text'
};

const readerFor = (file: Blob): ReadAtFn => async (pos: number, len: number) =>
  new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());

export interface VideoFormat {
  codec: string;
  label: string;
}

export interface AudioFormat {
  number: number;
  codec: string;
  codecId?: string;
  label: string;
  language: string;
  name: string;
  codecPrivate?: Uint8Array;
}

export interface SubtitleFormat {
  number: number;
  codec: string;
  kind: 'text' | 'image';
  label: string;
  language: string;
  name: string;
  isDefault?: boolean;
  isForced?: boolean;
  embeddedMp4?: boolean;
}

export interface FileFormat {
  container: string;
  video: VideoFormat | null;
  audio: AudioFormat[];
  subtitles: SubtitleFormat[];
  duration: number;
  timecodeScale?: number;
  moovAtEnd?: boolean;
}

/** From a parsed Matroska header to a format. */
export function formatFromMkv(header: ParsedMkvHeader): FileFormat {
  const tracks = header.tracks || [];
  const v = tracks.find((t) => t.type === 'video');
  const video: VideoFormat | null = v ? { codec: mkvCodec(MKV_VIDEO, v.codecId), label: '' } : null;
  if (video) video.label = codecLabel(video.codec);
  const audio: AudioFormat[] = tracks
    .filter((t) => t.type === 'audio')
    .map((t) => {
      const codec = mkvCodec(MKV_AUDIO, t.codecId);
      return {
        number: t.number,
        codec,
        codecId: t.codecId,
        label: codecLabel(codec),
        language: t.language,
        name: t.name,
        ...(t.codecPrivate ? { codecPrivate: t.codecPrivate } : {})
      };
    });
  const subtitles: SubtitleFormat[] = tracks
    .filter((t) => t.type === 'subtitle')
    .map((t) => ({
      number: t.number,
      codec: t.codecId,
      kind: isTextSubtitle(t.codecId) ? 'text' : 'image',
      label: MKV_SUB_LABELS[t.codecId] || t.codecId,
      language: t.language,
      name: t.name,
      isDefault: t.isDefault,
      isForced: t.isForced
    }));
  const scale = header.timecodeScale || 1000000;
  return {
    container: header.docType === 'webm' ? 'webm' : 'matroska',
    video,
    audio,
    subtitles,
    duration: header.duration ? Math.round((header.duration * scale) / 1e9) : 0,
    timecodeScale: scale
  };
}

export function formatFromMp4(info: ParsedMp4): FileFormat {
  const v = info.tracks.find((t) => t.type === 'video');
  const video: VideoFormat | null = v ? { codec: v.codec, label: codecLabel(v.codec) } : null;
  const audio: AudioFormat[] = info.tracks
    .filter((t) => t.type === 'audio')
    .map((t, i) => ({
      number: t.id || i + 1,
      codec: t.codec,
      label: codecLabel(t.codec),
      language: t.language,
      name: ''
    }));
  const subtitles: SubtitleFormat[] = info.tracks
    .filter((t) => t.type === 'subtitle')
    .map((t, i) => ({
      number: i + 1,
      codec: t.codec,
      kind: 'text',
      label: t.codec === 'tx3g' ? 'MP4 text' : t.codec,
      language: t.language,
      name: '',
      isDefault: false,
      embeddedMp4: true
    }));
  return {
    container: info.brand === 'qt  ' ? 'mov' : 'mp4',
    video,
    audio,
    subtitles,
    duration: Math.round(info.duration || 0),
    moovAtEnd: Boolean(info.moovAtEnd)
  };
}

/** Other containers, by their first bytes (we don't look inside these). */
export function sniffContainer(b: Uint8Array): string {
  const s = (p: number, n: number): string => String.fromCharCode(...b.subarray(p, p + n));
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 4) === 'AVI ') return 'avi';
  if (b.length >= 4 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'asf';
  if (b.length >= 3 && s(0, 3) === 'FLV') return 'flv';
  if (b.length >= 4 && s(0, 4) === 'OggS') return 'ogg';
  if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'mpegts';
  if (b.length >= 192 * 2 + 5 && b[4] === 0x47 && b[196] === 0x47) return 'mpegts'; // M2TS (Blu-ray)
  return 'unknown';
}

export interface ProbeFileOptions {
  readAt?: ReadAtFn;
}

/** What's inside a local video file. Never throws: an unreadable file gives container 'unknown'. */
export async function probeFile(
  file: Blob,
  { readAt = readerFor(file) }: ProbeFileOptions = {}
): Promise<FileFormat> {
  const size = file.size;
  const empty = (container: string): FileFormat => ({ container, video: null, audio: [], subtitles: [], duration: 0 });
  try {
    const head = await readAt(0, Math.min(size, 512 * 1024));
    if (isMatroska(head)) {
      let header = parseMkvHeader(head);
      if (!header && size > head.length) header = parseMkvHeader(await readAt(0, Math.min(size, 6 * 1024 * 1024)));
      return header ? formatFromMkv(header) : empty('matroska');
    }
    if (isMp4(head)) {
      const info = await parseMp4(readAt, size);
      return info ? formatFromMp4(info) : empty('mp4');
    }
    return empty(sniffContainer(head));
  } catch {
    return empty('unknown');
  }
}

// ---- can this browser play it ------------------------------------------------------------------

const VIDEO_TYPES: Record<string, string[]> = {
  h264: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'],
  av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'],
  vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.40.08"'],
  vp8: ['video/webm; codecs="vp8"'],
  theora: ['video/ogg; codecs="theora"']
};

const AUDIO_TYPES: Record<string, string[]> = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ['audio/mpeg', 'audio/mp4; codecs="mp4a.6B"'],
  opus: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'],
  flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
  ac3: ['audio/mp4; codecs="ac-3"'],
  eac3: ['audio/mp4; codecs="ec-3"'],
  alac: ['audio/mp4; codecs="alac"'],
  pcm: ['audio/wav'],
  dts: ['audio/mp4; codecs="dtsc"'],
  truehd: ['audio/mp4; codecs="mlpa"']
};

// Never in a browser
const NEVER = new Set<string>([
  'mpeg4', 'mpeg2', 'mpeg1', 'h263', 'prores', 'vc1', 'wmv', 'realvideo', 'mp2', 'wma', 'amr', 'ac4'
]);

const defaultCanPlay = ((): ((type: string) => string) => {
  let el: HTMLVideoElement | null = null;
  return (type: string): string => {
    try {
      el = el || document.createElement('video');
      return el.canPlayType(type);
    } catch {
      return '';
    }
  };
})();

export type SupportLevel = 'ok' | 'maybe' | 'no';

function codecSupport(
  codec: string | undefined,
  table: Record<string, string[]>,
  canPlay: (type: string) => string
): SupportLevel {
  if (!codec || NEVER.has(codec)) return 'no';
  const types = table[codec];
  if (!types) return codec.startsWith('other:') ? 'no' : 'maybe';
  return types.some((t) => canPlay(t)) ? 'ok' : 'no';
}

/** Chromium (Chrome, Edge, Brave, Opera, Samsung Internet) plays MKV even though it doesn't say so. */
const isChromium = (): boolean => {
  try {
    const nav = navigator as unknown as { userAgentData?: { brands?: Array<{ brand: string }> } };
    if (nav.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand))) return true;
    return /Chrome\/|CriOS|Edg\//.test(navigator.userAgent) && !/Version\/[\d.]+ Safari/.test(navigator.userAgent);
  } catch {
    return false;
  }
};

function containerSupport(
  container: string,
  canPlay: (type: string) => string,
  chromium: boolean
): SupportLevel {
  switch (container) {
    case 'mp4':
    case 'mov':
      return 'ok';
    case 'webm':
      return canPlay('video/webm') ? 'ok' : 'no';
    case 'matroska':
      return canPlay('video/x-matroska') || canPlay('video/mkv') || chromium ? 'ok' : 'maybe';
    case 'ogg':
      return canPlay('video/ogg') ? 'ok' : 'no';
    case 'avi':
    case 'asf':
    case 'flv':
    case 'mpegts':
      return 'no';
    default:
      return 'maybe';
  }
}

export type CheckPlayableVerdict = 'ok' | 'maybe' | 'no-video' | 'no-audio';

export interface CheckPlayableResult {
  verdict: CheckPlayableVerdict;
  container: SupportLevel;
  video: SupportLevel;
  audio: SupportLevel;
  message: string;
}

export interface CheckPlayableOptions {
  canPlay?: (type: string) => string;
  chromium?: boolean;
}

/**
 * Can this device play the file? (Pass `canPlay`/`chromium` to test.)
 * Returns { verdict, container, video, audio, message } where each part is 'ok' | 'maybe' | 'no'.
 *   verdict 'no-video': the picture won't play (or the file at all); 'no-audio': picture yes, no sound
 */
export function checkPlayable(
  format: FileFormat | null | undefined,
  { canPlay = defaultCanPlay, chromium = isChromium() }: CheckPlayableOptions = {}
): CheckPlayableResult {
  if (!format) return { verdict: 'maybe', container: 'maybe', video: 'maybe', audio: 'maybe', message: '' };
  const container = containerSupport(format.container, canPlay, chromium);
  const video = format.video
    ? codecSupport(format.video.codec, VIDEO_TYPES, canPlay)
    : (format.container === 'unknown' ? 'maybe' : 'ok');
  const first = format.audio?.[0];
  const audio = first ? codecSupport(first.codec, AUDIO_TYPES, canPlay) : 'ok';
  const cName = CONTAINER_LABELS[format.container] || format.container;
  let verdict: CheckPlayableVerdict = 'ok';
  let message = '';
  if (container === 'no') {
    verdict = 'no-video';
    message = `${cName} files don't play in browsers. Convert it to MP4 (H.264 + AAC), e.g. with HandBrake.`;
  } else if (video === 'no') {
    verdict = 'no-video';
    message = format.video?.codec === 'h264'
      ? 'This browser can\'t play H.264 video. Open 3RTC in Chrome, Edge, Safari or Firefox.'
      : `The video is ${format.video?.label || 'unknown'}, which this browser can't play.${format.video?.codec === 'hevc' ? ' HEVC plays only on some devices (Safari, or Chrome/Edge with hardware support).' : ''} Convert it to H.264, e.g. with HandBrake.`;
  } else if (audio === 'no') {
    verdict = 'no-audio';
    message = `The picture plays, but there will be no sound: the audio is ${first?.label || 'unknown'}, which this browser can't play. Convert the audio to AAC, e.g. with HandBrake.`;
  } else if (container === 'maybe' || video === 'maybe' || audio === 'maybe') {
    verdict = 'maybe';
    message = format.container === 'matroska' ? 'MKV files may not play in this browser (Chrome and Edge play them).' : '';
  }
  return { verdict, container, video, audio, message };
}

/** Is it worth telling the room about? */
export const isProblem = (check: { verdict?: string } | null | undefined): boolean =>
  Boolean(check && (check.verdict === 'no-video' || check.verdict === 'no-audio'));

/** One short line describing the file: "MKV · H.264 · AAC + 1 more audio · 3 subtitles" */
export function describeFormat(format: FileFormat | null | undefined): string {
  if (!format) return '';
  const parts: string[] = [CONTAINER_LABELS[format.container] || format.container];
  if (format.video) parts.push(format.video.label);
  if (format.audio?.length) parts.push(format.audio[0].label + (format.audio.length > 1 ? ` + ${format.audio.length - 1} more audio` : ''));
  if (format.subtitles?.length) parts.push(`${format.subtitles.length} subtitle${format.subtitles.length > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

/** The format as sent to the room: only known fields, short strings, bounded lists. */
export function cleanFormat(f: unknown): FileFormat | null {
  if (!f || typeof f !== 'object') return null;
  const raw = f as Record<string, unknown>;
  const str = (s: unknown, n: number = 40): string => (typeof s === 'string' ? s.slice(0, n) : '');
  const container = typeof raw.container === 'string' && Object.hasOwn(CONTAINER_LABELS, raw.container)
    ? raw.container
    : 'unknown';
  const rawVideo = raw.video as Record<string, unknown> | undefined;
  const video: VideoFormat | null = rawVideo && typeof rawVideo.codec === 'string'
    ? { codec: str(rawVideo.codec), label: codecLabel(str(rawVideo.codec)) }
    : null;
  const rawAudio = Array.isArray(raw.audio) ? (raw.audio as Array<Record<string, unknown>>) : [];
  const audio: AudioFormat[] = rawAudio.slice(0, 16).map((a) => ({
    number: Number.isInteger(a?.number) ? (a.number as number) : 0,
    codec: str(a?.codec),
    label: codecLabel(str(a?.codec)),
    language: str(a?.language, 12) || 'und',
    name: str(a?.name, 80),
    ...(a?.codecPrivate instanceof Uint8Array ? { codecPrivate: a.codecPrivate } : {})
  }));
  const rawSubs = Array.isArray(raw.subtitles) ? (raw.subtitles as Array<Record<string, unknown>>) : [];
  const subtitles: SubtitleFormat[] = rawSubs.slice(0, 32).map((s) => ({
    number: Number.isInteger(s?.number) ? (s.number as number) : 0,
    codec: str(s?.codec),
    kind: s?.kind === 'image' ? ('image' as const) : ('text' as const),
    label: str(s?.label),
    language: str(s?.language, 12) || 'und',
    name: str(s?.name, 80),
    isDefault: Boolean(s?.isDefault),
    ...(s?.embeddedMp4 ? { embeddedMp4: true } : {})
  }));
  return {
    container,
    video,
    audio,
    subtitles,
    duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? Math.max(0, Math.round(raw.duration)) : 0,
    ...(raw.timecodeScale ? { timecodeScale: Number(raw.timecodeScale) || 1000000 } : {}),
    ...(raw.moovAtEnd ? { moovAtEnd: true } : {})
  };
}

// Language codes as names (the common ones; others show the code)
const LANGS: Record<string, string> = {
  eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', kan: 'Kannada', kn: 'Kannada', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu',
  mal: 'Malayalam', ml: 'Malayalam', mar: 'Marathi', ben: 'Bengali', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean',
  chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic',
  tur: 'Turkish', dut: 'Dutch', nld: 'Dutch', pol: 'Polish', swe: 'Swedish', ind: 'Indonesian', tha: 'Thai', vie: 'Vietnamese', urd: 'Urdu'
};

export const languageName = (code: string = ''): string =>
  LANGS[code] || LANGS[code.split('-')[0]] || (code && code !== 'und' ? code : '');

/** "English (SDH) · SRT" */
export function subtitleTrackLabel(t: SubtitleFormat): string {
  const lang = languageName(t.language);
  const name = t.name && t.name !== lang ? t.name : '';
  const main = [lang, name].filter(Boolean).join(' – ') || `Track ${t.number}`;
  return `${main}${t.isForced ? ' (forced)' : ''} · ${t.label}`;
}

/** "Safari on iPhone" */
export function deviceName(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
