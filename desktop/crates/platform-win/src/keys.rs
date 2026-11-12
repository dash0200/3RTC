//! Keys and key combinations, by Windows virtual-key code: names to show, and the bindings the
//! user records for push-to-talk and the global mute and deafen hotkeys.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A key or mouse button, by Windows virtual-key code (`VK_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Key(pub u8);

impl Key {
    /// Shift (either side).
    pub const SHIFT: Self = Self(0x10);
    /// Ctrl (either side).
    pub const CTRL: Self = Self(0x11);
    /// Alt (either side).
    pub const ALT: Self = Self(0x12);
    /// The Windows key.
    pub const WIN: Self = Self(0x5B);
    /// The middle mouse button.
    pub const MOUSE_MIDDLE: Self = Self(0x04);
    /// The first side mouse button ("back").
    pub const MOUSE_4: Self = Self(0x05);
    /// The second side mouse button ("forward").
    pub const MOUSE_5: Self = Self(0x06);
    /// `` ` `` / `~`, left of 1.
    pub const BACKQUOTE: Self = Self(0xC0);
    /// Caps Lock.
    pub const CAPS_LOCK: Self = Self(0x14);
    /// Space.
    pub const SPACE: Self = Self(0x20);

    /// One key for both sides (Left Ctrl and Right Ctrl are just Ctrl), or `None` for codes
    /// that aren't keys a person presses on purpose (the left and right mouse buttons, IME
    /// helpers, unassigned codes).
    #[must_use]
    pub fn normalize(self) -> Option<Self> {
        match self.0 {
            0x01..=0x03 | 0x07 | 0x0A..=0x0B | 0x0E..=0x0F | 0x15..=0x1A | 0x1C..=0x1F => None,
            0x3A..=0x40 | 0x5F | 0x88..=0x8F | 0x92..=0x9F | 0xE5 | 0xE7 | 0xFF => None,
            0xA0 | 0xA1 => Some(Self::SHIFT),
            0xA2 | 0xA3 => Some(Self::CTRL),
            0xA4 | 0xA5 => Some(Self::ALT),
            0x5C => Some(Self::WIN),
            _ => Some(self),
        }
    }

    /// Ctrl, Alt, Shift and Win: keys held with another key.
    #[must_use]
    pub fn is_modifier(self) -> bool {
        matches!(self, Self::SHIFT | Self::CTRL | Self::ALT | Self::WIN)
    }

    /// Mouse buttons (middle and the two side buttons).
    #[must_use]
    pub fn is_mouse(self) -> bool {
        matches!(self, Self::MOUSE_MIDDLE | Self::MOUSE_4 | Self::MOUSE_5)
    }

    /// The order modifiers are shown in: Ctrl, Alt, Shift, Win, then the key.
    fn rank(self) -> u8 {
        match self {
            Self::CTRL => 0,
            Self::ALT => 1,
            Self::SHIFT => 2,
            Self::WIN => 3,
            _ => 4,
        }
    }

    /// What the key is called on screen.
    #[must_use]
    pub fn label(self) -> String {
        let fixed = match self.0 {
            0x04 => "Middle mouse",
            0x05 => "Mouse 4",
            0x06 => "Mouse 5",
            0x08 => "Backspace",
            0x09 => "Tab",
            0x0C => "Clear",
            0x0D => "Enter",
            0x10 => "Shift",
            0x11 => "Ctrl",
            0x12 => "Alt",
            0x13 => "Pause",
            0x14 => "Caps Lock",
            0x1B => "Esc",
            0x20 => "Space",
            0x21 => "Page Up",
            0x22 => "Page Down",
            0x23 => "End",
            0x24 => "Home",
            0x25 => "Left",
            0x26 => "Up",
            0x27 => "Right",
            0x28 => "Down",
            0x2C => "Print Screen",
            0x2D => "Insert",
            0x2E => "Delete",
            0x5B | 0x5C => "Win",
            0x5D => "Menu",
            0x6A => "Num *",
            0x6B => "Num +",
            0x6D => "Num -",
            0x6E => "Num .",
            0x6F => "Num /",
            0x90 => "Num Lock",
            0x91 => "Scroll Lock",
            0xAD => "Volume Mute",
            0xAE => "Volume Down",
            0xAF => "Volume Up",
            0xB0 => "Next Track",
            0xB1 => "Previous Track",
            0xB3 => "Play/Pause",
            0xBA => ";",
            0xBB => "=",
            0xBC => ",",
            0xBD => "-",
            0xBE => ".",
            0xBF => "/",
            0xC0 => "~",
            0xDB => "[",
            0xDC => "\\",
            0xDD => "]",
            0xDE => "'",
            _ => "",
        };
        if !fixed.is_empty() {
            return fixed.to_owned();
        }
        match self.0 {
            c @ (0x30..=0x39 | 0x41..=0x5A) => char::from(c).to_string(),
            c @ 0x60..=0x69 => format!("Num {}", c - 0x60),
            c @ 0x70..=0x87 => format!("F{}", c - 0x6F),
            c => format!("Key {c:#04X}"),
        }
    }
}

