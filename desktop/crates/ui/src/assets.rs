//! Fonts and icons compiled into the app, so it runs from one exe with nothing beside it.

use std::borrow::Cow;

use gpui_kit::{AssetSource, Hsla, Pixels, SharedString, Styled as _, Svg, svg};

use crate::icons::Icon;

/// Our own asset files that aren't in the web icon set (chess pieces: `pieces.tsx`; Last Card
/// symbols and card back: `lastcard/cards.tsx`; the Tycoon board: `tycoon/BoardView.tsx`), drawn in
/// colour by `img`.
const OWN: &[(&str, &[u8])] = &[
    ("icons/logo-play.svg", include_bytes!("../assets/logo-play.svg")),
    ("chess/wp.svg", include_bytes!("../assets/chess/wp.svg")),
    ("chess/wn.svg", include_bytes!("../assets/chess/wn.svg")),
    ("chess/wb.svg", include_bytes!("../assets/chess/wb.svg")),
    ("chess/wr.svg", include_bytes!("../assets/chess/wr.svg")),
    ("chess/wq.svg", include_bytes!("../assets/chess/wq.svg")),
    ("chess/wk.svg", include_bytes!("../assets/chess/wk.svg")),
    ("chess/bp.svg", include_bytes!("../assets/chess/bp.svg")),
    ("chess/bn.svg", include_bytes!("../assets/chess/bn.svg")),
    ("chess/bb.svg", include_bytes!("../assets/chess/bb.svg")),
    ("chess/br.svg", include_bytes!("../assets/chess/br.svg")),
    ("chess/bq.svg", include_bytes!("../assets/chess/bq.svg")),
    ("chess/bk.svg", include_bytes!("../assets/chess/bk.svg")),
    ("lastcard/skip.svg", include_bytes!("../assets/lastcard/skip.svg")),
    (
        "lastcard/reverse.svg",
        include_bytes!("../assets/lastcard/reverse.svg"),
    ),
    (
        "lastcard/wheel.svg",
        include_bytes!("../assets/lastcard/wheel.svg"),
    ),
    ("lastcard/back.svg", include_bytes!("../assets/lastcard/back.svg")),
    ("tycoon/board.svg", include_bytes!("../assets/tycoon/board.svg")),
];

fn find(path: &str) -> Option<&'static [u8]> {
    OWN.iter()
        .chain(crate::icons::FILES)
        .find(|(p, _)| *p == path)
        .map(|(_, b)| *b)
}

/// The bundled font files (static weights: every renderer picks them the same way).
pub(crate) fn fonts() -> Vec<Cow<'static, [u8]>> {
    macro_rules! font {
        ($name:literal) => {
            Cow::Borrowed(include_bytes!(concat!("../assets/fonts/", $name)) as &[u8])
        };
    }
    vec![
        font!("Figtree-Regular.ttf"),
        font!("Figtree-Medium.ttf"),
        font!("Figtree-SemiBold.ttf"),
        font!("Figtree-Bold.ttf"),
        font!("Figtree-ExtraBold.ttf"),
        font!("Figtree-Black.ttf"),
        font!("BricolageGrotesque-Bold.ttf"),
        font!("BricolageGrotesque-ExtraBold.ttf"),
        font!("BricolageGrotesqueTight10-Bold.ttf"),
        font!("BricolageGrotesqueTight20-Bold.ttf"),
        font!("BricolageGrotesqueTight30-Bold.ttf"),
        font!("JetBrainsMono-Medium.ttf"),
        font!("JetBrainsMono-Bold.ttf"),
    ]
}

/// The app's asset source: our files first, then the component library's own.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = find(path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        let mut all: Vec<SharedString> = OWN
            .iter()
            .chain(crate::icons::FILES)
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| (*p).into())
            .collect();
        all.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(all)
    }
}

/// The play triangle in the logo mark.
#[must_use]
pub fn logo_play(size: Pixels, color: Hsla) -> Svg {
    svg()
        .path("icons/logo-play.svg")
        .size(size)
        .flex_none()
        .text_color(color)
}

/// An icon at the web default stroke (2), `size` square, in `color`.
#[must_use]
pub fn icon(which: Icon, size: Pixels, color: Hsla) -> Svg {
    svg()
        .path(which.paths().0)
        .size(size)
        .flex_none()
        .text_color(color)
}

/// An icon at the bolder stroke (2.4; the web app's `strokeWidth={2.2 or 2.4}`).
#[must_use]
pub fn icon_bold(which: Icon, size: Pixels, color: Hsla) -> Svg {
    let (normal, bold) = which.paths();
    svg()
        .path(bold.unwrap_or(normal))
        .size(size)
        .flex_none()
        .text_color(color)
}
