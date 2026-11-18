//! A folder offered in chat (`p2p-folder-offer`): its card, and the window with its tree where
//! each file is downloaded on request (files already in Downloads say so). The engine sends
//! and saves them (`crates/engine/src/files.rs`).

use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
};
use rtc_core::ChatFolder;
use rtc_protocol::image::format_size;
use rtc_ui::tokens;

use crate::chat::{people, small_button};
use crate::view::{Dialog, RoomView};

/// Where one file of a folder is, as shown.
enum Shown {
    /// Theirs, not asked for.
    Offered {
        partly: bool,
    },
    /// Coming in (or, ours, going out).
    Moving(u8),
    /// Here (theirs), or sent to everyone who asked (ours).
    Done,
    Cancelled,
    /// Ours: being sent to how many, sent to how many.
    Ours {
        sending: usize,
        sent: usize,
    },
}

fn shown(view: &RoomView, transfer_id: &str, mine: bool) -> Shown {
    let Some(p) = view.pictures.get(transfer_id) else {
        return if mine {
            Shown::Ours { sending: 0, sent: 0 }
        } else {
            Shown::Offered { partly: false }
        };
    };
    if p.cancelled {
        return Shown::Cancelled;
    }
    if mine {
        return match p.send {
            Some(s) if s.sending > 0 => Shown::Moving(p.percent),
            Some(s) => Shown::Ours {
                sending: s.sending,
                sent: s.sent,
            },
            None => Shown::Ours { sending: 0, sent: 0 },
        };
    }
    if p.moving {
        Shown::Moving(p.percent)
    } else if p.saved.is_some() {
        Shown::Done
    } else if p.offered {
        Shown::Offered { partly: p.partly }
    } else {
        Shown::Cancelled
    }
}

impl RoomView {
    /// Opens a folder's window.
    pub(crate) fn open_folder(&mut self, folder_id: String, cx: &mut Context<'_, Self>) {
        self.folder_open = Some(folder_id);
        self.open_dialog(Dialog::Folder, cx);
    }

    /// Downloads every file of the open folder that isn't here yet.
    fn accept_all(&mut self, cx: &mut Context<'_, Self>) {
        let Some(id) = self.folder_open.clone() else {
            return;
        };
        let ids: Vec<String> = self
            .chat
            .iter()
            .filter_map(|l| l.folder.as_ref())
            .filter(|f| f.folder_id == id)
            .flat_map(|f| f.files.iter().map(|x| x.transfer_id.clone()))
            .collect();
        for tid in ids {
            let missing = self
                .pictures
                .get(&tid)
                .is_some_and(|p| p.offered && p.saved.is_none());
            if missing {
                self.accept_transfer(&tid);
            }
        }
        cx.notify();
    }
}

/// The folder's chat card: its name, how many files and how big, Open (and, ours, Cancel).
pub(crate) fn card(
    view: &RoomView,
    folder: &ChatFolder,
    mine: bool,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let total: u64 = folder.files.iter().map(|f| f.file_size).sum();
    let count = folder.files.len();
    let cancelled = view.pictures.get(&folder.folder_id).is_some_and(|p| p.cancelled);
    let (mut here, mut moving, mut sent) = (0usize, 0usize, 0usize);
    for f in &folder.files {
        match shown(view, &f.transfer_id, mine) {
            Shown::Done => here += 1,
            Shown::Moving(_) => moving += 1,
            Shown::Ours { sending, sent: s } => {
                moving += sending;
                if s > 0 {
                    sent += 1;
                }
            }
            _ => {}
        }
    }
    let status = if cancelled {
        "✕ Cancelled".to_owned()
    } else if mine {
        let mut s = "Offered: each person picks the files they want".to_owned();
        if moving > 0 {
            s = format!("Sending {moving} file{}", if moving == 1 { "" } else { "s" });
        }
        if sent > 0 {
            s = format!("{s} • {sent} sent");
        }
        s
    } else if moving > 0 {
        format!("Downloading {moving} • {here} of {count} here")
    } else if here > 0 {
        format!("{here} of {count} here")
    } else {
        "Pick the files you want".to_owned()
    };
    let open_id = folder.folder_id.clone();
    let cancel_id = folder.folder_id.clone();
    div()
        .w(px(260.))
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
                .child(div().flex_none().text_size(px(20.)).child("📁"))
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
                                .child(folder.name.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(format!(
                                    "{count} file{} • {}",
                                    if count == 1 { "" } else { "s" },
                                    format_size(total)
                                )),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(status),
                        ),
                ),
        )
        .when(!cancelled, |el| {
            el.child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .when(mine, |row| {
                        row.child(small_button(
                            format!("cancel-{cancel_id}"),
                            "✕ Cancel",
                            false,
                            cx.listener(move |v, _, _, cx| v.cancel_transfer(cancel_id.clone(), cx)),
                        ))
                    })
                    .child(small_button(
                        format!("open-{open_id}"),
                        if mine { "Show files" } else { "Open" },
                        !mine,
                        cx.listener(move |v, _, _, cx| v.open_folder(open_id.clone(), cx)),
                    )),
            )
        })
        .into_any_element()
}

