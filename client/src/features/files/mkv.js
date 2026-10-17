/**
 * Matroska / WebM: the tracks in a file (codecs, languages, subtitle tracks) from its first few
 * hundred KB, and the text of its subtitle tracks (SRT, ASS/SSA, WebVTT) by reading the whole
 * file once (see extractMkvSubtitles; the app runs it in a worker).
 */
import { readElementHeader, readVint, readUint, readFloat, readString, UNKNOWN_SIZE } from './ebml';

const ID = {
    EBML: 0x1a45dfa3, DocType: 0x4282,
    Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
    Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
    CodecPrivate: 0x63a2, Language: 0x22b59c, LanguageIETF: 0x22b59d, Name: 0x536e, FlagDefault: 0x88, FlagForced: 0x55aa,
    Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b
};
const TRACK_TYPE = { 1: 'video', 2: 'audio', 17: 'subtitle' };
// Containers we look inside while reading the whole file; anything else is skipped by its size
const CONTAINERS = new Set([ID.Segment, ID.Cluster, ID.BlockGroup]);

/** Is this the start of a Matroska/WebM file? */
export const isMatroska = (bytes) => bytes.length >= 4 && readUint(bytes, 0, 4) === ID.EBML;

function parseTrackEntry(bytes, start, end) {
    const t = { number: 0, type: 'other', codecId: '', language: 'und', name: '', isDefault: true, isForced: false, codecPrivate: null };
    let pos = start;
    while (pos < end) {
        const h = readElementHeader(bytes, pos);
        if (!h || h.size === UNKNOWN_SIZE) break;
        const d = pos + h.headerLength;
        if (d + h.size > bytes.length) break;
        switch (h.id) {
            case ID.TrackNumber: t.number = readUint(bytes, d, h.size); break;
            case ID.TrackType: t.type = TRACK_TYPE[readUint(bytes, d, h.size)] || 'other'; break;
            case ID.CodecID: t.codecId = readString(bytes, d, h.size); break;
            case ID.Language: t.language = readString(bytes, d, h.size) || 'und'; break;
            case ID.LanguageIETF: t.language = readString(bytes, d, h.size) || t.language; break;
            case ID.Name: t.name = readString(bytes, d, h.size); break;
            case ID.FlagDefault: t.isDefault = readUint(bytes, d, h.size) === 1; break;
            case ID.FlagForced: t.isForced = readUint(bytes, d, h.size) === 1; break;
            case ID.CodecPrivate: t.codecPrivate = bytes.slice(d, d + h.size); break;
            default: break;
        }
        pos = d + h.size;
    }
    return t;
}

/**
 * The header of a Matroska file from its first bytes: { docType, timecodeScale, duration, tracks }.
 * Returns null if `bytes` isn't Matroska or the Tracks element isn't in it.
 */
export function parseMkvHeader(bytes) {
    if (!isMatroska(bytes)) return null;
    const out = { docType: 'matroska', timecodeScale: 1000000, duration: 0, tracks: null };
    let pos = 0;
    const walk = (start, end, inSegment) => {
        let p = start;
        while (p < end) {
            const h = readElementHeader(bytes, p);
            if (!h) return;
            const d = p + h.headerLength;
            const stop = h.size === UNKNOWN_SIZE ? end : d + h.size;
            if (h.id === ID.EBML) walk(d, Math.min(stop, bytes.length), false);
            else if (h.id === ID.DocType) out.docType = readString(bytes, d, h.size);
            else if (h.id === ID.Segment) { walk(d, Math.min(stop, bytes.length), true); return; }
            else if (inSegment && h.id === ID.Info) walk(d, Math.min(stop, bytes.length), true);
            else if (h.id === ID.TimecodeScale) out.timecodeScale = readUint(bytes, d, h.size);
            else if (h.id === ID.Duration) out.duration = readFloat(bytes, d, h.size);
            else if (inSegment && h.id === ID.Tracks) {
                out.tracks = [];
                let q = d;
                const tracksEnd = Math.min(stop, bytes.length);
                while (q < tracksEnd) {
                    const th = readElementHeader(bytes, q);
                    if (!th || th.size === UNKNOWN_SIZE) break;
                    const td = q + th.headerLength;
                    if (th.id === ID.TrackEntry) out.tracks.push(parseTrackEntry(bytes, td, Math.min(td + th.size, bytes.length)));
                    q = td + th.size;
                }
            } else if (inSegment && h.id === ID.Cluster) return; // past the header
            if (h.size === UNKNOWN_SIZE) return;
            p = stop;
        }
    };
    walk(pos, bytes.length, false);
    return out.tracks ? out : null;
}

