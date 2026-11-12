//! Room links the app opens: `3rtc://join/12345` (and the shorter `3rtc://12345`), and the web
//! app's invite links (`https://3rtc.me/?room=12345&from=…`). The app always asks before joining.

use rtc_protocol::RoomId;

/// The room a link points at, or `None` if it isn't a room link.
pub(crate) fn room_in(link: &str) -> Option<RoomId> {
    let link = link.trim().trim_matches('"');
    let lower = link.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("3rtc:") {
        let rest = rest.trim_start_matches('/');
        let rest = rest.strip_prefix("join/").unwrap_or(rest);
        let code: String = rest.chars().take_while(char::is_ascii_digit).collect();
        return RoomId::parse(&code).ok();
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let query = lower.split_once('?')?.1;
        let query = query.split('#').next().unwrap_or(query);
        let code = query.split('&').find_map(|pair| pair.strip_prefix("room="))?;
        return RoomId::parse(code).ok();
    }
    None
}

/// The app's own link for a room (opens the desktop app when it's installed).
pub(crate) fn app_link(room: RoomId) -> String {
    format!("3rtc://join/{room}")
}

/// The first room link among the program's arguments (Windows passes the clicked link).
pub(crate) fn room_in_args(args: impl IntoIterator<Item = String>) -> Option<RoomId> {
    args.into_iter().find_map(|a| room_in(&a))
}

#[cfg(test)]
mod tests {
    use super::{app_link, room_in, room_in_args};

    fn code(link: &str) -> Option<String> {
        room_in(link).map(|r| r.to_string())
    }

    #[test]
    fn reads_the_apps_own_links() {
        assert_eq!(code("3rtc://join/12345").as_deref(), Some("12345"));
        assert_eq!(code("3rtc://join/12345/").as_deref(), Some("12345"));
        assert_eq!(code("3rtc://12345").as_deref(), Some("12345"));
        assert_eq!(code("3RTC:12345").as_deref(), Some("12345"));
        assert_eq!(code("\"3rtc://join/12345\"").as_deref(), Some("12345"));
        assert_eq!(code("3rtc://join/1234"), None);
        assert_eq!(code("3rtc://join/abcde"), None);
    }

    #[test]
    fn reads_the_web_apps_invite_links() {
        assert_eq!(
            code("https://3rtc.me/?room=54321&from=Priya&s=orc").as_deref(),
            Some("54321")
        );
        assert_eq!(
            code("https://3rtc.me/?s=gcp&room=54321#x").as_deref(),
            Some("54321")
        );
        assert_eq!(code("https://3rtc.me/"), None);
        assert_eq!(code("--tray"), None);
    }

    #[test]
    fn makes_links_and_finds_them_in_arguments() {
        let room = room_in("3rtc://join/12345");
        assert_eq!(room.map(app_link).as_deref(), Some("3rtc://join/12345"));
        let args = ["3rtc.exe", "--tray", "3rtc://join/67890"].map(String::from);
        assert_eq!(
            room_in_args(args).map(|r| r.to_string()).as_deref(),
            Some("67890")
        );
    }
}