/// The folder window: its tree, each file with its state and a Download button.
pub(crate) fn dialog(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let Some(id) = view.folder_open.clone() else {
        return div().into_any_element();
    };
    let Some(line) = view
        .chat
        .iter()
        .find(|l| l.folder.as_ref().is_some_and(|f| f.folder_id == id))
    else {
        return div().into_any_element();
    };
    let Some(folder) = line.folder.as_ref() else {
        return div().into_any_element();
    };
    let mine = view.room.as_ref().is_some_and(|r| r.me == line.from);
    let cancelled = view.pictures.get(&id).is_some_and(|p| p.cancelled);
    let missing = !mine
        && !cancelled
        && folder
            .files
            .iter()
            .any(|f| matches!(shown(view, &f.transfer_id, false), Shown::Offered { .. }));
    let total: u64 = folder.files.iter().map(|f| f.file_size).sum();

    // the tree: a row for each folder level as it starts, then its files, indented
    let mut rows: Vec<AnyElement> = Vec::new();
    let mut open_dirs: Vec<String> = Vec::new();
    for f in &folder.files {
        let parts: Vec<&str> = f.path.split('/').collect();
        let dirs = &parts[..parts.len().saturating_sub(1)];
        let same = open_dirs
            .iter()
            .zip(dirs)
            .take_while(|pair| pair.0.as_str() == *pair.1)
            .count();
        open_dirs.truncate(same);
        for (depth, dir) in dirs.iter().enumerate().skip(same) {
            open_dirs.push((*dir).to_owned());
            rows.push(dir_row(depth, dir));
        }
        rows.push(file_row(view, f, dirs.len(), mine, cancelled, cx));
    }

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
                .child(div().flex_none().text_size(px(22.)).child("📁"))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(16.))
                                .font_weight(FontWeight::BOLD)
                                .whitespace_nowrap()
                                .overflow_hidden()
                                .text_ellipsis()
                                .child(folder.name.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(format!(
                                    "{} • {} file{} • {}",
                                    if mine { "You".to_owned() } else { line.name.clone() },
                                    folder.files.len(),
                                    if folder.files.len() == 1 { "" } else { "s" },
                                    format_size(total)
                                )),
                        ),
                )
                .when(missing, |el| {
                    el.child(small_button(
                        "folder-all".to_owned(),
                        "⬇ Download all missing",
                        true,
                        cx.listener(|v, _, _, cx| v.accept_all(cx)),
                    ))
                })
                .child(
                    div()
                        .id("folder-close")
                        .size(px(32.))
                        .rounded(px(8.))
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
        .when(!mine, |el| {
            el.child(
                div()
                    .text_size(px(12.))
                    .text_color(tokens::text_3())
                    .child("Files go to Downloads, in the folder's layout."),
            )
        })
        .child(
            div()
                .id("folder-tree")
                .max_h(px(440.))
                .overflow_y_scroll()
                .flex()
                .flex_col()
                .gap(px(2.))
                .children(rows),
        )
        .into_any_element()
}

fn dir_row(depth: usize, name: &str) -> AnyElement {
    #[allow(clippy::cast_precision_loss)]
    let indent = px(8. + 18. * depth as f32);
    div()
        .pl(indent)
        .py(px(4.))
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(tokens::text_2())
        .child("📂")
        .child(name.to_owned())
        .into_any_element()
}

fn file_row(
    view: &RoomView,
    f: &rtc_core::ChatFolderFile,
    depth: usize,
    mine: bool,
    cancelled: bool,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    #[allow(clippy::cast_precision_loss)]
    let indent = px(8. + 18. * depth as f32);
    let state = if cancelled {
        Shown::Cancelled
    } else {
        shown(view, &f.transfer_id, mine)
    };
    let tid = f.transfer_id.clone();
    let right: AnyElement = match state {
        Shown::Offered { partly } => {
            let accept = tid.clone();
            small_button(
                format!("get-{tid}"),
                if partly { "⬇ Resume" } else { "⬇ Download" },
                false,
                cx.listener(move |v, _, _, cx| {
                    v.accept_transfer(&accept);
                    cx.notify();
                }),
            )
        }
        Shown::Moving(percent) => {
            let cancel = tid.clone();
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::focus())
                        .child(format!("{percent}%")),
                )
                .child(small_button(
                    format!("stop-{tid}"),
                    "✕",
                    false,
                    cx.listener(move |v, _, _, cx| v.cancel_transfer(cancel.clone(), cx)),
                ))
                .into_any_element()
        }
        Shown::Done => {
            let show = tid.clone();
            small_button(
                format!("show-{tid}"),
                "✓ Here",
                false,
                cx.listener(move |v, _, _, cx| {
                    if let Some(path) = v.pictures.get(&show).and_then(|p| p.saved.clone()) {
                        cx.reveal_path(&path);
                    }
                }),
            )
        }
        Shown::Cancelled => status_text("Cancelled"),
        Shown::Ours { sent, .. } => {
            if sent > 0 {
                status_text_owned(format!("Sent to {}", people(sent)))
            } else {
                status_text("Not asked for yet")
            }
        }
    };
    div()
        .pl(indent)
        .pr(px(4.))
        .py(px(4.))
        .rounded(px(6.))
        .hover(|s| s.bg(tokens::raised()))
        .flex()
        .items_center()
        .gap(px(8.))
        .child(div().flex_none().text_size(px(13.)).child("📄"))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(13.))
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(f.file_name.clone()),
        )
        .child(
            div()
                .flex_none()
                .text_size(px(12.))
                .text_color(tokens::text_3())
                .child(format_size(f.file_size)),
        )
        .child(div().flex_none().child(right))
        .into_any_element()
}

fn status_text(text: &'static str) -> AnyElement {
    status_text_owned(text.to_owned())
}

fn status_text_owned(text: String) -> AnyElement {
    div()
        .text_size(px(12.))
        .text_color(tokens::text_3())
        .child(SharedString::from(text))
        .into_any_element()
}