// ---- subtitles ---------------------------------------------------------------------------------

export const TEXT_SUBTITLE_CODECS = new Set(['S_TEXT/UTF8', 'S_TEXT/SSA', 'S_TEXT/ASS', 'S_TEXT/WEBVTT', 'S_SSA', 'S_ASS']);
export const isTextSubtitle = (codecId) => TEXT_SUBTITLE_CODECS.has(codecId);

/** The visible text of one ASS/SSA event ("ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"). */
export function assEventText(line) {
    let rest = line;
    for (let i = 0; i < 8; i++) {
        const comma = rest.indexOf(',');
        if (comma < 0) return line.trim();
        rest = rest.slice(comma + 1);
    }
    return rest
        .replace(/\{[^}]*\}/g, '')      // override tags {\i1} {\pos(..)}
        .replace(/\\[Nn]/g, '\n')
        .replace(/\\h/g, ' ')
        .trim();
}

const CHUNK = 8 * 1024 * 1024;

/**
 * Read the whole file once and collect the text of the given subtitle tracks.
 *   readAt(pos, length) -> Promise<Uint8Array>   (the file's bytes)
 *   tracks: [{ number, codecId }]
 * Returns Map(trackNumber -> [{ startSec, endSec, text }]).
 */
export async function extractMkvSubtitles(readAt, fileSize, tracks, { timecodeScale = 1000000, onProgress, isCancelled } = {}) {
    const wanted = new Map(tracks.map((t) => [t.number, t]));
    const cues = new Map(tracks.map((t) => [t.number, []]));
    const scale = timecodeScale / 1e9; // ticks -> seconds
    let win = new Uint8Array(0);
    let winStart = 0;
    const ensure = async (pos, need) => {
        if (pos >= winStart && pos + need <= winStart + win.length) return true;
        if (pos >= fileSize) return false;
        win = await readAt(pos, Math.min(Math.max(CHUNK, need), fileSize - pos));
        winStart = pos;
        return pos + need <= winStart + win.length;
    };
    const at = (pos) => pos - winStart;

    let pos = 0;
    let clusterTime = 0;
    let lastReport = 0;
    let pendingDuration = null; // BlockDuration of the current BlockGroup (after its Block, sometimes)
    let lastBlockCue = null;
    while (pos < fileSize) {
        if (isCancelled?.()) throw new Error('cancelled');
        if (!(await ensure(pos, 16))) {
            if (!(await ensure(pos, 2))) break;
        }
        const h = readElementHeader(win, at(pos));
        if (!h) break;
        const dataPos = pos + h.headerLength;
        if (CONTAINERS.has(h.id)) {
            if (h.id === ID.BlockGroup) { pendingDuration = null; lastBlockCue = null; }
            pos = dataPos; // look inside
            continue;
        }
        if (h.size === UNKNOWN_SIZE) break;
        if (h.id === ID.Timecode) {
            await ensure(dataPos, h.size);
            clusterTime = readUint(win, at(dataPos), h.size);
        } else if (h.id === ID.SimpleBlock || h.id === ID.Block) {
            await ensure(dataPos, Math.min(h.size, 8));
            const tn = readVint(win, at(dataPos));
            const track = tn && wanted.get(tn.value);
            if (track) {
                await ensure(dataPos, h.size);
                const o = at(dataPos) + tn.length;
                const rel = (win[o] << 8 | win[o + 1]) << 16 >> 16; // signed 16-bit
                const text = new TextDecoder('utf-8').decode(win.subarray(o + 3, at(dataPos) + h.size)).replace(/\0+$/, '').replace(/\r\n?/g, '\n');
                const startSec = (clusterTime + rel) * scale;
                const cue = { startSec, endSec: startSec + 3, guessed: true, text: track.codecId.includes('SSA') || track.codecId.includes('ASS') ? assEventText(text) : text.trim() };
                if (h.id === ID.Block && pendingDuration !== null) {
                    cue.endSec = startSec + pendingDuration * scale;
                    cue.guessed = false;
                }
                if (cue.text) cues.get(track.number).push(cue);
                lastBlockCue = h.id === ID.Block ? cue : null;
            }
        } else if (h.id === ID.BlockDuration) {
            await ensure(dataPos, h.size);
            pendingDuration = readUint(win, at(dataPos), h.size);
            if (lastBlockCue) {
                lastBlockCue.endSec = lastBlockCue.startSec + pendingDuration * scale;
                lastBlockCue.guessed = false;
            }
        }
        pos = dataPos + h.size;
        if (onProgress && pos - lastReport > CHUNK) {
            lastReport = pos;
            onProgress(Math.min(1, pos / fileSize));
        }
    }
    for (const list of cues.values()) {
        list.sort((a, b) => a.startSec - b.startSec);
        // Blocks without a duration: end at the next one (at most 6 s)
        for (let i = 0; i < list.length; i++) {
            if (list[i].guessed && list[i + 1]) list[i].endSec = Math.max(list[i].startSec + 0.5, Math.min(list[i + 1].startSec, list[i].startSec + 6));
            delete list[i].guessed;
        }
    }
    onProgress?.(1);
    return cues;
}

