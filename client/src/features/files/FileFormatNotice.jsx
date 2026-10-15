/**
 * Shown on the local video player: "this file won't play / has no sound here" (for this device,
 * and for the sharer: on whose devices), and the subtitle tracks inside the file to pick from.
 * Each part can be closed; it comes back for the next file.
 */
import { useEffect, useState } from 'react';
import { describeFormat, subtitleTrackLabel, languageName } from './formats';
import { canExtract } from './extractSubtitles';

const pct = (p) => `${Math.round((p || 0) * 100)}%`;

export default function FileFormatNotice({ info, hasSubtitles = false, compact = false }) {
    const [closed, setClosed] = useState({});
    const fileName = info?.fileName;
    useEffect(() => setClosed({}), [fileName]);
    // The audio-track note is only information: it goes away by itself
    const audioCount = info?.format?.audio?.length || 0;
    useEffect(() => {
        if (audioCount < 2) return undefined;
        const t = setTimeout(() => setClosed((c) => ({ ...c, audio: true })), 20000);
        return () => clearTimeout(t);
    }, [fileName, audioCount]);
    if (!info || !info.format) return null;
    const { format, check, problems = [], job, isOwner, sharedBy } = info;
    const close = (key) => setClosed((c) => ({ ...c, [key]: true }));

    const textTracks = format.subtitles.filter(canExtract);
    const pictureTracks = format.subtitles.filter((s) => !canExtract(s));
    const ownProblem = check && (check.verdict === 'no-video' || check.verdict === 'no-audio');
    const showOwn = ownProblem && !closed.own;
    const showOthers = isOwner && problems.length > 0 && !closed.others;
    const showSubs = (textTracks.length > 0 || pictureTracks.length > 0) && (!hasSubtitles || job) && !closed.subs;
    const showAudioNote = format.audio.length > 1 && !closed.audio && !ownProblem;
    if (!showOwn && !showOthers && !showSubs && !showAudioNote) return null;

    return (
        <div className={`file-notice ${compact ? 'is-compact' : ''}`} data-file-notice>
            {showOwn && (
                <div className={`file-notice-row is-${check.verdict}`} role="alert" data-notice="own">
                    <span className="file-notice-icon">{check.verdict === 'no-audio' ? '🔇' : '⚠️'}</span>
                    <div className="file-notice-text">
                        <strong>{check.verdict === 'no-audio' ? 'No sound on this device' : 'This video won\'t play on this device'}</strong>
                        <span>{check.message}</span>
                        <span className="file-notice-meta">{describeFormat(format)}{!isOwner && sharedBy ? ` · shared by ${sharedBy}` : ''}</span>
                    </div>
                    <button type="button" className="file-notice-close" aria-label="Close" onClick={() => close('own')}>✕</button>
                </div>
            )}
            {showOthers && (
                <div className="file-notice-row is-others" role="status" data-notice="others">
                    <span className="file-notice-icon">👥</span>
                    <div className="file-notice-text">
                        <strong>{problems.length === 1 ? '1 person' : `${problems.length} people`} may not be able to watch this</strong>
                        {problems.slice(0, 4).map((p, i) => (
                            <span key={i} className="file-notice-person">
                                {p.name}{p.device ? ` (${p.device})` : ''}: {p.verdict === 'no-audio' ? 'no sound' : 'no picture'}
                            </span>
                        ))}
                        {problems.length > 4 && <span className="file-notice-person">and {problems.length - 4} more</span>}
                        <span className="file-notice-meta">{describeFormat(format)}. An MP4 with H.264 video and AAC audio plays everywhere.</span>
                    </div>
                    <button type="button" className="file-notice-close" aria-label="Close" onClick={() => close('others')}>✕</button>
                </div>
            )}
            {showSubs && (
                <div className="file-notice-row is-subs" data-notice="subs">
                    <span className="file-notice-icon">💬</span>
                    <div className="file-notice-text">
                        {job?.error ? (
                            <strong>Couldn't read {job.label}: {job.error}</strong>
                        ) : job ? (
                            <strong>
                                {job.asked && !job.progress ? `Asking for ${job.label} subtitles…` : `Reading ${job.label} subtitles from the file… ${pct(job.progress)}`}
                            </strong>
                        ) : (
                            <strong>{textTracks.length ? 'Subtitles in this file' : 'This file has picture subtitles'}</strong>
                        )}
                        {textTracks.length > 0 && (
                            <div className="file-notice-tracks">
                                {textTracks.map((t) => (
                                    <button
                                        key={t.number}
                                        type="button"
                                        className={`file-notice-track ${job?.track === t.number ? 'is-busy' : ''}`}
                                        disabled={Boolean(job && !job.error)}
                                        onClick={() => info.pickSubtitle(t.number)}
                                    >
                                        {subtitleTrackLabel(t)}
                                    </button>
                                ))}
                            </div>
                        )}
                        {pictureTracks.length > 0 && (
                            <span className="file-notice-meta">
                                {pictureTracks.map((t) => subtitleTrackLabel(t)).join(', ')}: picture subtitles can't be shown in a browser. Drop an .srt file instead.
                            </span>
                        )}
                        {textTracks.length > 0 && !job && <span className="file-notice-meta">Shown to everyone in the room.</span>}
                    </div>
                    <button type="button" className="file-notice-close" aria-label="Close" onClick={() => close('subs')}>✕</button>
                </div>
            )}
            {showAudioNote && (
                <div className="file-notice-row is-info" data-notice="audio">
                    <span className="file-notice-icon">🎧</span>
                    <div className="file-notice-text">
                        <span>
                            This file has {format.audio.length} audio tracks; browsers play the first one
                            ({[format.audio[0].name, languageName(format.audio[0].language)].filter(Boolean).join(', ') || format.audio[0].label}).
                        </span>
                    </div>
                    <button type="button" className="file-notice-close" aria-label="Close" onClick={() => close('audio')}>✕</button>
                </div>
            )}
        </div>
    );
}
