//! Chat pictures and the composer's extras (`LiveChat.tsx`, `features/chat/useChat.ts`): attach,
//! paste or drop a picture, its progress either way, the lightbox, the emoji picker and the
//! quick reactions row.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::{
    AnyElement, Context, ExternalPaths, FontWeight, Hsla, Image, ImageFormat, InteractiveElement as _,
    IntoElement, ObjectFit, ParentElement as _, PathPromptOptions, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, div, img,
    prelude::FluentBuilder as _, px,
};
use rtc_engine::{ChatLine, OutgoingImage};
use rtc_protocol::image::{MAX_SEND_BYTES, format_size, mime_for_name};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::view::{Dialog, RoomView};

/// A chat picture: how far along, and the picture once it's here.
#[derive(Default)]
pub(crate) struct Picture {
    pub(crate) percent: u8,
    pub(crate) image: Option<Arc<Image>>,
    pub(crate) bytes: Option<Arc<[u8]>>,
    /// Still on its way (in or out).
    pub(crate) moving: bool,
}

/// A picture attached to the next message.
pub(crate) struct Pending {
    pub(crate) name: String,
    pub(crate) mime: &'static str,
    pub(crate) bytes: Arc<[u8]>,
    pub(crate) image: Option<Arc<Image>>,
}

/// The format to show bytes as, from the type sent (`None`: we can't draw it, e.g. AVIF).
fn format_for(mime: &str) -> Option<ImageFormat> {
    Some(match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::Webp,
        "image/gif" => ImageFormat::Gif,
        "image/bmp" => ImageFormat::Bmp,
        _ => return None,
    })
}

/// The type of a picture file, from its first bytes (a pasted or dropped file may have no name).
pub(crate) fn sniff(bytes: &[u8]) -> Option<&'static str> {
    Some(match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'B', b'M', ..] => "image/bmp",
        _ => return None,
    })
}

fn picture(mime: &str, bytes: &[u8]) -> Option<Arc<Image>> {
    format_for(mime).map(|f| Arc::new(Image::from_bytes(f, bytes.to_vec())))
}

/// Where pictures are saved by default.
fn downloads() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(std::env::temp_dir, |h| PathBuf::from(h).join("Downloads"))
}

