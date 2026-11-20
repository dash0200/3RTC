//! Chat text people can select and copy (drag across it, then Ctrl+C), keeping its formatting
//! and clickable links. gpui-base's `SelectableText` only takes plain text, so this is the same
//! element drawn over a `StyledText` with highlights, plus link clicks as `InteractiveText`
//! does them. The window's `TextSelectionLayer` and copy action come with `gpui_kit::Root`; each
//! text redraws the window when its part of the selection changes, so the highlight follows the
//! mouse.

use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::base::{TextSelectionHandle, TextSelectionRegistration, TextSelectionRun, Theme};
use gpui_kit::{
    App, BorderStyle, Bounds, Corners, CursorStyle, DispatchPhase, Edges, Element, ElementId,
    GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId, MouseDownEvent,
    MouseUpEvent, PaintQuad, Pixels, Point, SharedString, StyledText, TextLayout, Window, transparent_black,
};

/// Moving further than this (px) between press and release selects text instead of opening a
/// link.
const CLICK_SLOP: f32 = 4.0;

/// Styled text that joins the window's text selection; `links` are byte ranges of `text` that
/// open their URL on a click.
pub(crate) struct SelectableRich {
    id: ElementId,
    text: SharedString,
    styled: StyledText,
    links: Rc<[(Range<usize>, String)]>,
}

impl SelectableRich {
    pub(crate) fn new(
        id: impl Into<ElementId>,
        text: SharedString,
        styled: StyledText,
        links: Vec<(Range<usize>, String)>,
    ) -> Self {
        Self {
            id: id.into(),
            text,
            styled,
            links: links.into(),
        }
    }
}

/// The selection handle kept between frames, and what redraws the window while a selection is
/// dragged over this text (without it the highlight showed only once the mouse was released).
#[derive(Clone)]
struct Kept {
    handle: TextSelectionHandle,
    _redraw: Rc<gpui_kit::Subscription>,
}

/// Where the mouse went down on this text, kept between frames for link clicks.
#[derive(Default, Clone)]
struct Press(Rc<Cell<Option<Point<Pixels>>>>);

/// The link (its index in `links`) at a byte index of the text.
pub(crate) fn link_at(links: &[(Range<usize>, String)], ix: usize) -> Option<usize> {
    links.iter().position(|(r, _)| r.contains(&ix))
}

/// Whether a press and its release are close enough to be a click.
pub(crate) fn is_click(down: (f32, f32), up: (f32, f32)) -> bool {
    (down.0 - up.0).abs() <= CLICK_SLOP && (down.1 - up.1).abs() <= CLICK_SLOP
}

fn xy(p: Point<Pixels>) -> (f32, f32) {
    (f32::from(p.x), f32::from(p.y))
}

/// The rectangles covering a selection from `start` to `end` (as gpui-base paints it).
fn selection_quads(
    start: Point<Pixels>,
    end: Point<Pixels>,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
) -> Vec<Bounds<Pixels>> {
    if start.y == end.y {
        return vec![Bounds::from_corners(
            start,
            Point::new(end.x, end.y + line_height),
        )];
    }
    let mut quads = vec![Bounds::from_corners(
        start,
        Point::new(bounds.right(), start.y + line_height),
    )];
    if end.y > start.y + line_height {
        quads.push(Bounds::from_corners(
            Point::new(bounds.left(), start.y + line_height),
            Point::new(bounds.right(), end.y),
        ));
    }
    quads.push(Bounds::from_corners(
        Point::new(bounds.left(), end.y),
        Point::new(end.x, end.y + line_height),
    ));
    quads
}

fn paint_selection(layout: &TextLayout, range: Range<usize>, window: &mut Window, cx: &App) {
    let (Some(start), Some(end)) = (
        layout.position_for_index(range.start),
        layout.position_for_index(range.end),
    ) else {
        return;
    };
    let color = Theme::global(cx).tokens.colors.selection;
    for bounds in selection_quads(start, end, layout.bounds(), layout.line_height()) {
        window.paint_quad(PaintQuad {
            bounds,
            background: color.into(),
            corner_radii: Corners::default(),
            border_widths: Edges::default(),
            border_color: transparent_black(),
            border_style: BorderStyle::default(),
        });
    }
}

impl IntoElement for SelectableRich {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectableRich {
    type RequestLayoutState = TextSelectionHandle;
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let text = self.text.clone();
        let handle = match global_id {
            Some(gid) => window.with_element_state(gid, |kept: Option<Kept>, window| {
                let kept = kept.unwrap_or_else(|| {
                    let handle = TextSelectionHandle::new(text, cx);
                    let redraw = Rc::new(handle.refresh_window_on_change(window, cx));
                    Kept {
                        handle,
                        _redraw: redraw,
                    }
                });
                (kept.handle.clone(), kept)
            }),
            None => TextSelectionHandle::new(text, cx),
        };
        let (layout_id, ()) = self.styled.request_layout(global_id, inspector_id, window, cx);
        (layout_id, handle)
    }

    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        handle: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.styled
            .prepaint(global_id, inspector_id, bounds, &mut (), window, cx);
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let registration = TextSelectionRegistration::new(hitbox.clone(), bounds)
            .with_text_bounds(vec![bounds])
            .with_rendered_element(handle, window, cx);
        handle.register(registration, window, cx);
        hitbox
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        handle: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let layout = self.styled.layout().clone();
        let projection = handle.update_runs(
            &[TextSelectionRun::new(self.text.clone(), layout.clone(), bounds)],
            cx,
        );
        for range in projection.ranges().iter().flatten().cloned() {
            paint_selection(&layout, range, window, cx);
        }
        self.styled
            .paint(global_id, inspector_id, bounds, &mut (), &mut (), window, cx);

        if self.links.is_empty() {
            return;
        }
        if let Ok(ix) = layout.index_for_position(window.mouse_position())
            && link_at(&self.links, ix).is_some()
        {
            window.set_cursor_style(CursorStyle::PointingHand, hitbox);
        }
        let press = match global_id {
            Some(gid) => window.with_element_state(gid, |kept: Option<Press>, _| {
                let press = kept.unwrap_or_default();
                (press.clone(), press)
            }),
            None => Press::default(),
        };
        {
            let press = press.clone();
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, _| {
                if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                    press.0.set(Some(e.position));
                }
            });
        }
        let hitbox = hitbox.clone();
        let links = Rc::clone(&self.links);
        window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
            if phase != DispatchPhase::Bubble {
                return;
            }
            let Some(down) = press.0.take() else { return };
            if !hitbox.is_hovered(window) || !is_click(xy(down), xy(e.position)) {
                return;
            }
            if let Ok(ix) = layout.index_for_position(e.position)
                && let Some(i) = link_at(&links, ix)
                && let Some((_, href)) = links.get(i)
            {
                cx.open_url(href);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{is_click, link_at};

    #[test]
    fn a_click_opens_the_link_under_it_and_a_drag_does_not() {
        let links = vec![(4..9, "https://a".to_owned()), (12..15, "https://b".to_owned())];
        assert_eq!(link_at(&links, 3), None);
        assert_eq!(link_at(&links, 4), Some(0));
        assert_eq!(link_at(&links, 8), Some(0));
        assert_eq!(link_at(&links, 9), None);
        assert_eq!(link_at(&links, 14), Some(1));
        assert!(is_click((10.0, 10.0), (12.0, 13.0)));
        assert!(!is_click((10.0, 10.0), (30.0, 10.0)), "dragging selects text");
    }
}