/// A key combination: any modifiers, then at most one other key (or mouse button). Held
/// together, it counts as pressed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Binding(Vec<Key>);

impl Binding {
    /// A binding of one key.
    #[must_use]
    pub fn key(key: Key) -> Self {
        Self(vec![key])
    }

    /// The combination these held keys make: their modifiers, plus the last other key pressed
    /// (`keys` in the order they went down). `None` if nothing usable is held.
    #[must_use]
    pub fn from_held(keys: &[Key]) -> Option<Self> {
        let mut out: Vec<Key> = Vec::new();
        let mut main = None;
        for k in keys.iter().filter_map(|k| k.normalize()) {
            if k.is_modifier() {
                if !out.contains(&k) {
                    out.push(k);
                }
            } else {
                main = Some(k);
            }
        }
        out.extend(main);
        out.sort_by_key(|k| k.rank());
        (!out.is_empty()).then_some(Self(out))
    }

    /// The keys, modifiers first.
    #[must_use]
    pub fn keys(&self) -> &[Key] {
        &self.0
    }

    /// No keys: nothing set.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Display for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let labels: Vec<String> = self.0.iter().map(|k| k.label()).collect();
        f.write_str(&labels.join(" + "))
    }
}

#[cfg(test)]
mod tests {
    use super::{Binding, Key};

    #[test]
    fn names_keys_like_the_keyboard() {
        assert_eq!(Key(0x41).label(), "A");
        assert_eq!(Key(0x35).label(), "5");
        assert_eq!(Key(0x70).label(), "F1");
        assert_eq!(Key(0x87).label(), "F24");
        assert_eq!(Key(0x63).label(), "Num 3");
        assert_eq!(Key::BACKQUOTE.label(), "~");
        assert_eq!(Key::MOUSE_4.label(), "Mouse 4");
        assert_eq!(Key(0xE9).label(), "Key 0xE9");
    }

    #[test]
    fn left_and_right_modifiers_are_one_key() {
        assert_eq!(Key(0xA2).normalize(), Some(Key::CTRL));
        assert_eq!(Key(0xA5).normalize(), Some(Key::ALT));
        assert_eq!(Key(0x5C).normalize(), Some(Key::WIN));
        assert_eq!(Key(0x01).normalize(), None, "left click never counts");
        assert_eq!(Key(0x02).normalize(), None, "right click never counts");
    }

    #[test]
    fn combinations_put_modifiers_first_and_keep_one_key() {
        let b = Binding::from_held(&[Key(0x4D), Key(0xA0), Key(0xA2)]);
        assert_eq!(
            b.as_ref().map(ToString::to_string).as_deref(),
            Some("Ctrl + Shift + M")
        );
        // two ordinary keys: the last one pressed wins
        let b = Binding::from_held(&[Key(0x41), Key(0x42)]);
        assert_eq!(b.as_ref().map(ToString::to_string).as_deref(), Some("B"));
        // a modifier alone is fine (the web app offers Ctrl and Alt for push-to-talk)
        let b = Binding::from_held(&[Key(0xA3)]);
        assert_eq!(b, Some(Binding::key(Key::CTRL)));
        assert_eq!(Binding::from_held(&[Key(0x01)]), None);
        assert_eq!(Binding::from_held(&[]), None);
    }

    #[test]
    fn saves_as_a_list_of_codes() -> Result<(), serde_json::Error> {
        let b = Binding::from_held(&[Key::CTRL, Key::MOUSE_4]).unwrap_or_default();
        let json = serde_json::to_string(&b)?;
        assert_eq!(json, "[17,5]");
        assert_eq!(serde_json::from_str::<Binding>(&json)?, b);
        Ok(())
    }
}