impl RoomView {
    /// The paperclip: pick a picture.
    pub(crate) fn attach_clicked(&mut self, cx: &mut Context<'_, Self>) {
        let pick = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Send a file or image".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = pick.await
                && let Some(p) = paths.into_iter().next()
            {
                let _ = this.update(cx, |v, cx| v.attach_file(&p, cx));
            }
        })
        .detach();
    }

    /// A file picked or dropped: attach it.
    pub(crate) fn attach_file(&mut self, path: &Path, cx: &mut Context<'_, Self>) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        match std::fs::metadata(path) {
            Ok(m) if m.len() > MAX_SEND_BYTES as u64 => {
                self.show_toast("File exceeds 10 GB limit. Please select a smaller file.", cx);
                return;
            }
            Err(_) => return,
            Ok(_) => {}
        }
        match std::fs::read(path) {
            Ok(bytes) => self.attach(name, bytes, cx),
            Err(e) => self.show_toast(format!("Couldn't open {name}: {e}"), cx),
        }
    }

    /// Bytes of a file or picture to send with the next message.
    pub(crate) fn attach(&mut self, name: String, bytes: Vec<u8>, cx: &mut Context<'_, Self>) {
        let mime = sniff(&bytes)
            .or_else(|| mime_for_name(&name))
            .unwrap_or("application/octet-stream");
        if bytes.len() > MAX_SEND_BYTES {
            self.show_toast("File exceeds 10 GB limit. Please select a smaller file.", cx);
            return;
        }
        let name = if name.is_empty() {
            if mime.starts_with("image/") {
                "screenshot.png".to_owned()
            } else {
                "file.bin".to_owned()
            }
        } else {
            name
        };
        let image = picture(mime, &bytes);
        self.pending = Some(Pending {
            name,
            mime,
            bytes: bytes.into(),
            image,
        });
        if self.tab != crate::view::Tab::Chat {
            self.set_tab(crate::view::Tab::Chat, cx);
        }
        cx.notify();
    }

    /// A paste into the message box: a picture (or a picture file) is attached; text pastes
    /// as usual (false).
    pub(crate) fn paste_picture(
        &mut self,
        item: &gpui_kit::ClipboardItem,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        for entry in item.entries() {
            match entry {
                gpui_kit::ClipboardEntry::Image(i) => {
                    self.attach(String::new(), i.bytes.clone(), cx);
                    return true;
                }
                gpui_kit::ClipboardEntry::ExternalPaths(p) => {
                    if let Some(path) = p
                        .paths()
                        .iter()
                        .find(|p| mime_for_name(&p.to_string_lossy()).is_some())
                    {
                        self.attach_file(&path.clone(), cx);
                        return true;
                    }
                }
                gpui_kit::ClipboardEntry::String(_) => {}
            }
        }
        false
    }

    /// Files dropped on the window: the first picture is attached.
    pub(crate) fn dropped(&mut self, paths: &ExternalPaths, cx: &mut Context<'_, Self>) {
        if self.in_room().is_none() {
            return;
        }
        if let Some(p) = paths
            .paths()
            .iter()
            .find(|p| mime_for_name(&p.to_string_lossy()).is_some())
        {
            self.attach_file(&p.clone(), cx);
        }
    }

    /// Sends the attached picture with `caption`.
    pub(crate) fn send_picture(&mut self, caption: String, cx: &mut Context<'_, Self>) {
        let Some(p) = self.pending.take() else { return };
        let transfer_id = format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
        self.pictures.insert(
            transfer_id.clone(),
            Picture {
                percent: 0,
                image: p.image,
                bytes: Some(Arc::clone(&p.bytes)),
                moving: true,
            },
        );
        if let Some(e) = &self.engine {
            e.send_image(OutgoingImage {
                id: rtc_engine::Handle::new_message_id(),
                transfer_id,
                file_name: p.name,
                mime: p.mime.to_owned(),
                bytes: p.bytes,
                caption,
            });
        }
        cx.notify();
    }

    /// A chat line arrived (or went): pictures start their progress; the web app's sounds.
    pub(crate) fn chat_line_sounds(&mut self, line: &ChatLine) {
        let mine = self.room.as_ref().is_some_and(|r| r.me == line.from);
        match &line.image {
            Some(i) => {
                let p = self.pictures.entry(i.transfer_id.clone()).or_default();
                if !mine {
                    p.moving = true;
                    self.ui_sound(&crate::sounds::CHIME, crate::sounds::CHIME_WAV.as_slice());
                } else {
                    self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
                }
            }
            None => self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice()),
        }
    }

    pub(crate) fn picture_progress(&mut self, transfer_id: String, percent: u8) {
        let p = self.pictures.entry(transfer_id).or_default();
        p.percent = percent;
        if percent >= 100 && p.bytes.is_some() {
            p.moving = false;
        }
    }

    pub(crate) fn picture_ready(&mut self, transfer_id: &str, bytes: Arc<[u8]>) {
        let mime = self
            .chat
            .iter()
            .rev()
            .find_map(|l| l.image.as_ref().filter(|i| i.transfer_id == transfer_id))
            .map_or("image/png", |i| rtc_protocol::image::clean_mime(&i.mime));
        let p = self.pictures.entry(transfer_id.to_owned()).or_default();
        p.image = picture(mime, &bytes);
        p.bytes = Some(bytes);
        p.percent = 100;
        p.moving = false;
        self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
    }

    /// Saves the lightbox's picture where the user picks (Downloads first).
    pub(crate) fn save_picture(&mut self, transfer_id: &str, cx: &mut Context<'_, Self>) {
        let Some(line) = self
            .chat
            .iter()
            .find(|l| l.image.as_ref().is_some_and(|i| i.transfer_id == transfer_id))
        else {
            return;
        };
        let Some(image) = &line.image else { return };
        let Some(bytes) = self.pictures.get(transfer_id).and_then(|p| p.bytes.clone()) else {
            return;
        };
        let name = rtc_protocol::image::safe_file_save_name(&image.file_name, &image.mime);
        let ask = cx.prompt_for_new_path(&downloads(), Some(&name));
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(path))) = ask.await {
                let said = match std::fs::write(&path, &bytes) {
                    Ok(()) => format!("Saved {}", path.display()),
                    Err(e) => format!("Couldn't save the file: {e}"),
                };
                let _ = this.update(cx, |v, cx| v.show_toast(said, cx));
            }
        })
        .detach();
    }

    pub(crate) fn open_lightbox(&mut self, transfer_id: String, cx: &mut Context<'_, Self>) {
        self.lightbox = Some(transfer_id);
        self.open_dialog(Dialog::Image, cx);
    }

    pub(crate) fn insert_emoji(&mut self, emoji: &str, window: &mut Window, cx: &mut Context<'_, Self>) {
        let text = format!("{}{emoji}", self.message.read(cx).value());
        self.message.update(cx, |i, cx| i.set_value(text, window, cx));
    }
}

