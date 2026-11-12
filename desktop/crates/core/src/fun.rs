//! Reactions and the soundboard (`features/reactions/useReactions.ts`,
//! `features/soundboard/useSoundboard.ts`): which emoji count, the combo count and the limits
//! that keep a flood from anyone down to a trickle.

use std::collections::BTreeMap;

use rtc_protocol::PeerId;
use unicode_segmentation::UnicodeSegmentation as _;

/// Ours: the shortest gap between two reactions (~8.7 a second while a key is held).
pub const SEND_GAP_MS: f64 = 115.0;
/// The same emoji again within this grows the combo.
pub const COMBO_WINDOW_MS: f64 = 1200.0;
/// Theirs: a burst allowance per person…
const BUCKET_SIZE: f64 = 10.0;
/// …refilled at this rate per second.
const BUCKET_REFILL_PER_S: f64 = 10.0;
/// Soundboard: our own clicks closer than this are one click.
pub const SOUND_LOCAL_GAP_MS: f64 = 30.0;
/// Soundboard: clips from others closer than this are dropped (message loops).
pub const SOUND_REMOTE_GAP_MS: f64 = 40.0;
/// Soundboard: a toast and a log line at most this often.
pub const SOUND_NOTICE_GAP_MS: f64 = 1200.0;

/// A character that may be part of an emoji (`\p{Extended_Pictographic}`, skin tones, flags,
/// joiners and the like).
fn emoji_char(c: char) -> bool {
    pictographic(c)
        || matches!(c as u32,
            0x200D | 0xFE0F | 0x20E3 | 0x1F3FB..=0x1F3FF | 0x1F1E6..=0x1F1FF | 0xE0020..=0xE007F)
}

/// `\p{Extended_Pictographic}` (and the regional-indicator letters, which make flags).
fn pictographic(c: char) -> bool {
    matches!(c as u32,
        0x00A9 | 0x00AE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x2194..=0x2199 | 0x21A9..=0x21AA
        | 0x231A..=0x231B | 0x2328 | 0x2388 | 0x23CF | 0x23E9..=0x23F3 | 0x23F8..=0x23FA | 0x24C2
        | 0x25AA..=0x25AB | 0x25B6 | 0x25C0 | 0x25FB..=0x25FE | 0x2600..=0x27BF | 0x2934..=0x2935
        | 0x2B05..=0x2B07 | 0x2B1B..=0x2B1C | 0x2B50 | 0x2B55 | 0x3030 | 0x303D | 0x3297 | 0x3299
        | 0x1F000..=0x1F3FA | 0x1F400..=0x1FAFF | 0x1FC00..=0x1FFFD)
}

/// Exactly one emoji, however many characters it's built from (👩‍🚀, 🇮🇳, ❤️) (`isSingleEmoji`).
#[must_use]
pub fn is_single_emoji(text: &str) -> bool {
    let v = text.trim();
    if v.is_empty() || v.encode_utf16().count() > 16 || !v.chars().all(emoji_char) {
        return false;
    }
    v.chars().any(pictographic) && v.graphemes(true).count() == 1
}

/// The emoji in `text`, one each (pasting "😀🔥" gives both) (`splitEmojis`).
#[must_use]
pub fn split_emojis(text: &str) -> Vec<String> {
    text.graphemes(true)
        .filter(|g| is_single_emoji(g))
        .map(|g| g.trim().to_owned())
        .collect()
}

/// A run of the same emoji.
#[derive(Debug, Clone)]
struct Combo {
    emoji: String,
    at: f64,
    n: u32,
}

impl Combo {
    const EMPTY: Self = Self {
        emoji: String::new(),
        at: 0.0,
        n: 0,
    };

    fn next(&mut self, emoji: &str, now: f64) -> u32 {
        if self.n > 0 && self.emoji == emoji && now - self.at < COMBO_WINDOW_MS {
            self.n += 1;
        } else {
            self.n = 1;
        }
        emoji.clone_into(&mut self.emoji);
        self.at = now;
        self.n
    }
}

/// The reaction and soundboard limits for one room.
#[derive(Debug, Clone)]
pub struct Fun {
    last_sent: Option<f64>,
    mine: Combo,
    theirs: BTreeMap<PeerId, (Combo, f64, f64)>,
    last_sound_local: Option<f64>,
    last_sound_remote: Option<f64>,
    last_sound_notice: Option<f64>,
}

impl Default for Fun {
    fn default() -> Self {
        Self::new()
    }
}

