//! What the room watches: YouTube videos and link sources (Vimeo, Twitch, a direct video file, an
//! HLS stream), the shared queue's items, and "paste anything" (`client-ts/src/features/media/
//! sources.ts`, `utils/youtubeId.ts`). Media from other people is always rebuilt from its link
//! ([`normalize`]), never trusted field by field.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where a link source plays from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// Vimeo.
    Vimeo,
    /// Twitch (a video or a live channel).
    Twitch,
    /// A direct video or audio file.
    File,
    /// An HLS stream (`.m3u8`).
    Hls,
}

impl Provider {
    /// Its name for people (`PROVIDERS` in `sources.ts`).
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Vimeo => "Vimeo",
            Self::Twitch => "Twitch",
            Self::File => "Video link",
            Self::Hls => "Live/HLS stream",
        }
    }
}

/// A link source, as it travels in messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Media {
    /// Where it plays from.
    pub provider: Provider,
    /// The clean link.
    pub url: String,
    /// Vimeo: the video's number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Twitch: a video (`v123`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    /// Twitch: a channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// Twitch: the channel is live (no seeking, no heartbeat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    /// Its title, once known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Media {
    fn new(provider: Provider, url: String) -> Self {
        Self {
            provider,
            url,
            id: None,
            video: None,
            channel: None,
            live: None,
            title: None,
        }
    }

    /// "Same video?" (`mediaKey`).
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}:{}", provider_name(self.provider), self.url)
    }

    /// Its title, or a name to show instead (`fallbackTitle`).
    #[must_use]
    pub fn display_title(&self) -> String {
        match &self.title {
            Some(t) if !t.is_empty() => t.clone(),
            _ => self.fallback_title(),
        }
    }

    /// A name to show before (or instead of) a real title.
    #[must_use]
    pub fn fallback_title(&self) -> String {
        match self.provider {
            Provider::Twitch => self
                .channel
                .as_ref()
                .map_or_else(|| "Twitch video".to_owned(), |c| format!("{c} on Twitch")),
            Provider::Vimeo => "Vimeo video".to_owned(),
            Provider::File | Provider::Hls => match url::Url::parse(&self.url) {
                Ok(u) => {
                    let last = u
                        .path_segments()
                        .and_then(|mut s| s.rfind(|p| !p.is_empty()))
                        .map(decode)
                        .unwrap_or_default();
                    if !last.is_empty() && last.encode_utf16().count() < 120 {
                        last
                    } else {
                        u.host_str().unwrap_or("Video").to_owned()
                    }
                }
                Err(_) => "Video".to_owned(),
            },
        }
    }

    /// Live: no position to share.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.live == Some(true)
    }
}

const fn provider_name(p: Provider) -> &'static str {
    match p {
        Provider::Vimeo => "vimeo",
        Provider::Twitch => "twitch",
        Provider::File => "file",
        Provider::Hls => "hls",
    }
}

/// What pasted text is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// A YouTube video id.
    YouTube(String),
    /// A link source. `guessed`: no known site and no video extension (it may not be a video).
    Media {
        /// The source.
        media: Media,
        /// Only a guess.
        guessed: bool,
    },
}

