//! Fonts and icons compiled into the app, so it runs from one exe with nothing beside it.

use std::borrow::Cow;

use gpui_kit::{AssetSource, Hsla, Pixels, SharedString, Styled as _, Svg, svg};

macro_rules! bundled {
    ($( $path:literal ),* $(,)?) => {
        &[ $( ($path, include_bytes!(concat!("../assets/", $path)) as &[u8]) ),* ]
    };
}

/// Our own asset files, by path.
const FILES: &[(&str, &[u8])] = bundled!["icons/logo-play.svg", "icons/play.svg", "icons/check.svg",];

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
        if let Some((_, bytes)) = FILES.iter().find(|(p, _)| *p == path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        let mut all: Vec<SharedString> = FILES
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| (*p).into())
            .collect();
        all.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(all)
    }
}

/// An icon from the web app's set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    /// The play triangle inside the logo mark.
    LogoPlay,
    /// A filled play triangle.
    Play,
    /// A check mark.
    Check,
}

impl Icon {
    const fn path(self) -> &'static str {
        match self {
            Self::LogoPlay => "icons/logo-play.svg",
            Self::Play => "icons/play.svg",
            Self::Check => "icons/check.svg",
        }
    }
}

/// An icon element, `size` square, drawn in `color`.
#[must_use]
pub fn icon(which: Icon, size: Pixels, color: Hsla) -> Svg {
    svg().path(which.path()).size(size).flex_none().text_color(color)
}
