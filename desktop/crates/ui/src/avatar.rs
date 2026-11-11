//! Avatars: a round initial on a colour picked from the name (`.rd-av`, `getAvatarColor`,
//! `getInitials`), with the speaking ring and the muted badge.

use gpui_kit::{Div, FontWeight, Hsla, IntoElement, ParentElement as _, Pixels, Styled as _, div, px, rgb};

use crate::{Icon, icon_bold, tokens};

/// `PEER_AVATAR_COLORS` in `client-ts/src/utils/sound.ts`.
const COLORS: [u32; 6] = [0x6a_a8ff, 0xf5_b544, 0xc7_9bff, 0x36_d399, 0xff_8a9c, 0xf4_f4f6];

/// The avatar colour for `name`, the same one the web app picks.
#[must_use]
pub fn color(name: &str) -> Hsla {
    let lower = name.to_lowercase();
    let clean = strip_you_host(&lower);
    if clean.is_empty() {
        return rgb(COLORS[0]).into();
    }
    // JavaScript: hash = (hash * 31 + charCodeAt(i)) | 0, over UTF-16 code units
    let hash = clean
        .encode_utf16()
        .fold(0_i32, |h, c| h.wrapping_mul(31).wrapping_add(i32::from(c)));
    let index = usize::try_from(hash.unsigned_abs()).unwrap_or(0) % COLORS.len();
    rgb(COLORS[index]).into()
}

/// `name.replace(/\s*\((you|host).*?\)\s*/gi, '').trim()`
fn strip_you_host(name: &str) -> String {
    let mut out = name.to_owned();
    while let Some(start) = out.find("(you").or_else(|| out.find("(host")) {
        let Some(len) = out[start..].find(')') else { break };
        let before = out[..start].trim_end().to_owned();
        let after = out[start + len + 1..].trim_start().to_owned();
        out = before + &after;
    }
    out.trim().to_owned()
}

/// Initials (`getInitials`): "User_819" → "19", "Riya Kumar" → "RK", "darshan" → "D".
#[must_use]
pub fn initials(name: &str) -> String {
    let clean = name.trim();
    if let Some(num) = clean
        .strip_prefix("User")
        .or_else(|| clean.strip_prefix("user"))
        .map(|r| r.trim_start_matches([' ', '_', '-']))
        .filter(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()))
    {
        return num[num.len().saturating_sub(2)..].to_owned();
    }
    let parts: Vec<&str> = clean.split([' ', '_', '-']).filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2
        && let (Some(a), Some(b)) = (parts[0].chars().next(), parts[1].chars().next())
        && b.is_alphabetic()
    {
        return format!("{a}{b}").to_uppercase();
    }
    clean
        .chars()
        .next()
        .map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect())
}

/// An avatar for `name`, `size` across. `ring_gap` is the colour behind it (the gap between the
/// avatar and its speaking ring, `--ring-gap`).
#[must_use]
pub fn avatar(name: &str, size: f32, speaking: bool, ring_gap: Hsla) -> Div {
    let face = div()
        .size(px(size))
        .flex_none()
        .rounded_full()
        .bg(color(name))
        .text_color(tokens::bg())
        .flex()
        .items_center()
        .justify_center()
        .font_weight(FontWeight::BOLD)
        .text_size(px((size * 0.42).round()))
        .child(initials(name));
    if !speaking {
        return face;
    }
    // speakingPulse: a 2 px gap, then a 3 px live ring
    div()
        .relative()
        .size(px(size))
        .flex_none()
        .child(div().absolute().inset(px(-5.)).rounded_full().bg(tokens::live()))
        .child(div().absolute().inset(px(-2.)).rounded_full().bg(ring_gap))
        .child(face.absolute().inset_0())
}

/// `.dock-peer-muted-badge`: a small red mic-off disc at the bottom right.
#[must_use]
pub fn muted_badge(ring_gap: Hsla, size: Pixels) -> impl IntoElement {
    div()
        .absolute()
        .bottom(px(-2.))
        .right(px(-2.))
        .size(size + px(4.))
        .rounded_full()
        .bg(ring_gap)
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .size(size)
                .rounded_full()
                .bg(rgb(0x00ef_4444))
                .flex()
                .items_center()
                .justify_center()
                .child(icon_bold(Icon::MicOff, size - px(5.), tokens::white())),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_match_the_web() {
        assert_eq!(initials("User_819"), "19");
        assert_eq!(initials("Riya Kumar"), "RK");
        assert_eq!(initials("darshan"), "D");
        assert_eq!(initials("Riya 2"), "R");
        assert_eq!(initials(""), "?");
    }

    #[test]
    fn colours_match_the_web() {
        // what getAvatarColor gives in the browser (node, same function)
        assert_eq!(color("Darshan"), rgb(0xf4_f4f6).into());
        assert_eq!(color("Riya"), rgb(0xf4_f4f6).into());
        assert_eq!(color("Arjun"), rgb(0xff_8a9c).into());
        assert_eq!(color("Someone"), rgb(0xc7_9bff).into());
        assert_eq!(color("Guest"), rgb(0x6a_a8ff).into());
        assert_eq!(color("Darshan (you · host)"), color("Darshan"));
    }
}