/**
 * Read the whole MKV/WebM file and collect the raw frames of the given audio track.
 * Returns Uint8Array of the concatenated raw audio bitstream.
 */
export async function extractMkvAudioTrack(readAt, fileSize, trackNumber, { onProgress, isCancelled } = {}) {
    let win = new Uint8Array(0);
    let winStart = 0;
    const ensure = async (pos, need) => {
        if (pos >= winStart && pos + need <= winStart + win.length) return true;
        if (pos >= fileSize) return false;
        win = await readAt(pos, Math.min(Math.max(CHUNK, need), fileSize - pos));
        winStart = pos;
        return pos + need <= winStart + win.length;
    };
    const at = (pos) => pos - winStart;

    const chunks = [];
    let totalBytes = 0;
    let pos = 0;
    let lastReport = 0;
    while (pos < fileSize) {
        if (isCancelled?.()) throw new Error('cancelled');
        if (!(await ensure(pos, 16))) {
            if (!(await ensure(pos, 2))) break;
        }
        const h = readElementHeader(win, at(pos));
        if (!h) break;
        const dataPos = pos + h.headerLength;
        if (CONTAINERS.has(h.id)) {
            pos = dataPos;
            continue;
        }
        if (h.size === UNKNOWN_SIZE) break;
        if (h.id === ID.SimpleBlock || h.id === ID.Block) {
            await ensure(dataPos, Math.min(h.size, 8));
            const tn = readVint(win, at(dataPos));
            if (tn && tn.value === trackNumber) {
                await ensure(dataPos, h.size);
                const o = at(dataPos) + tn.length;
                const payloadStart = o + 3;
                const payloadEnd = at(dataPos) + h.size;
                if (payloadEnd > payloadStart) {
                    const chunk = win.slice(payloadStart, payloadEnd);
                    chunks.push(chunk);
                    totalBytes += chunk.length;
                }
            }
        }
        pos = dataPos + h.size;
        if (onProgress && pos - lastReport > CHUNK) {
            lastReport = pos;
            onProgress(Math.min(1, pos / fileSize));
        }
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
    }
    onProgress?.(1);
    return combined;
}