impl Fun {
    /// Nothing sent or heard yet.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            last_sent: None,
            mine: Combo::EMPTY,
            theirs: BTreeMap::new(),
            last_sound_local: None,
            last_sound_remote: None,
            last_sound_notice: None,
        }
    }

    /// Our reaction at `now`: its combo count, or `None` when it's too soon after the last.
    pub fn send(&mut self, emoji: &str, now: f64) -> Option<u32> {
        if !is_single_emoji(emoji) || self.last_sent.is_some_and(|t| now - t < SEND_GAP_MS) {
            return None;
        }
        self.last_sent = Some(now);
        Some(self.mine.next(emoji, now))
    }

    /// A reaction from `peer`: its combo count (theirs if they sent a sensible one), or `None`
    /// when it isn't one emoji or they're over their rate.
    pub fn receive(&mut self, peer: &PeerId, emoji: &str, combo: Option<f64>, now: f64) -> Option<u32> {
        if !is_single_emoji(emoji) {
            return None;
        }
        let (state, tokens, at) = self
            .theirs
            .entry(peer.clone())
            .or_insert_with(|| (Combo::EMPTY, BUCKET_SIZE, now));
        *tokens = (*tokens + (now - *at) / 1000.0 * BUCKET_REFILL_PER_S).min(BUCKET_SIZE);
        *at = now;
        if *tokens < 1.0 {
            return None;
        }
        *tokens -= 1.0;
        let derived = state.next(emoji, now);
        Some(match combo {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(c) if c.fract() == 0.0 && c >= 1.0 => c.min(999.0) as u32,
            _ => derived,
        })
    }

    /// Forget someone who left.
    pub fn forget(&mut self, peer: &PeerId) {
        self.theirs.remove(peer);
    }

    /// Our soundboard click at `now`: false for a double event.
    pub fn sound_local(&mut self, now: f64) -> bool {
        if self
            .last_sound_local
            .is_some_and(|t| now - t < SOUND_LOCAL_GAP_MS)
        {
            return false;
        }
        self.last_sound_local = Some(now);
        true
    }

    /// A clip from someone at `now`: whether to play it, and whether to say so (toast and log).
    pub fn sound_remote(&mut self, now: f64) -> Option<bool> {
        if self
            .last_sound_remote
            .is_some_and(|t| now - t < SOUND_REMOTE_GAP_MS)
        {
            return None;
        }
        self.last_sound_remote = Some(now);
        let say = self
            .last_sound_notice
            .is_none_or(|t| now - t > SOUND_NOTICE_GAP_MS);
        if say {
            self.last_sound_notice = Some(now);
        }
        Some(say)
    }
}

#[cfg(test)]
mod tests {
    use rtc_protocol::PeerId;

    use super::{Fun, is_single_emoji, split_emojis};

    #[test]
    fn single_emoji_like_the_web_app() {
        for yes in ["👍", "❤️", "👩‍🚀", "🇮🇳", "👍🏽", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", " 🔥 ", "☕", "❤️‍🔥"]
        {
            assert!(is_single_emoji(yes), "{yes}");
        }
        for no in ["", "a", "👍👍", "hi 👍", "1", "🏽", "<script>"] {
            assert!(!is_single_emoji(no), "{no}");
        }
        assert_eq!(split_emojis("😀 x🔥"), vec!["😀".to_owned(), "🔥".to_owned()]);
    }

    #[test]
    fn our_reactions_are_paced_and_count_combos() {
        let mut f = Fun::default();
        assert_eq!(f.send("🔥", 0.0), Some(1));
        assert_eq!(f.send("🔥", 50.0), None, "too soon");
        assert_eq!(f.send("🔥", 200.0), Some(2));
        assert_eq!(f.send("🔥", 400.0), Some(3));
        assert_eq!(f.send("👍", 600.0), Some(1), "another emoji starts again");
        assert_eq!(f.send("👍", 3000.0), Some(1), "after a pause too");
        assert_eq!(f.send("not one", 5000.0), None);
    }

    #[test]
    fn a_flood_from_someone_becomes_a_trickle() {
        let mut f = Fun::default();
        let p = PeerId::new("p").unwrap();
        let got = (0..100)
            .filter(|i| f.receive(&p, "🎉", None, f64::from(*i)).is_some())
            .count();
        assert_eq!(got, 10, "the burst allowance, then nothing within 0.1 s");
        assert!(
            f.receive(&p, "🎉", None, 1100.0).is_some(),
            "refilled after a second"
        );
        assert_eq!(
            f.receive(&p, "🎉", Some(7.0), 5000.0),
            Some(7),
            "their combo count wins"
        );
        assert_eq!(f.receive(&p, "🎉", Some(2.5), 5001.0), Some(2), "else ours");
        assert!(f.receive(&p, "nope", None, 9000.0).is_none());
    }

    #[test]
    fn soundboard_gaps() {
        let mut f = Fun::default();
        assert!(f.sound_local(0.0));
        assert!(!f.sound_local(10.0));
        assert_eq!(f.sound_remote(0.0), Some(true));
        assert_eq!(f.sound_remote(20.0), None);
        assert_eq!(
            f.sound_remote(100.0),
            Some(false),
            "plays, but no second toast yet"
        );
        assert_eq!(f.sound_remote(1500.0), Some(true));
    }
}
