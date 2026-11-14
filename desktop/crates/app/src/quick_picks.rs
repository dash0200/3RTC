//! YouTube quick picks (`client-ts/src/utils/quickPicks.ts`): the signaling server's cached list
//! (`GET /api/quick-picks?region=`), else the last one downloaded (saved next to the settings),
//! else the built-in one. Thumbnails are downloaded once and kept on disk, at most
//! [`THUMBS_MAX_BYTES`] (the oldest go first).

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One video.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Video {
    pub(crate) id: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) channel: String,
    #[serde(default)]
    pub(crate) live: bool,
    #[serde(default)]
    pub(crate) seconds: u64,
}

/// One category ("🎵 Lofi Beats" in "Music").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Category {
    pub(crate) id: String,
    pub(crate) group: String,
    pub(crate) name: String,
    pub(crate) videos: Vec<Video>,
}

/// The list, and the trending country.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Picks {
    pub(crate) categories: Vec<Category>,
    /// The country whose trending is shown (`None`: an older server, no choice).
    #[serde(default)]
    pub(crate) region: Option<String>,
    #[serde(default)]
    pub(crate) regions: Vec<String>,
}

/// Worldwide.
pub(crate) const GLOBAL: &str = "GLOBAL";

/// Countries offered in "Trending in…" (`REGION_NAMES`).
pub(crate) const REGIONS: [(&str, &str); 11] = [
    ("IN", "India"),
    ("US", "United States"),
    ("GB", "United Kingdom"),
    ("CA", "Canada"),
    ("AU", "Australia"),
    ("DE", "Germany"),
    ("FR", "France"),
    ("BR", "Brazil"),
    ("JP", "Japan"),
    ("KR", "South Korea"),
    (GLOBAL, "Worldwide"),
];

pub(crate) fn region_name(code: &str) -> &str {
    REGIONS.iter().find(|(c, _)| *c == code).map_or(code, |(_, n)| n)
}

fn v(id: &str, title: &str) -> Video {
    Video {
        id: id.into(),
        title: title.into(),
        channel: String::new(),
        live: false,
        seconds: 0,
    }
}

fn cat(id: &str, group: &str, name: &str, videos: Vec<Video>) -> Category {
    Category {
        id: id.into(),
        group: group.into(),
        name: name.into(),
        videos,
    }
}

/// The built-in list (`BUILTIN_QUICK_PICKS`).
pub(crate) fn builtin() -> Vec<Category> {
    vec![
        cat(
            "lofi",
            "Music",
            "🎵 Lofi Beats",
            vec![
                v(
                    "jfKfPfyJRdk",
                    "lofi hip hop radio – beats to relax/study to (Lofi Girl)",
                ),
                v("lTRiuFIWV54", "1 A.M Study Session (Lofi Girl)"),
                v("_tV5LEBDs7w", "Cozy Winter (Lofi Girl)"),
                v("n61ULEU7CO0", "Best of lofi hip hop 2021 (Lofi Girl)"),
                v(
                    "28KRPhVzCus",
                    "lofi hip hop radio – beats to sleep/chill to (Lofi Girl)",
                ),
            ],
        ),
        cat(
            "chill",
            "Music",
            "🎷 Jazz & Chill",
            vec![
                v("HuFYqnbVbzY", "jazz lofi radio (Lofi Girl)"),
                v("5yx6BWlEVcY", "Chillhop Radio – jazzy & lofi hip hop beats"),
                v("f02mOEt11OQ", "code-fi / lofi beats to code/relax to"),
                v("1ZYbU82GVz4", "Flying – Relaxing Music (Peder B. Helland)"),
            ],
        ),
        cat(
            "synthwave",
            "Music",
            "🌆 Synthwave",
            vec![
                v(
                    "4xDzrJKXOOY",
                    "synthwave radio – beats to chill/game to (Lofi Girl)",
                ),
                v("MV_3Dpw-BRY", "Kavinsky – Nightcall (Drive soundtrack)"),
                v("8GW6sLrK40k", "HOME – Resonance"),
            ],
        ),
        cat(
            "movies",
            "Watch",
            "🎬 Open Movies",
            vec![
                v("aqz-KE-bpKQ", "Big Buck Bunny (4K 60fps)"),
                v("eRsGyueVLvQ", "Sintel (Blender Open Movie)"),
                v("R6MlUcmOul8", "Tears of Steel (Blender Open Movie)"),
                v("WhWc3b3KhnY", "Spring (Blender Open Movie)"),
                v("mN0zPOpADL4", "Agent 327: Operation Barbershop"),
                v("Y-rmzh0PI3c", "Cosmos Laundromat (Blender Open Movie)"),
            ],
        ),
        cat(
            "space",
            "Relax",
            "🌌 Space",
            vec![
                v("21X5lGlDOfg", "NASA Live: Official Stream of NASA TV"),
                v("4czjS9h4Fpg", "Perseverance Rover Landing on Mars (NASA)"),
                v("UDVtMYqUAyw", "Interstellar Main Theme – Hans Zimmer (extended)"),
            ],
        ),
    ]
}

