/** SDP and RTP sender tuning for the voice track (Opus bitrate, FEC, priority). */

export function extractAudioSdp(sdp) {
    if (!sdp) return 'none';
    const lines = sdp.split('\n');
    const audioIndex = lines.findIndex((l) => l.startsWith('m=audio'));
    if (audioIndex === -1) return 'no m=audio';
    const audioBlock = [];
    for (let i = audioIndex; i < Math.min(lines.length, audioIndex + 15); i++) {
        const line = lines[i].trim();
        if (i > audioIndex && line.startsWith('m=')) break;
        if (line.startsWith('m=audio') || line.startsWith('a=sendrecv') || line.startsWith('a=recvonly') || line.startsWith('a=sendonly') || line.startsWith('a=inactive') || line.startsWith('a=mid')) {
            audioBlock.push(line);
        }
    }
    return audioBlock.join(' | ');
}

/**
 * Raises the Opus bitrate (browser default is ~32 kbps) so voice is crisp.
 * - maxaveragebitrate=128000
 * - useinbandfec=1 (Forward Error Correction against packet drops)
 * Everything else stays at the browser's defaults.
 */
export function tuneSdpForDiscordAudio(sdp) {
    if (!sdp) return sdp;
    const match = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!match) return sdp;
    const pt = match[1];
    const opusParams = 'useinbandfec=1;maxaveragebitrate=128000';

    const fmtpRegex = new RegExp(`a=fmtp:${pt}\\s+(.*)`, 'i');
    if (fmtpRegex.test(sdp)) {
        return sdp.replace(fmtpRegex, (line, existingParams) => {
            const filtered = existingParams
                .split(';')
                .map((s) => s.trim())
                .filter((p) => !p.match(/^(maxaveragebitrate|useinbandfec)=/i))
                .join(';');
            return `a=fmtp:${pt} ${filtered ? filtered + ';' : ''}${opusParams}`;
        });
    } else {
        return sdp.replace(
            new RegExp(`(a=rtpmap:${pt}\\s+opus\\/48000(?:\\/2)?)`, 'i'),
            `$1\r\na=fmtp:${pt} ${opusParams}`
        );
    }
}

/**
 * Sender settings for the voice track: 128 kbps ceiling and HIGH priority, so voice keeps its
 * bandwidth (and gets DSCP "expedited" marking) when it competes with P2P video/file transfer.
 * Finds the audio sender through its transceiver, so it works even before the mic is attached;
 * the settings persist across replaceTrack.
 */
// Each person sends one copy of their voice per connection, so in bigger rooms each copy gets a
// lower bitrate: 128 kbps up to 4 people, 64 kbps above (still very clear Opus voice).
let voiceBitrate = 128000;
export const voiceBitrateFor = (people) => (people > 4 ? 64000 : 128000);
export const getVoiceBitrate = () => voiceBitrate;

/** Room size changed: re-apply the voice bitrate to every connection if the tier changed. */
export function setVoiceRoomSize(people, peerEntries) {
    const next = voiceBitrateFor(people);
    if (next === voiceBitrate) return false;
    voiceBitrate = next;
    for (const entry of peerEntries) tuneAudioSender(entry?.pc);
    return true;
}

export function tuneAudioSender(pc) {
    if (!pc) return;
    try {
        const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
        const audioTransceiver = transceivers.find((t) =>
            t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'
        );
        const audioSender = audioTransceiver?.sender ||
            (pc.getSenders ? pc.getSenders().find((s) => s.track && s.track.kind === 'audio') : null);
        if (audioSender && audioSender.getParameters && audioSender.setParameters) {
            const params = audioSender.getParameters();
            if (params && params.encodings && params.encodings.length > 0) {
                params.encodings[0].maxBitrate = voiceBitrate;
                params.encodings[0].priority = 'high';
                params.encodings[0].networkPriority = 'high';
                audioSender.setParameters(params).catch(() => { });
            }
        }
    } catch { }
}