/// The 11-character YouTube id in a link (watch, youtu.be, shorts, live, embed) or a bare id
/// (`extractYouTubeId`).
#[must_use]
pub fn youtube_id(text: &str) -> Option<String> {
    let t = text.trim();
    let is_id_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    if t.chars().count() == 11 && t.chars().all(is_id_char) {
        return Some(t.to_owned());
    }
    // the web app's regex, piece by piece (case-insensitive)
    let lower = t.to_ascii_lowercase();
    let take = |at: usize| -> Option<String> {
        let rest = t.get(at..)?;
        let id: String = rest.chars().take(11).collect();
        (id.chars().count() == 11
            && !id
                .chars()
                .any(|c| matches!(c, '"' | '&' | '?' | '/') || c.is_whitespace()))
        .then_some(id)
    };
    for prefix in ["youtu.be/", "youtube.com/live/", "youtube.com/shorts/"] {
        if let Some(i) = lower.find(prefix)
            && let Some(id) = take(i + prefix.len())
        {
            return Some(id);
        }
    }
    let i = lower.find("youtube.com/")?;
    let after = i + "youtube.com/".len();
    let rest = &lower[after..];
    // (?:v|e(?:mbed)?)/
    for p in ["v/", "e/", "embed/"] {
        if rest.starts_with(p)
            && let Some(id) = take(after + p.len())
        {
            return Some(id);
        }
    }
    // .*[?&]v=  (greedy: the last one)
    if let Some(j) = rest.rfind("?v=").into_iter().chain(rest.rfind("&v=")).max()
        && let Some(id) = take(after + j + 3)
    {
        return Some(id);
    }
    // [^/]+/.+/  then the id (e.g. /user/name/xxxxxxxxxxx): the last slash with 11 id chars after it
    let segs: Vec<&str> = rest.split('/').collect();
    if segs.len() >= 3 {
        let mut at = after;
        for (n, s) in segs.iter().enumerate() {
            if n >= 2
                && let Some(id) = take(at)
            {
                return Some(id);
            }
            at += s.len() + 1;
        }
    }
    None
}

/// Cloud metadata endpoints and link-local addresses never probed through shared links.
fn blocked_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h == "metadata.google.internal" || h == "instance-data" {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    parts.len() == 4
        && parts[0] == "169"
        && parts[1] == "254"
        && parts[2..]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn parse_url(text: &str) -> Option<url::Url> {
    let mut t = text.trim().to_owned();
    if t.is_empty() {
        return None;
    }
    let has_scheme = {
        let mut cs = t.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic())
            && t.find(':').is_some_and(|i| {
                t[1..i]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
            })
    };
    if !has_scheme && looks_like_host(&t) {
        t = format!("https://{t}");
    }
    let u = url::Url::parse(&t).ok()?;
    if blocked_host(u.host_str().unwrap_or("")) {
        return None;
    }
    matches!(u.scheme(), "http" | "https").then_some(u)
}

/// `^[\w-]+(\.[\w-]+)+(\/|$)`
fn looks_like_host(t: &str) -> bool {
    let end = t.find('/').unwrap_or(t.len());
    let host = &t[..end];
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-'))
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// `decodeURIComponent`, forgiving.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn vimeo(u: &url::Url, host: &str) -> Option<Result<Link, String>> {
    if !host_is(host, "vimeo.com") {
        return None;
    }
    let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
    let is_num = |p: &str| (5..=12).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    let Some(at) = parts.iter().position(|p| is_num(p)) else {
        return Some(Err("That Vimeo link doesn't point to a single video.".to_owned()));
    };
    let id = parts[at].to_owned();
    let query_h = u
        .query_pairs()
        .find(|(k, _)| k == "h")
        .map(|(_, v)| v.into_owned());
    let hash = query_h.filter(|h| !h.is_empty()).or_else(|| {
        parts
            .get(at + 1)
            .filter(|p| p.len() >= 6 && p.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|p| (*p).to_owned())
    });
    let url = match &hash {
        Some(h) => format!("https://vimeo.com/{id}/{h}"),
        None => format!("https://vimeo.com/{id}"),
    };
    let mut media = Media::new(Provider::Vimeo, url);
    media.id = Some(id);
    Some(Ok(Link::Media {
        media,
        guessed: false,
    }))
}