fn is_video_id(s: &str) -> bool {
    s.len() == 11
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The server's answer, checked (`sanitize`): `None` keeps what we have.
pub(crate) fn sanitize(data: &Value) -> Option<Picks> {
    let raw = data.get("categories")?.as_array()?;
    let text = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let categories: Vec<Category> = raw
        .iter()
        .take(40)
        .map(|c| Category {
            id: cut(&text(c, "id"), 40),
            group: {
                let g = cut(&text(c, "group"), 30);
                if g.is_empty() { "Picks".into() } else { g }
            },
            name: cut(&text(c, "name"), 60),
            videos: c
                .get("videos")
                .and_then(Value::as_array)
                .map(|vs| {
                    vs.iter()
                        .filter(|v| is_video_id(&text(v, "id")))
                        .take(25)
                        .map(|v| Video {
                            id: text(v, "id"),
                            title: {
                                let t = cut(&text(v, "title"), 200);
                                if t.is_empty() { "YouTube video".into() } else { t }
                            },
                            channel: cut(&text(v, "channel"), 100),
                            live: v.get("live") == Some(&Value::Bool(true)),
                            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                            seconds: v
                                .get("seconds")
                                .and_then(Value::as_f64)
                                .filter(|s| s.is_finite() && *s > 0.0)
                                .map_or(0, |s| s.round() as u64),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .filter(|c| !c.id.is_empty() && !c.name.is_empty() && !c.videos.is_empty())
        .collect();
    if categories.is_empty() {
        return None;
    }
    let known = |r: &str| REGIONS.iter().any(|(c, _)| *c == r);
    let region = data
        .get("region")
        .and_then(Value::as_str)
        .filter(|r| known(r))
        .map(str::to_owned);
    let regions = if region.is_some() {
        data.get("regions")
            .and_then(Value::as_array)
            .map(|rs| {
                rs.iter()
                    .filter_map(Value::as_str)
                    .filter(|r| known(r))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Some(Picks {
        categories,
        region,
        regions,
    })
}

/// `wss://host:443` → `https://host:443/api/quick-picks?region=…` (`ws://` → `http://`).
pub(crate) fn url(signal_url: &str, region: &str) -> Option<String> {
    let mut u = url::Url::parse(signal_url).ok()?;
    let scheme = if u.scheme() == "wss" { "https" } else { "http" };
    u.set_scheme(scheme).ok()?;
    u.set_path("/api/quick-picks");
    u.set_query(None);
    u.set_fragment(None);
    if !region.is_empty() {
        u.query_pairs_mut().append_pair("region", region);
    }
    Some(u.to_string())
}

fn dir() -> Option<PathBuf> {
    crate::settings::dir()
}

fn saved_path() -> Option<PathBuf> {
    dir().map(|d| d.join("quick-picks.json"))
}

/// The last list downloaded, else the built-in one.
pub(crate) fn load_saved() -> Picks {
    saved_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| sanitize(&v))
        .unwrap_or_else(|| Picks {
            categories: builtin(),
            region: None,
            regions: Vec::new(),
        })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into()
}

/// Downloads the list from the first server that has one (blocking: call off the UI thread).
pub(crate) fn fetch(signal_urls: &[String], region: &str) -> Option<Picks> {
    for s in signal_urls {
        let Some(u) = url(s, region) else { continue };
        let Ok(body) = agent().get(&u).call().and_then(|r| {
            r.into_body()
                .with_config()
                .limit(2 * 1024 * 1024)
                .read_to_string()
        }) else {
            continue;
        };
        let Some(picks) = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| sanitize(&v))
        else {
            continue;
        };
        if let (Some(p), Ok(text)) = (saved_path(), serde_json::to_string(&picks)) {
            let _ = std::fs::write(p, text);
        }
        return Some(picks);
    }
    None
}

/// Thumbnails kept on disk at most this big.
pub(crate) const THUMBS_MAX_BYTES: u64 = 40 * 1024 * 1024;

fn thumbs_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).or_else(dir)?;
    Some(base.join("3RTC").join("thumbs"))
}

/// A video's thumbnail (`mqdefault.jpg`), from the disk cache or downloaded into it (blocking).
pub(crate) fn thumbnail(id: &str) -> Option<Vec<u8>> {
    if !is_video_id(id) {
        return None;
    }
    let dir = thumbs_dir()?;
    let path = dir.join(format!("{id}.jpg"));
    if let Ok(b) = std::fs::read(&path) {
        return Some(b);
    }
    let bytes = agent()
        .get(&format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"))
        .call()
        .ok()?
        .into_body()
        .with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .ok()?;
    if bytes.len() < 100 {
        return None;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &bytes);
    trim(&dir, THUMBS_MAX_BYTES);
    Some(bytes)
}

/// Deletes the oldest files until the folder is under `max` bytes.
fn trim(dir: &std::path::Path, max: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .filter_map(Result::ok)
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file()
                .then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= max {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// A quick pick's title by id (titles for pasted links before YouTube answers).
pub(crate) fn title_of(picks: &Picks, id: &str) -> Option<String> {
    picks
        .categories
        .iter()
        .chain(builtin().iter())
        .flat_map(|c| c.videos.iter())
        .find(|v| v.id == id)
        .map(|v| v.title.clone())
}

/// Groups in first-seen order, each with its categories' indexes.
pub(crate) fn groups(picks: &Picks) -> Vec<(String, Vec<usize>)> {
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, c) in picks.categories.iter().enumerate() {
        match out.iter_mut().find(|(g, _)| *g == c.group) {
            Some((_, list)) => list.push(i),
            None => out.push((c.group.clone(), vec![i])),
        }
    }
    out
}

/// 1:02:31 / 58:40 (`formatLength`).
pub(crate) fn length(total: u64) -> String {
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::{groups, length, sanitize, url};
    use serde_json::json;

    #[test]
    fn server_lists_are_checked() {
        let p = sanitize(&json!({"region":"IN","regions":["IN","US","XX"],"categories":[
            {"id":"t","group":"Trending","name":"🔥 Trending","videos":[{"id":"dQw4w9WgXcQ","title":"A","seconds":61.4},{"id":"bad"}]},
            {"id":"","name":"x","videos":[{"id":"dQw4w9WgXcQ"}]},
            {"id":"e","name":"Empty","videos":[]}]}))
        .unwrap_or_default();
        assert_eq!(p.categories.len(), 1);
        assert_eq!(p.categories[0].videos.len(), 1);
        assert_eq!(p.categories[0].videos[0].seconds, 61);
        assert_eq!((p.region.as_deref(), p.regions.len()), (Some("IN"), 2));
        assert!(sanitize(&json!({"categories": []})).is_none());
        assert_eq!(groups(&p), vec![("Trending".to_owned(), vec![0])]);
        assert_eq!(
            (length(3751), length(59)),
            ("1:02:31".to_owned(), "0:59".to_owned())
        );
    }

    #[test]
    fn the_list_comes_from_the_signaling_server() {
        assert_eq!(
            url("wss://a.b:443", "IN").as_deref(),
            Some("https://a.b/api/quick-picks?region=IN")
        );
        assert_eq!(
            url("ws://localhost:8080/x", "").as_deref(),
            Some("http://localhost:8080/api/quick-picks")
        );
    }
}
