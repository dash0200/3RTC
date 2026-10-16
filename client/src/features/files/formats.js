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
import { parseMkvHeader, isMatroska, isTextSubtitle } from './mkv';
import { parseMp4, isMp4 } from './mp4';

export const CODEC_LABELS = {
    h264: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4 Part 2 (XviD/DivX)', mpeg2: 'MPEG-2', mpeg1: 'MPEG-1',
    theora: 'Theora', h263: 'H.263', mjpeg: 'Motion JPEG', prores: 'ProRes', vc1: 'VC-1', wmv: 'WMV', realvideo: 'RealVideo',
    aac: 'AAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)',
    ac4: 'Dolby AC-4', dts: 'DTS', truehd: 'Dolby TrueHD', pcm: 'PCM', amr: 'AMR', wma: 'WMA'
};
export const CONTAINER_LABELS = {
    mp4: 'MP4', mov: 'MOV', webm: 'WebM', matroska: 'MKV', avi: 'AVI', asf: 'WMV/ASF', mpegts: 'MPEG-TS', flv: 'FLV', ogg: 'Ogg', unknown: 'Unknown'
};
export const codecLabel = (codec = '') => CODEC_LABELS[codec] || (codec.startsWith('other:') ? codec.slice(6).trim() || 'unknown' : codec || 'unknown');

const MKV_VIDEO = [
    [/^V_MPEG4\/ISO\/AVC/, 'h264'], [/^V_MPEGH\/ISO\/HEVC/, 'hevc'], [/^V_AV1/, 'av1'], [/^V_VP9/, 'vp9'], [/^V_VP8/, 'vp8'],
    [/^V_MPEG4\/ISO\//, 'mpeg4'], [/^V_MS\/VFW\/FOURCC/, 'mpeg4'], [/^V_MPEG2/, 'mpeg2'], [/^V_MPEG1/, 'mpeg1'], [/^V_THEORA/, 'theora'],
    [/^V_REAL/, 'realvideo'], [/^V_MJPEG/, 'mjpeg'], [/^V_PRORES/, 'prores']
];
const MKV_AUDIO = [
    [/^A_AAC/, 'aac'], [/^A_MPEG\/L3/, 'mp3'], [/^A_MPEG\/L2/, 'mp2'], [/^A_OPUS/, 'opus'], [/^A_VORBIS/, 'vorbis'], [/^A_FLAC/, 'flac'],
    [/^A_EAC3/, 'eac3'], [/^A_AC3/, 'ac3'], [/^A_DTS/, 'dts'], [/^A_TRUEHD/, 'truehd'], [/^A_PCM/, 'pcm'], [/^A_ALAC/, 'alac'], [/^A_MS\/ACM/, 'wma']
];
const mkvCodec = (table, id) => (table.find(([re]) => re.test(id)) || [null, `other:${id}`])[1];
const MKV_SUB_LABELS = {
    'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_ASS': 'ASS', 'S_SSA': 'SSA', 'S_TEXT/WEBVTT': 'WebVTT',
    'S_HDMV/PGS': 'PGS (picture)', 'S_VOBSUB': 'VobSub (picture)', 'S_DVBSUB': 'DVB (picture)', 'S_HDMV/TEXTST': 'HDMV text'
};

const readerFor = (file) => async (pos, len) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());