/// A picture or file on its way (`.chat-image-transfer-card`).
fn transfer_card(name: &str, size: u64, percent: u8, sending: bool) -> impl IntoElement {
    let icon = if name.rsplit('.').next().is_some_and(|ext| {
        matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
        )
    }) {
        "🖼️"
    } else {
        "📁"
    };
    div()
        .w(px(240.))
        .p(px(10.))
        .rounded(px(12.))
        .bg(tokens::raised())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().text_size(px(18.)).child(icon))
                .child(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(name.to_owned()),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(format!(
                                    "{} • {percent}% ({})",
                                    if sending { "Sending" } else { "Receiving" },
                                    format_size(size)
                                )),
                        ),
                ),
        )
        .child(
            div().h(px(4.)).rounded_full().bg(tokens::line()).child(
                div()
                    .h_full()
                    .rounded_full()
                    .bg(tokens::focus())
                    .w(gpui_kit::relative((f32::from(percent.max(4))) / 100.0)),
            ),
        )
}

/// A chat line's picture: progress, then the thumbnail (click to open it).
pub(crate) fn picture_view(
    view: &RoomView,
    line: &ChatLine,
    mine: bool,
    cx: &mut Context<'_, RoomView>,
) -> Option<AnyElement> {
    let info = line.image.as_ref()?;
    let state = view.pictures.get(&info.transfer_id);
    let percent = state.map_or(0, |p| p.percent);
    let moving = state.is_none_or(|p| p.moving);
    let image = state.and_then(|p| p.image.clone());
    let mut col = div().flex().flex_col().gap(px(6.));
    if moving {
        col = col.child(transfer_card(&info.file_name, info.file_size, percent, mine));
    }
    if let Some(image) = image {
        let id = info.transfer_id.clone();
        col = col.child(
            div()
                .id(SharedString::from(format!("pic-{}", info.transfer_id)))
                .relative()
                .max_w(px(260.))
                .rounded(px(12.))
                .overflow_hidden()
                .border_1()
                .border_color(tokens::line())
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.open_lightbox(id.clone(), cx)))
                .child(
                    img(image)
                        .max_w(px(260.))
                        .max_h(px(260.))
                        .object_fit(ObjectFit::Contain),
                ),
        );
    } else if !moving {
        // arrived, but not a type we can draw (non-image or AVIF): offer it to save
        let id = info.transfer_id.clone();
        let icon = if info.file_name.rsplit('.').next().is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
            )
        }) {
            "🖼️"
        } else {
            "📁"
        };
        col = col.child(
            div()
                .id(SharedString::from(format!("pic-{}", info.transfer_id)))
                .px(px(12.))
                .py(px(8.))
                .rounded(px(12.))
                .bg(tokens::raised())
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.open_lightbox(id.clone(), cx)))
                .child(format!(
                    "{icon} {} ({})",
                    info.file_name,
                    format_size(info.file_size)
                )),
        );
    }
    Some(col.into_any_element())
}

/// The picture attached to the next message (`.chat-pending-image-card`).
pub(crate) fn pending_card(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<impl IntoElement> {
    let p = view.pending.as_ref()?;
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .p(px(8.))
            .mb(px(8.))
            .rounded(px(12.))
            .bg(tokens::surface())
            .border_1()
            .border_color(tokens::line())
            .child(
                div()
                    .size(px(48.))
                    .flex_none()
                    .rounded(px(8.))
                    .overflow_hidden()
                    .bg(tokens::raised())
                    .when_some(p.image.clone(), |el, i| {
                        el.child(img(i).size(px(48.)).object_fit(ObjectFit::Cover))
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(p.name.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::text_2())
                            .child(format_size(p.bytes.len() as u64)),
                    ),
            )
            .child(
                div()
                    .id("pending-cancel")
                    .size(px(28.))
                    .rounded(px(8.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(tokens::text_2())
                    .cursor_pointer()
                    .hover(|s| s.bg(tokens::raised()))
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.pending = None;
                        cx.notify();
                    }))
                    .child("✕"),
            ),
    )
}

