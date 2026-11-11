//! Things that float: popovers above the dock (`.dock-pop`), menus (`.dock-menu`), dialogs with a
//! scrim, toasts (`.toast`) and the small switch (`.dock-switch`).

use gpui_kit::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement, Pixels, SharedString, Stateful, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};

use crate::{Icon, icon, tokens};

/// `.dock-pop`: a card that floats above its anchor.
#[must_use]
pub fn popover() -> Div {
    div()
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .rounded(px(16.))
        .p(px(12.))
        .shadow(tokens::drop_shadow(16., 40., 0.5))
        .text_color(tokens::text())
}

/// `.dock-menu`: a popover holding menu items.
#[must_use]
pub fn menu() -> Div {
    popover().min_w(px(260.)).p(px(6.)).flex().flex_col()
}

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// `.dock-menu-item`: icon, label, and something on the right (a switch).
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn menu_item(
    id: impl Into<ElementId>,
    which: Option<Icon>,
    label: impl Into<SharedString>,
    disabled: bool,
    right: Option<AnyElement>,
    on_click: Option<Click>,
) -> Stateful<Div> {
    let mut el = div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(10.))
        .min_h(px(44.))
        .px(px(12.))
        .rounded(px(10.))
        .text_size(px(14.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(if disabled {
            tokens::text_3()
        } else {
            tokens::text()
        })
        .when_some(which, |el, i| el.child(icon(i, px(18.), tokens::text_2())))
        .child(div().flex_1().child(label.into()))
        .when_some(right, ParentElement::child);
    if !disabled {
        el = el.cursor_pointer().hover(|s| s.bg(tokens::raised()));
        if let Some(f) = on_click {
            el = el.on_click(f);
        }
    }
    el
}

/// `.dock-switch`: 34×20, green when on.
#[must_use]
pub fn switch(on: bool) -> Div {
    div()
        .relative()
        .w(px(34.))
        .h(px(20.))
        .flex_none()
        .rounded(px(10.))
        .bg(if on { tokens::live() } else { tokens::line_strong() })
        .child(
            div()
                .absolute()
                .top(px(3.))
                .left(px(if on { 17. } else { 3. }))
                .size(px(14.))
                .rounded_full()
                .bg(tokens::white()),
        )
}

/// A dialog: the scrim over the whole window, the card centred. `on_dismiss` runs when the scrim
/// is clicked.
#[must_use]
pub fn dialog(
    id: impl Into<ElementId>,
    width: Pixels,
    card: impl IntoElement,
    on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .absolute()
        .inset_0()
        .occlude()
        .bg(tokens::black(0.6))
        .flex()
        .items_center()
        .justify_center()
        .on_click(move |_, window, cx| on_dismiss(window, cx))
        .child(
            div()
                .id("dialog-card")
                .w(width)
                .max_w(px(width.into()))
                .bg(tokens::surface())
                .border_1()
                .border_color(tokens::line())
                .rounded(px(20.))
                .shadow(tokens::drop_shadow(16., 40., 0.7))
                .text_color(tokens::text())
                // clicks inside the card don't reach the scrim
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(card),
        )
}

/// `.toast`: a pill near the bottom of the stage.
#[must_use]
pub fn toast(text: SharedString) -> impl IntoElement {
    div()
        .px(px(22.))
        .py(px(10.))
        .rounded_full()
        .bg(tokens::raised())
        .border_1()
        .border_color(tokens::line_strong())
        .shadow(tokens::drop_shadow(8., 24., 0.5))
        .text_color(tokens::text())
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .child(text)
}
