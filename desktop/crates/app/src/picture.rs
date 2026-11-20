//! A picture drawn from SVG that is rebuilt whenever a game changes (the Ludo board, Tycoon's
//! overlay), freed as soon as it's replaced.
//!
//! `img(Arc<Image>)` caches every picture it is given in gpui's asset cache and puts it on the
//! GPU, and nothing ever freed them: each move kept a 900×900 or 1000×1000 picture (3–4 MB), which
//! added up over a long game. Here each replaced picture leaves gpui's cache, and the GPU once it
//! has been shown. The last decoded one also stays up while the next decodes, so the board never
//! blinks.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use gpui_kit::{App, Corners, Image, ImageFormat, IntoElement, RenderImage, Styled as _, canvas};

/// The picture on screen, with its decoded form.
type Shown = Rc<RefCell<Option<(Arc<Image>, Arc<RenderImage>)>>>;

/// One picture that changes over time.
#[derive(Default)]
pub(crate) struct LivePicture {
    /// The SVG asked for last, and its picture (maybe still decoding).
    source: RefCell<Option<(String, Arc<Image>)>>,
    /// The picture on screen and its decoded form.
    shown: Shown,
}

impl LivePicture {
    /// The picture for `svg` (the same one while `svg` doesn't change). One that was asked for
    /// but never shown before this newer one is freed at once.
    pub(crate) fn for_svg(&self, svg: String, cx: &mut App) -> Arc<Image> {
        if let Some((old, image)) = self.source.borrow().as_ref()
            && *old == svg
        {
            return Arc::clone(image);
        }
        let image = Arc::new(Image::from_bytes(ImageFormat::Svg, svg.clone().into_bytes()));
        let superseded = self.source.borrow_mut().replace((svg, Arc::clone(&image)));
        if let Some((_, old)) = superseded {
            let on_screen = self.shown.borrow().as_ref().is_some_and(|(s, _)| s.id == old.id);
            if !on_screen {
                old.remove_asset(cx);
            }
        }
        image
    }

    /// Draws `image` over its whole box (give the box its size).
    pub(crate) fn paint(&self, image: Arc<Image>) -> impl IntoElement {
        let shown = Rc::clone(&self.shown);
        canvas(
            |_, _, _| (),
            move |bounds, (), window, cx| {
                if let Some(render) = Arc::clone(&image).use_render_image(window, cx) {
                    let old = shown.borrow_mut().replace((Arc::clone(&image), render));
                    if let Some((old_image, old_render)) = old
                        && old_image.id != image.id
                    {
                        old_image.remove_asset(cx);
                        cx.drop_image(old_render, Some(window));
                    }
                }
                if let Some((_, render)) = shown.borrow().as_ref() {
                    let _ =
                        window.paint_image(bounds, bounds, Corners::default(), Arc::clone(render), 0, false);
                }
            },
        )
        .size_full()
    }
}