fn twitch(u: &url::Url, raw_host: &str) -> Option<Result<Link, String>> {
    let host = ["www.", "m.", "player."]
        .iter()
        .find_map(|p| raw_host.strip_prefix(p))
        .unwrap_or(raw_host);
    if host == "clips.twitch.tv" || (host == "twitch.tv" && u.path().contains("/clip/")) {
        return Some(Err(
            "Twitch clips can't be played in sync (Twitch doesn't allow it). Paste a Twitch video or channel instead."
                .to_owned(),
        ));
    }
    if host != "twitch.tv" {
        return None;
    }
    let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
    let video = |n: &str| {
        let mut m = Media::new(Provider::Twitch, format!("https://www.twitch.tv/videos/{n}"));
        m.video = Some(format!("v{n}"));
        Some(Ok(Link::Media {
            media: m,
            guessed: false,
        }))
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if parts.first() == Some(&"videos") && parts.get(1).is_some_and(|p| digits(p)) {
        return video(parts[1]);
    }
    let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    if let Some(v) = q("video")
        && !v.is_empty()
    {
        let n = v.strip_prefix('v').unwrap_or(&v);
        if digits(n) {
            return video(n);
        }
    }
    let channel = q("channel")
        .filter(|c| !c.is_empty())
        .or_else(|| parts.first().map(|p| (*p).to_owned()))
        .unwrap_or_default()
        .to_lowercase();
    let ok = (3..=25).contains(&channel.len())
        && channel
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && ![
            "directory",
            "search",
            "settings",
            "downloads",
            "p",
            "subscriptions",
        ]
        .contains(&channel.as_str());
    if !ok {
        return Some(Err("Paste a Twitch video or channel link.".to_owned()));
    }
    let mut m = Media::new(Provider::Twitch, format!("https://www.twitch.tv/{channel}"));
    m.channel = Some(channel);
    m.live = Some(true);
    Some(Ok(Link::Media {
        media: m,
        guessed: false,
    }))
}

fn blocked_site(raw_host: &str) -> Option<String> {
    let host = raw_host.strip_prefix("www.").unwrap_or(raw_host);
    const PROTECTED: [(&str, &str); 12] = [
        ("netflix.com", "Netflix"),
        ("primevideo.com", "Prime Video"),
        ("hotstar.com", "Disney+ Hotstar"),
        ("jiocinema.com", "JioCinema"),
        ("jiohotstar.com", "JioHotstar"),
        ("disneyplus.com", "Disney+"),
        ("sonyliv.com", "SonyLIV"),
        ("zee5.com", "ZEE5"),
        ("hulu.com", "Hulu"),
        ("max.com", "Max"),
        ("tv.apple.com", "Apple TV+"),
        ("mxplayer.in", "MX Player"),
    ];
    for (d, name) in PROTECTED {
        if host_is(host, d) {
            return Some(format!(
                "{name} videos are protected (DRM) and can't be played inside another site."
            ));
        }
    }
    // (^|\.)amazon\.[a-z.]+$
    let labels: Vec<&str> = host.split('.').collect();
    if let Some(i) = labels.iter().position(|l| *l == "amazon")
        && i + 1 < labels.len()
        && labels[i + 1..]
            .iter()
            .all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Some(
            "Prime Video videos are protected (DRM) and can't be played inside another site.".to_owned(),
        );
    }
    const NO_EMBED: [(&str, &str); 9] = [
        ("instagram.com", "Instagram"),
        ("facebook.com", "Facebook"),
        ("fb.watch", "Facebook"),
        ("tiktok.com", "TikTok"),
        ("x.com", "X"),
        ("twitter.com", "X"),
        ("reddit.com", "Reddit"),
        ("snapchat.com", "Snapchat"),
        ("linkedin.com", "LinkedIn"),
    ];
    for (d, name) in NO_EMBED {
        if host_is(host, d) {
            return Some(format!(
                "{name} doesn't let other sites play its videos. Paste a direct video link (.mp4) or a YouTube, Vimeo or Twitch link."
            ));
        }
    }
    if host_is(host, "dailymotion.com") || host_is(host, "dai.ly") {
        return Some("Dailymotion isn't supported yet.".to_owned());
    }
    None
}

fn has_ext(path: &str, exts: &[&str]) -> bool {
    let lower = path.to_ascii_lowercase();
    exts.iter().any(|e| lower.ends_with(&format!(".{e}")))
}