/** From a parsed Matroska header to a format. */
export function formatFromMkv(header) {
    const tracks = header.tracks || [];
    const v = tracks.find((t) => t.type === 'video');
    const video = v ? { codec: mkvCodec(MKV_VIDEO, v.codecId) } : null;
    if (video) video.label = codecLabel(video.codec);
    const audio = tracks.filter((t) => t.type === 'audio').map((t) => {
        const codec = mkvCodec(MKV_AUDIO, t.codecId);
        return { codec, label: codecLabel(codec), language: t.language, name: t.name };
    });
    const subtitles = tracks.filter((t) => t.type === 'subtitle').map((t) => ({
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

export function formatFromMp4(info) {
    const v = info.tracks.find((t) => t.type === 'video');
    const video = v ? { codec: v.codec, label: codecLabel(v.codec) } : null;
    const audio = info.tracks.filter((t) => t.type === 'audio').map((t) => ({ codec: t.codec, label: codecLabel(t.codec), language: t.language, name: '' }));
    const subtitles = info.tracks.filter((t) => t.type === 'subtitle').map((t, i) => ({
        number: i + 1, codec: t.codec, kind: 'text', label: t.codec === 'tx3g' ? 'MP4 text' : t.codec, language: t.language, name: '', isDefault: false, embeddedMp4: true
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
export function sniffContainer(b) {
    const s = (p, n) => String.fromCharCode(...b.subarray(p, p + n));
    if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 4) === 'AVI ') return 'avi';
    if (b.length >= 4 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'asf';
    if (b.length >= 3 && s(0, 3) === 'FLV') return 'flv';
    if (b.length >= 4 && s(0, 4) === 'OggS') return 'ogg';
    if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'mpegts';
    if (b.length >= 192 * 2 + 5 && b[4] === 0x47 && b[196] === 0x47) return 'mpegts'; // M2TS (Blu-ray)
    return 'unknown';
}

/** What's inside a local video file. Never throws: an unreadable file gives container 'unknown'. */
export async function probeFile(file, { readAt = readerFor(file) } = {}) {
    const size = file.size;
    const empty = (container) => ({ container, video: null, audio: [], subtitles: [], duration: 0 });
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

const VIDEO_TYPES = {
    h264: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
    hevc: ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'],
    av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'],
    vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.40.08"'],
    vp8: ['video/webm; codecs="vp8"'],
    theora: ['video/ogg; codecs="theora"']
};
const AUDIO_TYPES = {
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
const NEVER = new Set(['mpeg4', 'mpeg2', 'mpeg1', 'h263', 'prores', 'vc1', 'wmv', 'realvideo', 'mp2', 'wma', 'amr', 'ac4']);

const defaultCanPlay = (() => {
    let el = null;
    return (type) => {
        try {
            el = el || document.createElement('video');
            return el.canPlayType(type);
        } catch {
            return '';
        }
    };
})();

function codecSupport(codec, table, canPlay) {
    if (!codec || NEVER.has(codec)) return 'no';
    const types = table[codec];
    if (!types) return codec.startsWith('other:') ? 'no' : 'maybe';
    return types.some((t) => canPlay(t)) ? 'ok' : 'no';
}

/** Chromium (Chrome, Edge, Brave, Opera, Samsung Internet) plays MKV even though it doesn't say so. */
const isChromium = () => {
    try {
        if (navigator.userAgentData?.brands?.some((b) => /Chromium/i.test(b.brand))) return true;
        return /Chrome\/|CriOS|Edg\//.test(navigator.userAgent) && !/Version\/[\d.]+ Safari/.test(navigator.userAgent);
    } catch {
        return false;
    }
};

function containerSupport(container, canPlay, chromium) {
    switch (container) {
        case 'mp4': case 'mov': return 'ok';
        case 'webm': return canPlay('video/webm') ? 'ok' : 'no';
        case 'matroska': return canPlay('video/x-matroska') || canPlay('video/mkv') || chromium ? 'ok' : 'maybe';
        case 'ogg': return canPlay('video/ogg') ? 'ok' : 'no';
        case 'avi': case 'asf': case 'flv': case 'mpegts': return 'no';
        default: return 'maybe';
    }
}

/**
 * Can this device play the file? (Pass `canPlay`/`chromium` to test.)
 * Returns { verdict, container, video, audio, message } where each part is 'ok' | 'maybe' | 'no'.
 *   verdict 'no-video': the picture won't play (or the file at all); 'no-audio': picture yes, no sound
 */
export function checkPlayable(format, { canPlay = defaultCanPlay, chromium = isChromium() } = {}) {
    if (!format) return { verdict: 'maybe', container: 'maybe', video: 'maybe', audio: 'maybe', message: '' };
    const container = containerSupport(format.container, canPlay, chromium);
    const video = format.video ? codecSupport(format.video.codec, VIDEO_TYPES, canPlay) : (format.container === 'unknown' ? 'maybe' : 'ok');
    const first = format.audio?.[0];
    const audio = first ? codecSupport(first.codec, AUDIO_TYPES, canPlay) : 'ok';
    const cName = CONTAINER_LABELS[format.container] || format.container;
    let verdict = 'ok';
    let message = '';
    if (container === 'no') {
        verdict = 'no-video';
        message = `${cName} files don't play in browsers. Convert it to MP4 (H.264 + AAC), e.g. with HandBrake.`;
    } else if (video === 'no') {
        verdict = 'no-video';
        message = format.video.codec === 'h264'
            ? 'This browser can\'t play H.264 video. Open 3RTC in Chrome, Edge, Safari or Firefox.'
            : `The video is ${format.video.label}, which this browser can't play.${format.video.codec === 'hevc' ? ' HEVC plays only on some devices (Safari, or Chrome/Edge with hardware support).' : ''} Convert it to H.264, e.g. with HandBrake.`;
    } else if (audio === 'no') {
        verdict = 'no-audio';
        message = `The picture plays, but there will be no sound: the audio is ${first.label}, which this browser can't play. Convert the audio to AAC, e.g. with HandBrake.`;
    } else if (container === 'maybe' || video === 'maybe' || audio === 'maybe') {
        verdict = 'maybe';
        message = format.container === 'matroska' ? 'MKV files may not play in this browser (Chrome and Edge play them).' : '';
    }
    return { verdict, container, video, audio, message };
}

/** Is it worth telling the room about? */
export const isProblem = (check) => check && (check.verdict === 'no-video' || check.verdict === 'no-audio');

/** One short line describing the file: "MKV · H.264 · AAC + 1 more audio · 3 subtitles" */
export function describeFormat(format) {
    if (!format) return '';
    const parts = [CONTAINER_LABELS[format.container] || format.container];
    if (format.video) parts.push(format.video.label);
    if (format.audio?.length) parts.push(format.audio[0].label + (format.audio.length > 1 ? ` + ${format.audio.length - 1} more audio` : ''));
    if (format.subtitles?.length) parts.push(`${format.subtitles.length} subtitle${format.subtitles.length > 1 ? 's' : ''}`);
    return parts.join(' · ');
}

/** The format as sent to the room: only known fields, short strings, bounded lists. */
export function cleanFormat(f) {
    if (!f || typeof f !== 'object') return null;
    const str = (s, n = 40) => (typeof s === 'string' ? s.slice(0, n) : '');
    const container = Object.hasOwn(CONTAINER_LABELS, f.container) ? f.container : 'unknown';
    const video = f.video && typeof f.video.codec === 'string' ? { codec: str(f.video.codec), label: codecLabel(str(f.video.codec)) } : null;
    const audio = (Array.isArray(f.audio) ? f.audio : []).slice(0, 16).map((a) => ({
        codec: str(a?.codec), label: codecLabel(str(a?.codec)), language: str(a?.language, 12) || 'und', name: str(a?.name, 80)
    }));
    const subtitles = (Array.isArray(f.subtitles) ? f.subtitles : []).slice(0, 32).map((s) => ({
        number: Number.isInteger(s?.number) ? s.number : 0,
        codec: str(s?.codec),
        kind: s?.kind === 'image' ? 'image' : 'text',
        label: str(s?.label),
        language: str(s?.language, 12) || 'und',
        name: str(s?.name, 80),
        isDefault: Boolean(s?.isDefault),
        ...(s?.embeddedMp4 ? { embeddedMp4: true } : {})
    }));
    return {
        container, video, audio, subtitles,
        duration: Number.isFinite(f.duration) ? Math.max(0, Math.round(f.duration)) : 0,
        ...(f.timecodeScale ? { timecodeScale: Number(f.timecodeScale) || 1000000 } : {}),
        ...(f.moovAtEnd ? { moovAtEnd: true } : {})
    };
}

// Language codes as names (the common ones; others show the code)
const LANGS = {
    eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', kan: 'Kannada', kn: 'Kannada', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu',
    mal: 'Malayalam', ml: 'Malayalam', mar: 'Marathi', ben: 'Bengali', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
    ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean',
    chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic',
    tur: 'Turkish', dut: 'Dutch', nld: 'Dutch', pol: 'Polish', swe: 'Swedish', ind: 'Indonesian', tha: 'Thai', vie: 'Vietnamese', urd: 'Urdu'
};
export const languageName = (code = '') => LANGS[code] || LANGS[code.split('-')[0]] || (code && code !== 'und' ? code : '');

/** "English (SDH) · SRT" */
export function subtitleTrackLabel(t) {
    const lang = languageName(t.language);
    const name = t.name && t.name !== lang ? t.name : '';
    const main = [lang, name].filter(Boolean).join(' – ') || `Track ${t.number}`;
    return `${main}${t.isForced ? ' (forced)' : ''} · ${t.label}`;
}

/** "Safari on iPhone" */
export function deviceName(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
    const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
}