/// The emoji window over the composer (`.chat-emoji-picker-window`).
pub(crate) fn emoji_picker(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let cats = crate::emoji::CATEGORIES;
    let searching = !view.emoji_search.read(cx).value().trim().is_empty();
    let tab = view.emoji_tab.min(cats.len() - 1);
    let shown: Vec<&'static str> = if searching {
        crate::emoji::all()
    } else {
        cats[tab].emojis.to_vec()
    };
    div()
        .id("emoji-picker")
        .mb(px(8.))
        .p(px(10.))
        .rounded(px(14.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .shadow(tokens::drop_shadow(10., 30., 0.5))
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(13.))
                        .font_weight(FontWeight::BOLD)
                        .child("Emojis"),
                )
                .child(div().flex_1().child(crate::emoji::tabs(
                    "emoji-tab",
                    if searching { usize::MAX } else { tab },
                    cx,
                    |v, t, window, cx| {
                        v.emoji_tab = t;
                        v.emoji_search.update(cx, |i, cx| i.set_value("", window, cx));
                        cx.notify();
                    },
                )))
                .child(
                    div()
                        .id("emoji-close")
                        .size(px(28.))
                        .rounded(px(8.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.emoji_open = false;
                            cx.notify();
                        }))
                        .child("✕"),
                ),
        )
        .child(
            div()
                .px(px(10.))
                .rounded(px(10.))
                .border_1()
                .border_color(tokens::line_strong())
                .bg(tokens::bg())
                .child(gpui_kit::component::input::Input::new(&view.emoji_search).appearance(false)),
        )
        .child(
            div()
                .id("emoji-grid")
                .max_h(px(180.))
                .overflow_y_scroll()
                .flex()
                .flex_wrap()
                .gap(px(2.))
                .children(shown.into_iter().enumerate().map(|(i, e)| {
                    div()
                        .id(SharedString::from(format!("emoji-{i}")))
                        .size(px(34.))
                        .rounded(px(8.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(20.))
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(move |v, _, window, cx| v.insert_emoji(e, window, cx)))
                        .child(e)
                })),
        )
}

/// Your quick reactions over the composer (`.chat-quick-reactions-dock`).
pub(crate) fn quick_reactions(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    div()
        .flex()
        .flex_wrap()
        .gap(px(4.))
        .mb(px(8.))
        .children(view.settings.quick_reactions.iter().enumerate().map(|(i, e)| {
            let emoji = e.clone();
            div()
                .id(SharedString::from(format!("quick-react-{i}")))
                .h(px(32.))
                .px(px(8.))
                .rounded(px(10.))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(18.))
                .bg(tokens::surface())
                .border_1()
                .border_color(tokens::line())
                .cursor_pointer()
                .hover(|s| s.bg(tokens::raised()))
                .on_click(cx.listener(move |v, _, _, _| v.react(&emoji)))
                .child(e.clone())
        }))
        .child(
            div()
                .id("quick-react-edit")
                .size(px(32.))
                .rounded(px(10.))
                .flex()
                .items_center()
                .justify_center()
                .bg(tokens::surface())
                .border_1()
                .border_color(tokens::line())
                .cursor_pointer()
                .hover(|s| s.bg(tokens::raised()))
                .on_click(cx.listener(|v, _, _, cx| v.open_dialog(Dialog::Reactions, cx)))
                .child(icon(Icon::Settings, px(14.), tokens::text_2())),
        )
}

/// The lightbox (`ImageLightboxModal.tsx`): the picture big, who sent it, Save.
pub(crate) fn lightbox(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let Some(id) = view.lightbox.clone() else {
        return div().into_any_element();
    };
    let line = view
        .chat
        .iter()
        .find(|l| l.image.as_ref().is_some_and(|i| i.transfer_id == id));
    let image = view.pictures.get(&id).and_then(|p| p.image.clone());
    let (name, size, sender, caption) = line.map_or_else(Default::default, |l| {
        let i = l.image.as_ref();
        (
            i.map(|i| i.file_name.clone()).unwrap_or_default(),
            i.map_or(0, |i| i.file_size),
            l.name.clone(),
            l.text.clone(),
        )
    });
    let save_id = id.clone();
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(16.))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(15.))
                                .font_weight(FontWeight::BOLD)
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(name),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(format!("{sender} · {}", format_size(size))),
                        ),
                )
                .child(
                    Button::new("lightbox-save", "Save")
                        .variant(Variant::Primary)
                        .min_height(px(34.))
                        .on_click(cx.listener(move |v, _, _, cx| v.save_picture(&save_id, cx))),
                )
                .child(
                    div()
                        .id("lightbox-close")
                        .size(px(34.))
                        .rounded(px(9.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_color(tokens::text_2())
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx)))
                        .child("✕"),
                ),
        )
        .child(
            div()
                .flex()
                .justify_center()
                .rounded(px(12.))
                .bg(Hsla {
                    a: 1.0,
                    ..tokens::bg()
                })
                .when_some(image, |el, i| {
                    el.child(
                        img(i)
                            .max_w(px(860.))
                            .max_h(px(600.))
                            .object_fit(ObjectFit::Contain),
                    )
                }),
        )
        .when(!caption.is_empty(), |el| {
            el.child(
                div()
                    .text_size(px(14.))
                    .text_color(tokens::text_2())
                    .child(caption),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::sniff;

    #[test]
    fn picture_types_from_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF1234WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff(b"%PDF-1.7"), None);
    }
}