/// What `text` is and whether it can be played together (`detectLink`); `Err` says why not.
///
/// # Errors
/// The web app's message for text that can't be played here.
pub fn detect_link(text: &str) -> Result<Link, String> {
    let raw = text.trim();
    if raw.is_empty() {
        return Err("Paste a video link.".to_owned());
    }
    if let Some(id) = youtube_id(raw) {
        return Ok(Link::YouTube(id));
    }
    let Some(u) = parse_url(raw) else {
        return Err("That doesn't look like a link. Paste a YouTube, Vimeo or Twitch link, or a direct video link (.mp4, .m3u8).".to_owned());
    };
    let host = u.host_str().unwrap_or("").to_owned();
    if host_is(&host, "youtube.com") || host_is(&host, "youtu.be") || host_is(&host, "youtube-nocookie.com") {
        return Err("That YouTube link doesn't point to a video.".to_owned());
    }
    if let Some(r) = vimeo(&u, &host).or_else(|| twitch(&u, &host)) {
        return r;
    }
    if let Some(why) = blocked_site(&host) {
        return Err(why);
    }
    let path = decode(u.path());
    let url = u.as_str().to_owned();
    if has_ext(&path, &["m3u8"]) {
        return Ok(Link::Media {
            media: Media::new(Provider::Hls, url),
            guessed: false,
        });
    }
    if has_ext(&path, &["mpd"]) {
        return Err(
            "DASH streams (.mpd) aren't supported yet. HLS (.m3u8) and direct video files work.".to_owned(),
        );
    }
    let known = has_ext(
        &path,
        &[
            "mp4", "m4v", "webm", "ogv", "ogg", "mov", "mkv", "mp3", "m4a", "aac", "wav", "flac", "opus",
            "oga",
        ],
    );
    Ok(Link::Media {
        media: Media::new(Provider::File, url),
        guessed: !known,
    })
}

/// Media received from someone else: rebuilt from its link, keeping the title (`normalizeMedia`).
#[must_use]
pub fn normalize(value: &Value) -> Option<Media> {
    let url = value.get("url")?.as_str()?;
    if url.encode_utf16().count() > 2048 {
        return None;
    }
    let Ok(Link::Media { mut media, .. }) = detect_link(url) else {
        return None;
    };
    let title: String = value
        .get("title")
        .and_then(Value::as_str)
        .map(|t| t.chars().take(200).collect())
        .unwrap_or_default();
    if !title.is_empty() {
        media.title = Some(title);
    }
    Some(media)
}

/// One entry in the shared watch queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// Unique id.
    pub id: String,
    /// A YouTube video…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id: Option<String>,
    /// …or a link source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<Media>,
    /// Its title.
    #[serde(default)]
    pub title: String,
    /// Who queued it.
    #[serde(default)]
    pub added_by: String,
    /// When, ms since 1970.
    #[serde(default)]
    pub timestamp: f64,
}

