//! The emoji lists the chat's emoji picker and the reactions editor show (`utils/emoji.ts`).

use gpui_kit::{
    Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, px,
};
use rtc_ui::tokens;

use crate::view::RoomView;

/// One tab of emoji.
pub(crate) struct Category {
    /// Its name (the web app's tooltip; kept for the tests' messages).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) name: &'static str,
    pub(crate) icon: &'static str,
    pub(crate) emojis: &'static [&'static str],
}

/// `EMOJI_CATEGORIES`, in order.
pub(crate) const CATEGORIES: &[Category] = &[
    Category {
        name: "Smileys",
        icon: "😀",
        emojis: &[
            "😀",
            "😃",
            "😄",
            "😁",
            "😆",
            "😅",
            "😂",
            "🤣",
            "🥹",
            "😊",
            "😇",
            "🙂",
            "🙃",
            "😉",
            "😌",
            "😍",
            "🥰",
            "😘",
            "😗",
            "😙",
            "😚",
            "😋",
            "😛",
            "😝",
            "😜",
            "🤪",
            "🤨",
            "🧐",
            "🤓",
            "😎",
            "🥸",
            "🤩",
            "🥳",
            "😏",
            "😒",
            "😞",
            "😔",
            "😟",
            "😕",
            "🙁",
            "☹️",
            "😣",
            "😖",
            "😫",
            "😩",
            "🥺",
            "😢",
            "😭",
            "😮‍💨",
            "😤",
            "😠",
            "😡",
            "🤬",
            "🤯",
            "😳",
            "🥵",
            "🥶",
            "😱",
            "😨",
            "😰",
            "😥",
            "😓",
            "🤗",
            "🫡",
            "🤔",
            "🫣",
            "🤭",
            "🫢",
            "🤫",
            "🫠",
        ],
    },
    Category {
        name: "Gestures",
        icon: "👋",
        emojis: &[
            "👋", "🤚", "🖐️", "✋", "🖖", "🫱", "🫲", "🫳", "🫴", "👌", "🤌", "🤏", "✌️", "🤞", "🫰", "🤟",
            "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌",
            "🫶", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶", "👂", "🦻", "👃",
            "👀", "👁️",
        ],
    },
    Category {
        name: "Hearts & Vibes",
        icon: "❤️",
        emojis: &[
            "❤️",
            "🧡",
            "💛",
            "💚",
            "💙",
            "💜",
            "🖤",
            "🤍",
            "🤎",
            "💔",
            "❤️‍🔥",
            "❤️‍🩹",
            "❣️",
            "💕",
            "💞",
            "💓",
            "💗",
            "💖",
            "💘",
            "💝",
            "💟",
            "✨",
            "🌟",
            "⭐",
            "💫",
            "🔥",
            "💥",
            "⚡",
            "🎉",
            "🎊",
            "🎈",
            "🎁",
            "🏆",
            "🥇",
            "👑",
            "💎",
            "💯",
            "💢",
            "💬",
            "🗯️",
        ],
    },
    Category {
        name: "Fun & Food",
        icon: "🎮",
        emojis: &[
            "🎮", "🕹️", "🎲", "🎯", "🎳", "🎧", "🎵", "🎶", "🎤", "🎬", "🍿", "🍕", "🍔", "🍟", "🌭", "🍣",
            "🍦", "🍩", "🍪", "🍫", "🍻", "🥂", "🍾", "☕", "🧃", "🥤", "🚀", "🛸", "🏎️", "🛵",
        ],
    },
];

/// The category tabs (`.emoji-category-tabs`, `.rx-tabs`): `on_pick` gets the tab clicked.
pub(crate) fn tabs(
    id: &'static str,
    active: usize,
    cx: &mut Context<'_, RoomView>,
    on_pick: fn(&mut RoomView, usize, &mut gpui_kit::Window, &mut Context<'_, RoomView>),
) -> impl IntoElement {
    div()
        .flex()
        .gap(px(4.))
        .children(CATEGORIES.iter().enumerate().map(|(i, c)| {
            let on = i == active;
            div()
                .id(SharedString::from(format!("{id}-{i}")))
                .size(px(36.))
                .rounded(px(9.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(18.))
                .bg(if on { tokens::raised() } else { tokens::bg() })
                .border_1()
                .border_color(if on { tokens::line_strong() } else { tokens::bg() })
                .cursor_pointer()
                .hover(|s| s.bg(tokens::raised()))
                .on_click(cx.listener(move |v, _, window, cx| on_pick(v, i, window, cx)))
                .child(c.icon)
        }))
}

/// Every emoji once, in order (what the chat picker shows while searching).
pub(crate) fn all() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for c in CATEGORIES {
        for e in c.emojis {
            if !out.contains(e) {
                out.push(e);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{CATEGORIES, all};

    #[test]
    fn every_entry_is_one_emoji() {
        assert_eq!(CATEGORIES.len(), 4);
        for c in CATEGORIES {
            for e in c.emojis {
                assert!(rtc_core::fun::is_single_emoji(e), "{} in {}", e, c.name);
            }
        }
        assert!(all().len() > 150);
    }
}
