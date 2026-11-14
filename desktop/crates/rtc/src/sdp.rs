//! SDP and sender tuning for the voice track: `client-ts/src/webrtc/sdp.ts`.

/// Opus settings both apps put in every offer and answer: forward error correction against lost
/// packets, and up to 128 kbps (browsers default to about 32).
pub const OPUS_PARAMS: &str = "useinbandfec=1;maxaveragebitrate=128000";

/// Voice bitrate for a room of `people` (`voiceBitrateFor`): 128 kbps, 64 kbps past 4 people.
#[must_use]
pub const fn voice_bitrate(people: usize) -> u64 {
    if people > 4 { 64_000 } else { 128_000 }
}

/// `tuneSdpForDiscordAudio`: sets [`OPUS_PARAMS`] on the Opus payload type, keeping its other
/// parameters; SDP without Opus comes back unchanged.
#[must_use]
pub fn tune_opus(sdp: &str) -> String {
    let Some(pt) = opus_payload_type(sdp) else {
        return sdp.to_owned();
    };
    let fmtp_prefix = format!("a=fmtp:{pt} ");
    let eol = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let mut found = false;
    let mut out: Vec<String> = sdp
        .split(eol)
        .map(|line| {
            let Some(params) = line.strip_prefix(&fmtp_prefix).filter(|_| !found) else {
                return line.to_owned();
            };
            found = true;
            let kept: Vec<&str> = params
                .split(';')
                .map(str::trim)
                .filter(|p| {
                    let lower = p.to_ascii_lowercase();
                    !p.is_empty()
                        && !lower.starts_with("maxaveragebitrate=")
                        && !lower.starts_with("useinbandfec=")
                })
                .collect();
            if kept.is_empty() {
                format!("{fmtp_prefix}{OPUS_PARAMS}")
            } else {
                format!("{fmtp_prefix}{};{OPUS_PARAMS}", kept.join(";"))
            }
        })
        .collect();
    if !found {
        // no fmtp line yet: add one right after the rtpmap
        let rtpmap = format!("a=rtpmap:{pt} ");
        if let Some(i) = out
            .iter()
            .position(|l| l.to_ascii_lowercase().starts_with(&rtpmap))
        {
            out.insert(i + 1, format!("{fmtp_prefix}{OPUS_PARAMS}"));
        }
    }
    out.join(eol)
}

/// Opus for the sound of a shared screen: stereo, up to 256 kbps, music (no voice tricks).
pub const MUSIC_PARAMS: &str = "stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1";

/// Every audio line after the first (the voice) carries a shared screen's sound (between
/// desktops): asks for [`MUSIC_PARAMS`] on its Opus, keeping its other parameters. Both sides
/// write this into their own descriptions, so each sends the other stereo.
#[must_use]
pub fn tune_music(sdp: &str) -> String {
    let Some(pt) = opus_payload_type(sdp) else {
        return sdp.to_owned();
    };
    let fmtp_prefix = format!("a=fmtp:{pt} ");
    let rtpmap = format!("a=rtpmap:{pt} ");
    let eol = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out: Vec<String> = Vec::new();
    let mut audio_lines = 0usize;
    let mut in_music = false;
    let mut fmtp_seen = false;
    let mut rtpmap_at: Option<usize> = None;
    let close = |out: &mut Vec<String>, in_music: bool, fmtp_seen: bool, rtpmap_at: Option<usize>| {
        if in_music
            && !fmtp_seen
            && let Some(i) = rtpmap_at
        {
            out.insert(i + 1, format!("{fmtp_prefix}{MUSIC_PARAMS}"));
        }
    };
    for line in sdp.split(eol) {
        if line.starts_with("m=") {
            close(&mut out, in_music, fmtp_seen, rtpmap_at);
            let audio = line.starts_with("m=audio");
            if audio {
                audio_lines += 1;
            }
            in_music = audio && audio_lines > 1;
            fmtp_seen = false;
            rtpmap_at = None;
            out.push(line.to_owned());
            continue;
        }
        if in_music && line.to_ascii_lowercase().starts_with(&rtpmap) {
            rtpmap_at = Some(out.len());
        }
        if in_music && let Some(params) = line.strip_prefix(&fmtp_prefix) {
            fmtp_seen = true;
            let kept: Vec<&str> = params
                .split(';')
                .map(str::trim)
                .filter(|p| {
                    let lower = p.to_ascii_lowercase();
                    !p.is_empty()
                        && !["maxaveragebitrate=", "useinbandfec=", "stereo=", "sprop-stereo="]
                            .iter()
                            .any(|k| lower.starts_with(k))
                })
                .collect();
            out.push(if kept.is_empty() {
                format!("{fmtp_prefix}{MUSIC_PARAMS}")
            } else {
                format!("{fmtp_prefix}{};{MUSIC_PARAMS}", kept.join(";"))
            });
            continue;
        }
        out.push(line.to_owned());
    }
    close(&mut out, in_music, fmtp_seen, rtpmap_at);
    out.join(eol)
}

fn opus_payload_type(sdp: &str) -> Option<&str> {
    sdp.lines().find_map(|line| {
        let rest = line.strip_prefix("a=rtpmap:")?;
        let (pt, codec) = rest.split_once(' ')?;
        codec.to_ascii_lowercase().starts_with("opus/48000").then_some(pt)
    })
}

#[cfg(test)]
mod music_tests {
    use super::tune_music;

    #[test]
    fn only_audio_lines_after_the_voice_become_stereo() {
        let sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n\
                   a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=128000\r\n\
                   m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n\
                   m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n\
                   a=fmtp:111 minptime=10;useinbandfec=1\r\n\
                   m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
        let t = tune_music(sdp);
        let fmtps: Vec<&str> = t.split("\r\n").filter(|l| l.starts_with("a=fmtp:111")).collect();
        assert_eq!(fmtps.len(), 3, "{t}");
        assert_eq!(
            fmtps[0], "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=128000",
            "the voice stays"
        );
        assert_eq!(
            fmtps[1],
            "a=fmtp:111 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=256000;useinbandfec=1"
        );
        assert!(fmtps[2].contains("stereo=1"), "added where there was none");
        assert_eq!(
            tune_music("v=0\r\nm=audio 9 X 0\r\n"),
            "v=0\r\nm=audio 9 X 0\r\n",
            "no Opus: unchanged"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFER: &str = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\n\
                         a=fmtp:111 minptime=10;useinbandfec=0\r\na=rtpmap:63 red/48000/2\r\n";

    #[test]
    fn replaces_the_opus_params_and_keeps_the_rest() {
        let tuned = tune_opus(OFFER);
        assert!(
            tuned.contains("a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=128000\r\n"),
            "{tuned}"
        );
        assert!(tuned.contains("a=rtpmap:63 red/48000/2"));
        assert_eq!(tune_opus(&tuned), tuned, "tuning twice changes nothing");
    }

    #[test]
    fn adds_the_line_when_missing_and_leaves_other_sdp_alone() {
        let sdp = "v=0\r\na=rtpmap:109 OPUS/48000/2\r\na=sendrecv\r\n";
        assert!(
            tune_opus(sdp).contains(
                "a=rtpmap:109 OPUS/48000/2\r\na=fmtp:109 useinbandfec=1;maxaveragebitrate=128000\r\n"
            )
        );
        let video = "v=0\r\na=rtpmap:96 VP8/90000\r\n";
        assert_eq!(tune_opus(video), video);
    }

    #[test]
    fn bitrate_tiers() {
        assert_eq!(voice_bitrate(4), 128_000);
        assert_eq!(voice_bitrate(5), 64_000);
    }
}