impl QueueItem {
    /// An item from someone else, checked (`cleanItem`): a YouTube video or a link source.
    #[must_use]
    pub fn from_value(v: &Value) -> Option<Self> {
        let id = v.get("id")?.as_str()?.to_owned();
        let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let media = match v.get("media") {
            Some(m) if !m.is_null() && m != &Value::Bool(false) => Some(normalize(m)?),
            _ => None,
        };
        let video_id = if media.is_some() {
            None
        } else {
            Some(v.get("videoId")?.as_str()?.to_owned())
        };
        Some(Self {
            id,
            video_id,
            media,
            title: text("title"),
            added_by: text("addedBy"),
            timestamp: v.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0),
        })
    }

    /// A list from someone else: the good items.
    #[must_use]
    pub fn list(values: &[Value]) -> Vec<Self> {
        values.iter().filter_map(Self::from_value).collect()
    }

    /// As sent.
    #[must_use]
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::{Link, Provider, QueueItem, detect_link, normalize, youtube_id};
    use serde_json::json;

    fn media(text: &str) -> super::Media {
        match detect_link(text) {
            Ok(Link::Media { media, .. }) => media,
            other => unreachable!("{text}: {other:?}"),
        }
    }

    #[test]
    fn youtube_links() {
        for t in [
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?feature=x&v=dQw4w9WgXcQ&t=10",
            "https://youtu.be/dQw4w9WgXcQ?si=abc",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "youtube.com/v/dQw4w9WgXcQ",
        ] {
            assert_eq!(youtube_id(t).as_deref(), Some("dQw4w9WgXcQ"), "{t}");
        }
        assert_eq!(youtube_id("https://example.com/x"), None);
        assert_eq!(
            detect_link("https://www.youtube.com/channel/abc"),
            Err("That YouTube link doesn't point to a video.".to_owned())
        );
    }

    #[test]
    fn link_sources() {
        let v = media("https://vimeo.com/76979871");
        assert_eq!(
            (v.provider, v.url.as_str(), v.id.as_deref()),
            (Provider::Vimeo, "https://vimeo.com/76979871", Some("76979871"))
        );
        assert_eq!(
            media("https://player.vimeo.com/video/76979871?h=abcdef12").url,
            "https://vimeo.com/76979871/abcdef12"
        );
        let t = media("https://www.twitch.tv/videos/123456");
        assert_eq!(
            (t.url.as_str(), t.video.as_deref()),
            ("https://www.twitch.tv/videos/123456", Some("v123456"))
        );
        let c = media("twitch.tv/SomeOne_");
        assert_eq!(
            (c.channel.as_deref(), c.live, c.fallback_title().as_str()),
            (Some("someone_"), Some(true), "someone_ on Twitch")
        );
        assert!(detect_link("https://clips.twitch.tv/abc").is_err());
        let f = media("https://example.com/films/My%20Film.mp4");
        assert_eq!(
            (f.provider, f.fallback_title().as_str()),
            (Provider::File, "My Film.mp4")
        );
        assert_eq!(media("http://x.org/live/a.m3u8").provider, Provider::Hls);
        assert!(matches!(
            detect_link("https://example.com/page"),
            Ok(Link::Media { guessed: true, .. })
        ));
        assert!(
            detect_link("https://www.netflix.com/watch/1")
                .unwrap_err()
                .contains("Netflix")
        );
        assert!(
            detect_link("https://www.amazon.co.uk/x")
                .unwrap_err()
                .contains("Prime Video")
        );
        assert!(
            detect_link("https://www.instagram.com/p/x")
                .unwrap_err()
                .contains("Instagram")
        );
        assert!(detect_link("http://169.254.169.254/latest").is_err());
        assert!(detect_link("ftp://x.org/a.mp4").is_err());
        assert!(detect_link("not a link").is_err());
    }

    #[test]
    fn media_from_others_is_rebuilt() {
        let m = normalize(
            &json!({"provider":"file","url":"https://vimeo.com/76979871","title":"Hi","id":"evil"}),
        );
        assert_eq!(
            m.map(|m| (m.provider, m.id, m.title)),
            Some((Provider::Vimeo, Some("76979871".into()), Some("Hi".into())))
        );
        assert_eq!(
            normalize(&json!({"url": "dQw4w9WgXcQ"})),
            None,
            "a YouTube id isn't a link source"
        );
        let q = QueueItem::list(&[
            json!({"id":"a","videoId":"dQw4w9WgXcQ","title":"T","addedBy":"Riya","timestamp":1}),
            json!({"id":"b","media":{"provider":"vimeo","url":"https://vimeo.com/76979871"},"title":"V"}),
            json!({"id":"c"}),
            json!({"videoId":"x"}),
        ]);
        assert_eq!(q.len(), 2);
        assert_eq!(
            q[0].to_value(),
            json!({"id":"a","videoId":"dQw4w9WgXcQ","title":"T","addedBy":"Riya","timestamp":1.0})
        );
    }
}