/**
 * Read the whole MKV/WebM file and collect PGS subtitles (S_HDMV/PGS) into a compliant .sup bitstream.
 * Prepends standard 10-byte 'PG' header (Magic 0x50 0x47, 4-byte 90kHz PTS, 4-byte 90kHz DTS) to each segment.
 * Returns Uint8Array of the complete .sup bitstream.
 */
export async function extractMkvPgsSubtitles(readAt, fileSize, trackNumber, { timecodeScale = 1000000, onProgress, isCancelled } = {}) {
    let win = new Uint8Array(0);
    let winStart = 0;
    const ensure = async (pos, need) => {
        if (pos >= winStart && pos + need <= winStart + win.length) return true;
        if (pos >= fileSize) return false;
        win = await readAt(pos, Math.min(Math.max(CHUNK, need), fileSize - pos));
        winStart = pos;
        return pos + need <= winStart + win.length;
    };
    const at = (pos) => pos - winStart;
    const scale = timecodeScale / 1e9; // ticks -> seconds

    const chunks = [];
    let totalBytes = 0;
    let pos = 0;
    let clusterTime = 0;
    let lastReport = 0;

    while (pos < fileSize) {
        if (isCancelled?.()) throw new Error('cancelled');
        if (!(await ensure(pos, 16))) {
            if (!(await ensure(pos, 2))) break;
        }
        const h = readElementHeader(win, at(pos));
        if (!h) break;
        const dataPos = pos + h.headerLength;
        if (CONTAINERS.has(h.id)) {
            pos = dataPos;
            continue;
        }
        if (h.size === UNKNOWN_SIZE) break;
        if (h.id === ID.Timecode) {
            await ensure(dataPos, h.size);
            clusterTime = readUint(win, at(dataPos), h.size);
        } else if (h.id === ID.SimpleBlock || h.id === ID.Block) {
            await ensure(dataPos, Math.min(h.size, 8));
            const tn = readVint(win, at(dataPos));
            if (tn && tn.value === trackNumber) {
                await ensure(dataPos, h.size);
                const o = at(dataPos) + tn.length;
                const rel = (win[o] << 8 | win[o + 1]) << 16 >> 16;
                const blockTimeSec = Math.max(0, (clusterTime + rel) * scale);
                // 90 kHz PTS/DTS ticks for Blu-ray SUP format
                const pts = Math.round(blockTimeSec * 90000) >>> 0;
                const dts = pts;

                const payloadStart = o + 3;
                const payloadEnd = at(dataPos) + h.size;
                let segOffset = payloadStart;

                while (segOffset + 3 <= payloadEnd) {
                    const segLen = (win[segOffset + 1] << 8) | win[segOffset + 2];
                    const segTotalLen = 3 + segLen;
                    const end = Math.min(segOffset + segTotalLen, payloadEnd);
                    const actualLen = end - segOffset;

                    const supPacket = new Uint8Array(10 + actualLen);
                    supPacket[0] = 0x50; // 'P'
                    supPacket[1] = 0x47; // 'G'
                    supPacket[2] = (pts >>> 24) & 0xff;
                    supPacket[3] = (pts >>> 16) & 0xff;
                    supPacket[4] = (pts >>> 8) & 0xff;
                    supPacket[5] = pts & 0xff;
                    supPacket[6] = (dts >>> 24) & 0xff;
                    supPacket[7] = (dts >>> 16) & 0xff;
                    supPacket[8] = (dts >>> 8) & 0xff;
                    supPacket[9] = dts & 0xff;
                    supPacket.set(win.subarray(segOffset, end), 10);

                    chunks.push(supPacket);
                    totalBytes += supPacket.length;

                    segOffset += Math.max(1, segTotalLen);
                }
            }
        }
        pos = dataPos + h.size;
        if (onProgress && pos - lastReport > CHUNK) {
            lastReport = pos;
            onProgress(Math.min(1, pos / fileSize));
        }
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
    }
    onProgress?.(1);
    return combined;
}

