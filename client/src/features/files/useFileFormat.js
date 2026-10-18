/**
 * Format check and embedded subtitles for the local video being shared.
 *
 * The person sharing a file reads its header (formats.js) and tells the room what's inside;
 * every device checks whether it can play that and answers, so the sharer sees who will have
 * no picture or no sound before pressing play. Viewers see their own warning even before the
 * stream starts. Late joiners get the format when their channel opens.
 *
 * Subtitle tracks inside the file (MKV) can be picked by anyone: the sharer's app reads them
 * out of the file and shares them like a dropped .srt (the existing 'subtitle-share').
 *
 * Wire (apps without this ignore all of it):
 *   'file-format'            { fileName, fileSize, format }                (sharer -> all / newcomer)
 *   'file-format-report'     { fileName, verdict, message, device }        (viewer -> sharer)
 *   'file-subtitle-request'  { fileName, track }                           (viewer -> sharer)
 *   'file-subtitle-progress' { fileName, track, progress, done?, error? }  (sharer -> all)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePeerMessageOn, useBusEventOn } from '../../core/RoomContext';
import { probeFile, checkPlayable, cleanFormat, isProblem, subtitleTrackLabel, deviceName } from './formats';
import { canExtract, extractSubtitleTrack, cuesToVtt } from './extractSubtitles';
import { transcodeAudioTrack } from '../audio/audioTranscoder';

export function useFileFormat({ room, playback }) {
    const { bus } = room;
    const file = playback.localVideoFile;
    const fileName = file?.name || playback.remoteLocalVideoMeta?.fileName || null;
    const isOwner = Boolean(file);

    const [formats, setFormats] = useState({});     // fileName -> { format, from, sender }
    const [ownFormat, setOwnFormat] = useState(null); // the file we share: { fileName, format }
    const [reports, setReports] = useState({});     // peerId -> { name, verdict, message, device }
    const [job, setJob] = useState(null);           // { track, label, progress, error, asked }
    const [audioJob, setAudioJob] = useState(null);   // { trackNumber, progress, stage, error, done, url }
    const [transcodedAudioUrl, setTranscodedAudioUrl] = useState(null);
    const transcodeAbortRef = useRef(null);
    const [pendingSubtitle, setPendingSubtitle] = useState(null); // { id, fileName, vttString }: for the player to load & share
    const extractedRef = useRef(new Map());         // `${fileName}#${track}` -> vtt
    const busyRef = useRef(false);
    const fileRef = useRef(file);
    fileRef.current = file;
    const ownFormatRef = useRef(null);
    ownFormatRef.current = ownFormat;

    // ---- the sharer: read the file's header, tell the room ------------------------------------
    useEffect(() => {
        setReports({});
        setJob(null);
        setAudioJob(null);
        setTranscodedAudioUrl(null);
        if (transcodeAbortRef.current) {
            transcodeAbortRef.current.abort();
            transcodeAbortRef.current = null;
        }
        setPendingSubtitle(null);
        if (!file) {
            setOwnFormat(null);
            return undefined;
        }
        let alive = true;
        probeFile(file).then((raw) => {
            if (!alive) return;
            const format = cleanFormat(raw);
            setOwnFormat({ fileName: file.name, fileSize: file.size, format });
            bus.broadcast('file-format', { fileName: file.name, fileSize: file.size, format });
        });
        return () => { alive = false; };
    }, [file, bus]);

    useBusEventOn(bus, 'peer-open', (peerId) => {
        const own = ownFormatRef.current;
        if (own && fileRef.current?.name === own.fileName) bus.send(peerId, 'file-format', own);
    });
    useBusEventOn(bus, 'peer-close', (peerId) => {
        setReports((r) => {
            if (!r[peerId]) return r;
            const next = { ...r };
            delete next[peerId];
            return next;
        });
    });

    useBusEventOn(bus, 'room-left', () => {
        setFormats({});
        setReports({});
        setJob(null);
        setPendingSubtitle(null);
    });

    usePeerMessageOn(bus, 'file-format-report', (data, from) => {
        if (!fileRef.current || data?.fileName !== fileRef.current.name) return;
        const verdict = ['ok', 'maybe', 'no-video', 'no-audio'].includes(data.verdict) ? data.verdict : 'maybe';
        setReports((r) => ({
            ...r,
            [from]: { name: String(data.sender || 'Someone').slice(0, 40), verdict, message: String(data.message || '').slice(0, 300), device: String(data.device || '').slice(0, 60) }
        }));
    });

    // ---- everyone else: what's in the file they share, can we play it -------------------------
    usePeerMessageOn(bus, 'file-format', (data, from) => {
        if (!data?.fileName || typeof data.fileName !== 'string') return;
        const format = cleanFormat(data.format);
        if (!format) return;
        if (fileRef.current?.name === data.fileName) return; // we have it ourselves
        setPendingSubtitle(null);
        setJob(null);
        setFormats((f) => ({ ...f, [data.fileName]: { format, from, sender: data.sender } }));
        const check = checkPlayable(format);
        bus.send(from, 'file-format-report', { fileName: data.fileName, verdict: check.verdict, message: check.message, device: deviceName() });
    });

    // ---- subtitle tracks inside the file -------------------------------------------------------
    const extract = useCallback(async (trackNumber) => {
        const f = fileRef.current;
        const own = ownFormatRef.current;
        if (!f || !own || own.fileName !== f.name) return;
        const track = own.format.subtitles.find((s) => s.number === trackNumber);
        if (!canExtract(track)) return;
        const label = subtitleTrackLabel(track).replace(/ · .*$/, '');
        const name = `${label} (from the video).vtt`;
        const key = `${f.name}#${trackNumber}`;
        const progress = (p, extra = {}) => bus.broadcast('file-subtitle-progress', { fileName: f.name, track: trackNumber, progress: p, ...extra });
        if (extractedRef.current.has(key)) {
            const cached = extractedRef.current.get(key);
            if (cached instanceof Uint8Array) {
                setPendingSubtitle({ id: Date.now(), fileName: name, isPgs: true, supBytes: cached, trackNumber });
            } else {
                setPendingSubtitle({ id: Date.now(), fileName: name, vttString: cached, trackNumber });
            }
            return;
        }
        if (busyRef.current) return;
        busyRef.current = true;
        setJob({ track: trackNumber, label, progress: 0 });
        progress(0);
        let lastSent = 0;
        try {
            const cues = await extractSubtitleTrack(f, track, {
                timecodeScale: own.format.timecodeScale || 1000000,
                onProgress: (p) => {
                    if (fileRef.current !== f) return;
                    setJob((j) => (j && j.track === trackNumber ? { ...j, progress: p } : j));
                    if (p - lastSent >= 0.1) {
                        lastSent = p;
                        progress(p);
                    }
                }
            });
            if (fileRef.current !== f) return;
            if (cues?.isPgs) {
                if (!cues.supBytes?.length) throw new Error('That subtitle track is empty');
                extractedRef.current.set(key, cues.supBytes);
                setPendingSubtitle({ id: Date.now(), fileName: name, isPgs: true, supBytes: cues.supBytes, trackNumber });
                setJob(null);
                progress(1, { done: true });
                return;
            }
            if (!cues.length) throw new Error('That subtitle track is empty');
            const vtt = cuesToVtt(cues);
            extractedRef.current.set(key, vtt);
            setPendingSubtitle({ id: Date.now(), fileName: name, vttString: vtt, trackNumber });
            setJob(null);
            progress(1, { done: true });
        } catch (err) {
            const message = err?.message || 'Could not read the subtitles';
            setJob({ track: trackNumber, label, error: message });
            progress(0, { error: message });
        } finally {
            busyRef.current = false;
        }
    }, [bus]);

    usePeerMessageOn(bus, 'file-subtitle-request', (data) => {
        if (fileRef.current && data?.fileName === fileRef.current.name && Number.isInteger(data.track)) extract(data.track);
    });

    usePeerMessageOn(bus, 'file-subtitle-progress', (data) => {
        if (fileRef.current || !data?.fileName || data.fileName !== fileName) return;
        const track = formats[data.fileName]?.format.subtitles.find((s) => s.number === data.track);
        const label = track ? subtitleTrackLabel(track).replace(/ · .*$/, '') : 'Subtitles';
        if (data.done) setJob(null);
        else if (data.error) setJob({ track: data.track, label, error: String(data.error).slice(0, 200) });
        else setJob({ track: data.track, label, progress: Math.max(0, Math.min(1, Number(data.progress) || 0)) });
    });

    // Someone shared subtitles (any way): nothing left to wait for
    usePeerMessageOn(bus, 'local-video-action', (data) => {
        if (data?.action === 'subtitle-share' || data?.subAction === 'share') setJob((j) => (j && !j.progress && !j.error ? null : j));
    });

    const remote = fileName && !isOwner ? formats[fileName] : null;
    const format = isOwner ? (ownFormat?.fileName === fileName ? ownFormat.format : null) : remote?.format || null;

    const pickSubtitle = useCallback((trackNumber) => {
        if (fileRef.current) {
            extract(trackNumber);
            return;
        }
        if (!remote) return;
        const track = remote.format.subtitles.find((s) => s.number === trackNumber);
        if (!canExtract(track)) return;
        const label = subtitleTrackLabel(track).replace(/ · .*$/, '');
        setJob({ track: trackNumber, label, asked: true, progress: 0 });
        bus.send(remote.from, 'file-subtitle-request', { fileName, track: trackNumber });
        // No answer (they left, or their app can't): say so instead of waiting forever
        setTimeout(() => setJob((j) => (j && j.asked && j.track === trackNumber && !j.progress ? { track: trackNumber, label, error: `no answer from ${remote.sender || 'the person sharing the file'}` } : j)), 20000);
    }, [bus, extract, fileName, remote]);

    const transcodeAudio = useCallback(async (trackNumber) => {
        if (!fileRef.current) return;
        if (transcodeAbortRef.current) {
            transcodeAbortRef.current.abort();
        }
        const ac = new AbortController();
        transcodeAbortRef.current = ac;

        setAudioJob({ trackNumber, progress: 0.05, stage: 'Preparing transcoder…', error: null, done: false });
        try {
            const result = await transcodeAudioTrack(fileRef.current, {
                format,
                trackNumber,
                onProgress: (p, stage) => {
                    setAudioJob((prev) => prev ? { ...prev, progress: p, stage } : { trackNumber, progress: p, stage });
                },
                signal: ac.signal
            });
            setAudioJob({ trackNumber, progress: 1, stage: 'Complete', done: true, url: result.url });
            setTranscodedAudioUrl(result.url);
        } catch (err) {
            if (ac.signal.aborted) return;
            setAudioJob({ trackNumber, progress: 0, error: err?.message || 'Audio conversion failed', done: false });
        } finally {
            if (transcodeAbortRef.current === ac) {
                transcodeAbortRef.current = null;
            }
        }
    }, [format]);

    const cancelTranscode = useCallback(() => {
        if (transcodeAbortRef.current) {
            transcodeAbortRef.current.abort();
            transcodeAbortRef.current = null;
        }
        setAudioJob(null);
    }, []);

    const clearTranscodedAudio = useCallback(() => {
        if (transcodeAbortRef.current) {
            transcodeAbortRef.current.abort();
            transcodeAbortRef.current = null;
        }
        setAudioJob(null);
        setTranscodedAudioUrl(null);
    }, []);

    const check = useMemo(() => (format ? checkPlayable(format) : null), [format]);
    const problems = useMemo(() => (isOwner ? Object.values(reports).filter(isProblem) : []), [isOwner, reports]);

    return {
        fileName,
        isOwner,
        format,
        check,
        sharedBy: remote?.sender || '',
        problems,
        job,
        pendingSubtitle,
        pickSubtitle,
        audioJob,
        transcodedAudioUrl,
        transcodeAudio,
        cancelTranscode,
        clearTranscodedAudio
    };
}
