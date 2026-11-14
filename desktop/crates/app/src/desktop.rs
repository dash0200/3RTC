//! The desktop-only extras around a call (BUILD_SPEC §9, M2): push-to-talk and the global mute
//! and deafen keys, the tray icon and its menu, notifications, and the chirps. The Windows
//! work is in `rtc_platform_win`; this turns it into events for the window (`view.rs`).

use std::sync::LazyLock;

use rtc_engine::{Phase, Snapshot};
use rtc_platform_win::{KeyEvent, KeyWatcher, MenuItem, Tray, TrayEvent};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::settings::{Settings, VoiceMode};

/// Watched key ids.
pub(crate) const KEY_PTT: u32 = 1;
pub(crate) const KEY_MUTE: u32 = 2;
pub(crate) const KEY_DEAFEN: u32 = 3;
/// Tray menu ids.
pub(crate) const MENU_OPEN: u32 = 1;
pub(crate) const MENU_MUTE: u32 = 2;
pub(crate) const MENU_DEAFEN: u32 = 3;
pub(crate) const MENU_LEAVE: u32 = 4;
pub(crate) const MENU_QUIT: u32 = 5;

/// Something from outside the window.
#[derive(Debug, Clone)]
pub(crate) enum DesktopEvent {
    /// A watched key combination went down or up.
    Key(KeyEvent),
    /// The tray icon was used.
    Tray(TrayEvent),
    /// Another launch handed over a message (`single.rs`).
    Launch(String),
    /// An action from the screen sharing HUD.
    ShareHud(rtc_platform_win::ShareHudAction),
}

/// The keys being watched, the tray icon, and where their events go.
pub(crate) struct Desktop {
    keys: KeyWatcher,
    tray: Option<Tray>,
    tx: UnboundedSender<DesktopEvent>,
    /// The menu and tooltip last given to the tray (to skip repeats).
    shown: Option<(Vec<MenuItem>, String)>,
}

impl Desktop {
    /// Starts watching keys (none yet) and puts the icon in the tray.
    pub(crate) fn start() -> (Self, UnboundedReceiver<DesktopEvent>) {
        let (tx, rx) = unbounded_channel();
        let keys = {
            let tx = tx.clone();
            KeyWatcher::start(move |e| {
                let _ = tx.send(DesktopEvent::Key(e));
            })
        };
        let tray = {
            let tx = tx.clone();
            Tray::start("3RTC", menu(None), move |e| {
                let _ = tx.send(DesktopEvent::Tray(e));
            })
        };
        if rtc_platform_win::SUPPORTED && tray.is_none() {
            tracing::warn!("no tray icon: closing the window will quit");
        }
        (
            Self {
                keys,
                tray,
                tx,
                shown: None,
            },
            rx,
        )
    }

    /// A sender for messages from other launches.
    pub(crate) fn sender(&self) -> UnboundedSender<DesktopEvent> {
        self.tx.clone()
    }

    /// Whether there's a tray icon to keep running in.
    pub(crate) const fn has_tray(&self) -> bool {
        self.tray.is_some()
    }

    /// Watch the keys that matter now: push-to-talk in push-to-talk mode, and the mute and
    /// deafen hotkeys, all only while in a room (the key works for nothing outside one).
    pub(crate) fn watch(&self, settings: &Settings, in_room: bool) {
        let mut watched = Vec::new();
        if in_room {
            if settings.voice_mode == VoiceMode::Ptt && !settings.ptt_keys.is_empty() {
                watched.push((KEY_PTT, settings.ptt_keys.clone()));
            }
            if !settings.mute_keys.is_empty() {
                watched.push((KEY_MUTE, settings.mute_keys.clone()));
            }
            if !settings.deafen_keys.is_empty() {
                watched.push((KEY_DEAFEN, settings.deafen_keys.clone()));
            }
        }
        self.keys.watch(watched);
    }

    /// The tray menu and tooltip for where we are.
    pub(crate) fn show_room(&mut self, room: Option<&Snapshot>) {
        let Some(tray) = &self.tray else { return };
        let in_room = room.filter(|r| matches!(r.phase, Phase::InRoom(_)));
        let tip = tooltip(in_room);
        let items = menu(in_room);
        if self.shown.as_ref().is_some_and(|(m, t)| *m == items && *t == tip) {
            return;
        }
        tray.set_menu(items.clone());
        tray.set_tooltip(&tip);
        self.shown = Some((items, tip));
    }

    /// A Windows notification from the tray icon (held back during Focus Assist).
    pub(crate) fn notify(&self, title: &str, body: &str) {
        if let Some(tray) = &self.tray {
            tray.notify(title, body);
        }
    }
}

fn tooltip(room: Option<&Snapshot>) -> String {
    let Some(r) = room else { return "3RTC".to_owned() };
    let Phase::InRoom(id) = r.phase else {
        return "3RTC".to_owned();
    };
    let n = r.members.len() + 1;
    let mic = if r.deafened {
        "sound off"
    } else if r.muted {
        "mic off"
    } else {
        "mic on"
    };
    format!(
        "3RTC · Room {id} · {n} {} · {mic}",
        if n == 1 { "person" } else { "people" }
    )
}

fn menu(room: Option<&Snapshot>) -> Vec<MenuItem> {
    let mut items = vec![MenuItem::item(MENU_OPEN, "Open 3RTC"), MenuItem::Separator];
    if let Some(r) = room {
        items.push(MenuItem::check(
            MENU_MUTE,
            "Mute microphone",
            r.muted || r.deafened,
        ));
        items.push(MenuItem::check(MENU_DEAFEN, "Deafen", r.deafened));
        items.push(MenuItem::Separator);
        items.push(MenuItem::item(MENU_LEAVE, "Leave room"));
    }
    items.push(MenuItem::item(MENU_QUIT, "Quit 3RTC"));
    items
}

/// The push-to-talk chirps (made once).
static CHIRP_ON: LazyLock<Vec<u8>> = LazyLock::new(rtc_platform_win::art::ptt_on);
static CHIRP_OFF: LazyLock<Vec<u8>> = LazyLock::new(rtc_platform_win::art::ptt_off);

/// Plays the "talking" (`on`) or "stopped" chirp.
pub(crate) fn chirp(on: bool) {
    rtc_platform_win::play_wav(if on {
        CHIRP_ON.as_slice()
    } else {
        CHIRP_OFF.as_slice()
    });
}

/// Whether `text` mentions `name` (`@name`, any case), for a notification.
pub(crate) fn mentions(text: &str, name: &str) -> bool {
    let name = name.trim();
    if name.chars().count() < 2 {
        return false;
    }
    let text = text.to_lowercase();
    let at = format!("@{}", name.to_lowercase());
    text.match_indices(&at).any(|(i, m)| {
        // "@Sam" mentions Sam, "@Samantha" doesn't
        text[i + m.len()..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric() && c != '_')
    })
}

#[cfg(test)]
mod tests {
    use super::{mentions, menu, tooltip};

    #[test]
    fn mentions_are_at_names() {
        assert!(mentions("hey @Darshan look", "Darshan"));
        assert!(mentions("@darshan!", "Darshan"));
        assert!(!mentions("darshan look", "Darshan"));
        assert!(!mentions("@Sam", "S"));
        assert!(mentions("@Sam, hi", "Sam"));
        assert!(!mentions("@Samantha hi", "Sam"));
    }

    #[test]
    fn the_tray_says_where_you_are() {
        assert_eq!(tooltip(None), "3RTC");
        let items = menu(None);
        assert_eq!(items.len(), 3, "open, a line, quit");
    }
}
