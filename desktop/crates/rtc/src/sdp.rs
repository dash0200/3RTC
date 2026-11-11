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

fn opus_payload_type(sdp: &str) -> Option<&str> {
    sdp.lines().find_map(|line| {
        let rest = line.strip_prefix("a=rtpmap:")?;
        let (pt, codec) = rest.split_once(' ')?;
        codec.to_ascii_lowercase().starts_with("opus/48000").then_some(pt)
    })
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
