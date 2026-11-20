//! Which room log lines are about connections (kept in the log file) and which are what people did
//! with the player, the queue, the soundboard and so on (`rtc_engine::activity`: the Logs tab
//! shows them, the file leaves them out).

/// Room log lines that only say what someone did (played, paused, queued, a soundboard clip...).
#[must_use]
pub(crate) fn is_activity(text: &str) -> bool {
    const ACTIVITY: [&str; 13] = [
        "▶️", "⏸️", "⏩", "⏭️", "🎬", "📁", "📑", "🗑️", "💬", "🔊", "🔇", "🖱️", "🔒",
    ];
    let text = text.trim_start();
    ACTIVITY.iter().any(|p| text.starts_with(p)) || text.starts_with("🔄 Synced")
}

#[cfg(test)]
mod tests {
    use super::is_activity;

    #[test]
    fn connection_lines_stay_and_player_lines_go() {
        assert!(!is_activity(
            "🔄 Reconnected to signaling. Resuming room 123456..."
        ));
        assert!(!is_activity("🔄 Connected to backup signaling server (EU)."));
        assert!(!is_activity(
            "A peer entered room 123456. Establishing P2P connection..."
        ));
        assert!(!is_activity("A peer disconnected from the room."));
        assert!(!is_activity(
            "⚠️ Couldn't connect to someone in the room: your network or theirs blocks"
        ));
        assert!(!is_activity("🔎 Why: UDP is blocked."));
        assert!(!is_activity(
            "🌐 Network topology switched to Full Mesh mode (P2P)."
        ));
        assert!(!is_activity("👑 The host left. Riya is now the host"));
        assert!(is_activity("▶️ Riya played the video"));
        assert!(is_activity("🔊 Riya played soundboard clip: \"Quack\""));
        assert!(is_activity("🔄 Synced YouTube playback & queue with room"));
        assert!(is_activity("📑 Riya queued: Song"));
    }
}
