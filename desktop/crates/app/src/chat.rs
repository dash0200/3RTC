//! Chat pictures and the composer's extras (`LiveChat.tsx`, `features/chat/useChat.ts`): attach,
//! paste or drop a picture, its progress either way, the lightbox, the emoji picker and the
//! quick reactions row; rich chat text (`features/chat/RichText.tsx`): formatting, links,
//! @mentions and replies.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::{
    AnyElement, Context, ExternalPaths, FontStyle, FontWeight, HighlightStyle, Hsla, ImageSource,
    InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, PathPromptOptions, RenderImage,
    SharedString, StatefulInteractiveElement as _, StrikethroughStyle, Styled as _, StyledImage as _,
    StyledText, UnderlineStyle, Window, div, img, prelude::FluentBuilder as _, px,
};
use rtc_core::Quote;
use rtc_core::chat_format::{MentionTarget, format_chat};
use rtc_core::transfers::{SendStatus, needs_accept};
use rtc_engine::{ChatLine, FileHere, OutgoingFolder, OutgoingImage, Snapshot};
use rtc_protocol::image::{MAX_SEND_BYTES, format_size, mime_for_name};
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::view::{Dialog, RoomView};

/// A chat picture: how far along, and the picture once it's here.
#[derive(Default)]
pub(crate) struct Picture {
    pub(crate) percent: u8,
    /// The bubble's small preview (`chat_pictures::PREVIEW_MAX`), on the GPU while shown.
    pub(crate) preview: Option<Arc<RenderImage>>,
    /// Where its bytes are: our cache (`chat_pictures`) or the file it was picked from.
    pub(crate) file: Option<PathBuf>,
    /// It's all here (received whole, or ours).
    pub(crate) here: bool,
    /// Its preview is being made.
    pub(crate) decoding: bool,
    /// Still on its way (in or out).
    pub(crate) moving: bool,
    /// Received over QUIC and saved here (ADR 0009): the card opens its folder.
    pub(crate) saved: Option<PathBuf>,
    /// Cancelled (by us, by its sender, or nobody was receiving it): the card says so.
    pub(crate) cancelled: bool,
    /// Theirs, offered: it comes only once we accept it (big files, a folder's files).
    pub(crate) offered: bool,
    /// Ours, offered: where it is with the receivers (waiting to accept, being sent, sent).
    pub(crate) send: Option<SendStatus>,
    /// A folder's file partly in Downloads already (accepting resumes it).
    pub(crate) partly: bool,
}

/// A picture attached to the next message.
pub(crate) struct Pending {
    pub(crate) name: String,
    pub(crate) mime: &'static str,
    pub(crate) bytes: Arc<[u8]>,
    /// A small preview of a picture.
    pub(crate) preview: Option<Arc<RenderImage>>,
    /// Where it is on disk (a picked file), so big files can go over QUIC.
    pub(crate) path: Option<PathBuf>,
    /// Its size (the bytes may be left on disk).
    pub(crate) size: u64,
    /// A big file left on disk (not in `bytes`): sent from there, read as it goes.
    pub(crate) on_disk: bool,
    /// A folder: its files, sent one after the other.
    pub(crate) folder: Option<Vec<FolderFile>>,
}

/// One file of a folder being sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FolderFile {
    /// Where it is.
    pub(crate) path: PathBuf,
    /// Its path inside the folder, the folder's name first (`Photos/2026/a.jpg`).
    pub(crate) relative: String,
    /// Its size.
    pub(crate) size: u64,
}

/// Most files a folder may have to be sent.
pub(crate) const FOLDER_MAX_FILES: usize = 500;

/// A folder's files (in its subfolders too, links not followed), in order, with their sizes.
/// An error when there are none, too many, or more than the send limit in all.
pub(crate) fn folder_files(root: &Path) -> Result<Vec<FolderFile>, String> {
    let top = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "folder".to_owned());
    let mut out = Vec::new();
    let mut total: u64 = 0;
    let mut stack = vec![(root.to_owned(), top)];
    while let Some((dir, rel)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .map_err(|e| format!("Couldn't open {rel}: {e}"))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries.into_iter().rev() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = format!("{rel}/{name}");
            if kind.is_dir() {
                stack.push((entry.path(), child));
            } else if kind.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total = total.saturating_add(size);
                out.push(FolderFile {
                    path: entry.path(),
                    relative: child,
                    size,
                });
                if out.len() > FOLDER_MAX_FILES {
                    return Err(format!("That folder has more than {FOLDER_MAX_FILES} files"));
                }
            }
        }
    }
    if out.is_empty() {
        return Err("That folder has no files".to_owned());
    }
    if total > MAX_SEND_BYTES as u64 {
        return Err("That folder is over 10 GB".to_owned());
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
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

/// A picture's small preview for the bubble (`None` for other files).
fn preview(mime: &str, bytes: &[u8]) -> Option<Arc<RenderImage>> {
    if !mime.starts_with("image/") {
        return None;
    }
    crate::chat_pictures::decode_scaled(bytes, crate::chat_pictures::PREVIEW_MAX)
}

/// Frees a chat picture that's gone (its line scrolled away, or we left): its preview off the
/// GPU, its cache file deleted (never the user's own file).
pub(crate) fn free_picture(p: Picture, cx: &mut gpui_kit::App) {
    if let Some(preview) = p.preview {
        cx.drop_image(preview, None);
    }
    if let Some(file) = p.file
        && crate::chat_pictures::is_cached(&file)
    {
        let _ = std::fs::remove_file(file);
    }
}

/// Where the save dialog for a chat picture starts: `Downloads\3RTC\Pictures` (made if missing).
fn pictures_dir() -> PathBuf {
    let dir = rtc_core::saves::dir(rtc_core::saves::Kind::Pictures);
    let _ = std::fs::create_dir_all(&dir);
    dir
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

    /// The folder button: pick a folder to send.
    pub(crate) fn attach_folder_clicked(&mut self, cx: &mut Context<'_, Self>) {
        let pick = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Send a folder".into()),
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

    /// A folder picked or dropped: attach all its files.
    fn attach_folder(&mut self, path: &Path, cx: &mut Context<'_, Self>) {
        match folder_files(path) {
            Ok(files) => {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "folder".to_owned());
                let size = files.iter().map(|f| f.size).sum();
                let count = files.len();
                self.set_pending(
                    Pending {
                        name: format!("{name} · {count} file{}", if count == 1 { "" } else { "s" }),
                        mime: "application/octet-stream",
                        bytes: Arc::from(Vec::new()),
                        preview: None,
                        path: Some(path.to_owned()),
                        size,
                        on_disk: true,
                        folder: Some(files),
                    },
                    cx,
                );
            }
            Err(e) => self.show_toast(e, cx),
        }
    }

    fn set_pending(&mut self, pending: Pending, cx: &mut Context<'_, Self>) {
        self.clear_pending(cx);
        self.pending = Some(pending);
        if self.tab != crate::view::Tab::Chat {
            self.set_tab(crate::view::Tab::Chat, cx);
        }
        cx.notify();
    }

    /// A file picked or dropped: attach it (a folder: all its files).
    pub(crate) fn attach_file(&mut self, path: &Path, cx: &mut Context<'_, Self>) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Ok(meta) = std::fs::metadata(path) else { return };
        if meta.is_dir() {
            return self.attach_folder(path, cx);
        }
        if meta.len() > MAX_SEND_BYTES as u64 {
            self.show_toast("File exceeds 10 GB limit. Please select a smaller file.", cx);
            return;
        }
        // a big file (not a picture) stays on disk: it's read as it's sent
        if meta.len() >= rtc_core::quic::QUIC_MIN_BYTES && mime_for_name(&name).is_none() {
            return self.set_pending(
                Pending {
                    name,
                    mime: "application/octet-stream",
                    bytes: Arc::from(Vec::new()),
                    preview: None,
                    path: Some(path.to_owned()),
                    size: meta.len(),
                    on_disk: true,
                    folder: None,
                },
                cx,
            );
        }
        match std::fs::read(path) {
            Ok(bytes) => self.attach(name, bytes, Some(path.to_owned()), cx),
            Err(e) => self.show_toast(format!("Couldn't open {name}: {e}"), cx),
        }
    }

    /// Bytes of a file or picture to send with the next message.
    pub(crate) fn attach(
        &mut self,
        name: String,
        bytes: Vec<u8>,
        path: Option<PathBuf>,
        cx: &mut Context<'_, Self>,
    ) {
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
        let preview = preview(mime, &bytes);
        let size = bytes.len() as u64;
        self.set_pending(
            Pending {
                name,
                mime,
                bytes: bytes.into(),
                preview,
                path,
                size,
                on_disk: false,
                folder: None,
            },
            cx,
        );
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
                    self.attach(String::new(), i.bytes.clone(), None, cx);
                    return true;
                }
                gpui_kit::ClipboardEntry::ExternalPaths(p) => {
                    if let Some(path) = p.paths().first() {
                        self.attach_file(path, cx);
                        return true;
                    }
                }
                gpui_kit::ClipboardEntry::String(_) => {}
            }
        }
        false
    }

    /// Files dropped on the chat or window: attached to send.
    pub(crate) fn dropped(&mut self, paths: &ExternalPaths, cx: &mut Context<'_, Self>) {
        if self.in_room().is_none() {
            return;
        }
        if let Some(p) = paths.paths().first() {
            self.attach_file(p, cx);
        }
    }

    /// Sends the attached picture, file or folder with `caption`.
    pub(crate) fn send_picture(&mut self, caption: String, cx: &mut Context<'_, Self>) {
        let Some(p) = self.pending.take() else { return };
        let new_transfer = || format!("{:016x}{:016x}", rand::random::<u64>(), rand::random::<u64>());
        if let Some(files) = p.folder {
            // offered as a list: each receiver picks the files they want (`folder.rs`)
            let name = p
                .path
                .as_ref()
                .and_then(|d| d.file_name())
                .map_or_else(|| "folder".to_owned(), |n| n.to_string_lossy().into_owned());
            let mut out = Vec::new();
            for f in files {
                let transfer_id = new_transfer();
                self.pictures.insert(
                    transfer_id.clone(),
                    Picture {
                        saved: Some(f.path.clone()),
                        ..Picture::default()
                    },
                );
                let file_name = f
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push(OutgoingImage {
                    id: transfer_id.clone(),
                    transfer_id,
                    mime: mime_for_name(&file_name)
                        .unwrap_or("application/octet-stream")
                        .to_owned(),
                    file_name,
                    bytes: Arc::from(Vec::new()),
                    caption: String::new(),
                    path: Some(f.path),
                    disk_size: Some(f.size),
                    relative_path: Some(f.relative),
                });
            }
            let folder = OutgoingFolder {
                id: rtc_engine::Handle::new_message_id(),
                folder_id: new_transfer(),
                name,
                caption,
                files: out,
            };
            if let Some(e) = &self.engine {
                e.send_folder(folder);
            }
            cx.notify();
            return;
        }
        let transfer_id = new_transfer();
        // its bytes for Save: the file it was picked from, else (a paste) our cache
        let file = match (&p.path, p.on_disk) {
            (_, true) => None,
            (Some(path), false) => Some(path.clone()),
            (None, false) => {
                let path = crate::chat_pictures::cache_path(&transfer_id, p.mime);
                let (to, bytes) = (path.clone(), Arc::clone(&p.bytes));
                cx.background_executor()
                    .spawn(async move {
                        let _ = crate::chat_pictures::store(&to, &bytes);
                    })
                    .detach();
                Some(path)
            }
        };
        self.pictures.insert(
            transfer_id.clone(),
            Picture {
                percent: 0,
                preview: p.preview,
                file,
                here: true,
                moving: true,
                // a file sent from disk: its card shows it in its folder
                saved: if p.on_disk { p.path.clone() } else { None },
                ..Picture::default()
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
                disk_size: p.on_disk.then_some(p.size),
                path: p.path,
                relative_path: None,
            });
        }
        cx.notify();
    }

    /// A chat line arrived (or went): pictures start their progress; the web app's sounds.
    pub(crate) fn chat_line_sounds(&mut self, line: &ChatLine) {
        let mine = self.room.as_ref().is_some_and(|r| r.me == line.from);
        if let Some(folder) = &line.folder {
            // every file waits to be picked in the folder window (ours: until someone does)
            for f in &folder.files {
                let p = self.pictures.entry(f.transfer_id.clone()).or_default();
                p.offered = !mine;
                self.folder_files.insert(f.transfer_id.clone());
            }
            if mine {
                self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
            } else {
                self.ui_sound(&crate::sounds::CHIME, crate::sounds::CHIME_WAV.as_slice());
            }
            return;
        }
        match &line.image {
            Some(i) => {
                let p = self.pictures.entry(i.transfer_id.clone()).or_default();
                if !mine {
                    // a big file waits for us to accept it
                    if needs_accept(i.file_size) {
                        p.offered = true;
                    } else {
                        p.moving = true;
                    }
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
        if p.cancelled {
            return;
        }
        p.percent = percent;
        // ours (the bytes, or a file sent from disk) is done; theirs waits for the last frame;
        // ours offered is done when nobody waits for or gets it any more (`send_state`)
        if percent >= 100 && p.send.is_none() && (p.here || p.saved.is_some()) {
            p.moving = false;
        }
    }

    /// A file arrived over QUIC and is saved in `Downloads\3RTC\Files` (ADR 0009).
    pub(crate) fn file_saved(&mut self, transfer_id: String, path: PathBuf, cx: &mut Context<'_, Self>) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // a folder's files: shown in the folder window, not one toast each
        let quiet = self.folder_files.contains(&transfer_id);
        let p = self.pictures.entry(transfer_id).or_default();
        p.percent = 100;
        p.moving = false;
        p.cancelled = false;
        p.offered = false;
        p.partly = false;
        p.saved = Some(path);
        if quiet {
            return;
        }
        self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
        self.show_toast(format!("Saved {name} in Downloads\\3RTC\\Files"), cx);
    }

    /// Accept (a big file's card, or a folder's file): its sender starts sending it to us.
    pub(crate) fn accept_transfer(&mut self, transfer_id: &str) {
        let Some(p) = self.pictures.get_mut(transfer_id) else {
            return;
        };
        if !p.offered {
            return;
        }
        p.offered = false;
        p.moving = true;
        p.percent = 0;
        if let Some(e) = &self.engine {
            e.accept_transfer(transfer_id.to_owned());
        }
    }

    /// Where our offered file is with its receivers.
    pub(crate) fn send_state(&mut self, transfer_id: &str, status: SendStatus) {
        let p = self.pictures.entry(transfer_id.to_owned()).or_default();
        if p.cancelled {
            return;
        }
        p.send = Some(status);
        p.moving = status.waiting > 0 || status.sending > 0;
        if status.sending == 0 {
            p.percent = 0;
        }
    }

    /// Files of a folder offered to us that are in Downloads already.
    pub(crate) fn folder_here(&mut self, files: Vec<(String, FileHere)>) {
        for (tid, here) in files {
            let p = self.pictures.entry(tid).or_default();
            match here {
                FileHere::Whole(path) => p.saved = Some(path),
                FileHere::Partly => p.partly = true,
            }
        }
    }

    /// The card's Cancel: our file stops going to everyone (the rest of a folder too); one
    /// coming in stops coming (`cancelTransfer` in `useChat.ts`).
    pub(crate) fn cancel_transfer(&mut self, transfer_id: String, cx: &mut Context<'_, Self>) {
        self.transfer_cancelled(&transfer_id);
        if let Some(e) = &self.engine {
            e.cancel_transfer(transfer_id);
        }
        cx.notify();
    }

    /// A chat file (or folder) was cancelled (here, by its sender, or nobody was receiving it).
    pub(crate) fn transfer_cancelled(&mut self, transfer_id: &str) {
        let p = self.pictures.entry(transfer_id.to_owned()).or_default();
        if !p.moving && (p.here || p.saved.is_some()) {
            // it got here (or went) whole before the cancel did
            return;
        }
        p.moving = false;
        p.offered = false;
        p.cancelled = true;
    }

    /// A picture (or small file) arrived whole: its bytes go to our cache file and a small
    /// preview is made, off the UI thread; nothing big stays in memory.
    pub(crate) fn picture_ready(&mut self, transfer_id: &str, bytes: Arc<[u8]>, cx: &mut Context<'_, Self>) {
        let mime = self
            .chat
            .iter()
            .rev()
            .find_map(|l| l.image.as_ref().filter(|i| i.transfer_id == transfer_id))
            .map_or("application/octet-stream", |i| i.mime.as_str())
            .to_owned();
        let p = self.pictures.entry(transfer_id.to_owned()).or_default();
        p.here = true;
        p.decoding = true;
        p.percent = 100;
        p.moving = false;
        self.ui_sound(&crate::sounds::POP, crate::sounds::POP_WAV.as_slice());
        let path = crate::chat_pictures::cache_path(transfer_id, &mime);
        let work = cx.background_executor().spawn(async move {
            let file = crate::chat_pictures::store(&path, &bytes).ok().map(|()| path);
            (file, preview(&mime, &bytes))
        });
        let id = transfer_id.to_owned();
        cx.spawn(async move |this, cx| {
            let (file, made) = work.await;
            let _ = this.update(cx, |v, cx| {
                if let Some(p) = v.pictures.get_mut(&id) {
                    p.file = file;
                    p.preview = made;
                    p.decoding = false;
                } else {
                    // its line went meanwhile
                    free_picture(
                        Picture {
                            file,
                            preview: made,
                            ..Picture::default()
                        },
                        cx,
                    );
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Saves the lightbox's picture where the user picks (`Downloads\3RTC\Pictures` first).
    pub(crate) fn save_picture(&mut self, transfer_id: &str, cx: &mut Context<'_, Self>) {
        let Some(line) = self
            .chat
            .iter()
            .find(|l| l.image.as_ref().is_some_and(|i| i.transfer_id == transfer_id))
        else {
            return;
        };
        let Some(image) = &line.image else { return };
        // already saved (it came over QUIC): show it in its folder
        if let Some(path) = self.pictures.get(transfer_id).and_then(|p| p.saved.clone()) {
            cx.reveal_path(&path);
            return;
        }
        let Some(from) = self.pictures.get(transfer_id).and_then(|p| p.file.clone()) else {
            return;
        };
        let name = rtc_protocol::image::safe_file_save_name(&image.file_name, &image.mime);
        let ask = cx.prompt_for_new_path(&pictures_dir(), Some(&name));
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(path))) = ask.await {
                let said = match std::fs::copy(&from, &path) {
                    Ok(_) => format!("Saved {}", path.display()),
                    Err(e) => format!("Couldn't save the file: {e}"),
                };
                let _ = this.update(cx, |v, cx| v.show_toast(said, cx));
            }
        })
        .detach();
    }

    /// Opens the lightbox: a screen-sized copy is decoded from the picture's file while it's
    /// open (the bubble's preview shows meanwhile) and freed when it closes.
    pub(crate) fn open_lightbox(&mut self, transfer_id: String, cx: &mut Context<'_, Self>) {
        self.free_lightbox(cx);
        let file = self
            .pictures
            .get(&transfer_id)
            .and_then(|p| p.file.clone().or_else(|| p.saved.clone()));
        self.lightbox = Some(transfer_id.clone());
        self.open_dialog(Dialog::Image, cx);
        let Some(file) = file else { return };
        let work = cx.background_executor().spawn(async move {
            let bytes = std::fs::read(file).ok()?;
            crate::chat_pictures::decode_scaled(&bytes, crate::chat_pictures::LIGHTBOX_MAX)
        });
        cx.spawn(async move |this, cx| {
            let made = work.await;
            let _ = this.update(cx, |v, cx| match made {
                // still open on this picture
                Some(big)
                    if v.lightbox.as_deref() == Some(transfer_id.as_str())
                        && v.dialog == Some(Dialog::Image) =>
                {
                    v.lightbox_image = Some(big);
                    cx.notify();
                }
                Some(big) => cx.drop_image(big, None),
                None => {}
            });
        })
        .detach();
    }

    /// The lightbox's big copy off the GPU (it closed, or shows another picture).
    pub(crate) fn free_lightbox(&mut self, cx: &mut gpui_kit::App) {
        if let Some(big) = self.lightbox_image.take() {
            cx.drop_image(big, None);
        }
    }

    /// Drops the attachment waiting to be sent (its preview off the GPU).
    pub(crate) fn clear_pending(&mut self, cx: &mut gpui_kit::App) {
        if let Some(p) = self.pending.take()
            && let Some(preview) = p.preview
        {
            cx.drop_image(preview, None);
        }
    }

    pub(crate) fn insert_emoji(&mut self, emoji: &str, window: &mut Window, cx: &mut Context<'_, Self>) {
        let text = format!("{}{emoji}", self.message.read(cx).value());
        self.message.update(cx, |i, cx| i.set_value(text, window, cx));
    }
}

/// A picture or file on its way, offered, or cancelled (`.chat-image-transfer-card`): its
/// name, `status`, a progress bar (`percent`) and buttons (`actions`).
fn transfer_card(
    name: &str,
    status: String,
    percent: Option<u8>,
    actions: Option<AnyElement>,
) -> impl IntoElement {
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
                .w_full()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(div().flex_none().text_size(px(18.)).child(icon))
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
                                .child(name.to_owned()),
                        )
                        .child(
                            div()
                                .text_size(px(12.))
                                .text_color(tokens::text_2())
                                .child(status),
                        ),
                ),
        )
        .children(percent.map(|percent| {
            div().h(px(4.)).rounded_full().bg(tokens::line()).child(
                div()
                    .h_full()
                    .rounded_full()
                    .bg(tokens::focus())
                    .w(gpui_kit::relative((f32::from(percent.max(4))) / 100.0)),
            )
        }))
        .children(actions)
}

/// "1 person", "3 people".
pub(crate) fn people(n: usize) -> String {
    if n == 1 {
        "1 person".to_owned()
    } else {
        format!("{n} people")
    }
}

/// A small button on a file card (`.transfer-action-btn`); `primary`: the accent one.
pub(crate) fn small_button(
    id: String,
    label: &'static str,
    primary: bool,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> AnyElement {
    let el = div()
        .id(SharedString::from(id))
        .flex_none()
        .px(px(10.))
        .py(px(4.))
        .rounded(px(8.))
        .border_1()
        .text_size(px(12.))
        .cursor_pointer()
        .on_click(on_click)
        .child(label);
    if primary {
        el.bg(tokens::accent())
            .border_color(tokens::accent())
            .text_color(tokens::text())
            .font_weight(FontWeight::SEMIBOLD)
            .hover(|s| s.bg(tokens::accent_press()))
            .into_any_element()
    } else {
        el.border_color(tokens::line())
            .text_color(tokens::text_2())
            .hover(|s| s.bg(tokens::danger_bg()).text_color(tokens::danger_text()))
            .into_any_element()
    }
}

/// The Cancel under a file on its way: for the sender and the receivers alike.
fn cancel_button(transfer_id: &str, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let id = transfer_id.to_owned();
    div()
        .flex()
        .justify_end()
        .child(small_button(
            format!("cancel-{transfer_id}"),
            "✕ Cancel",
            false,
            cx.listener(move |v, _, _, cx| v.cancel_transfer(id.clone(), cx)),
        ))
        .into_any_element()
}

/// Accept and Decline under a big file offered to us.
fn offer_buttons(transfer_id: &str, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let accept = transfer_id.to_owned();
    let decline = transfer_id.to_owned();
    div()
        .flex()
        .justify_end()
        .gap(px(8.))
        .child(small_button(
            format!("decline-{transfer_id}"),
            "Decline",
            false,
            cx.listener(move |v, _, _, cx| v.cancel_transfer(decline.clone(), cx)),
        ))
        .child(small_button(
            format!("accept-{transfer_id}"),
            "⬇ Accept",
            true,
            cx.listener(move |v, _, _, cx| {
                v.accept_transfer(&accept);
                cx.notify();
            }),
        ))
        .into_any_element()
}

/// A chat line's picture: progress, then the thumbnail (click to open it).
pub(crate) fn picture_view(
    view: &RoomView,
    line: &ChatLine,
    mine: bool,
    cx: &mut Context<'_, RoomView>,
) -> Option<AnyElement> {
    if let Some(folder) = &line.folder {
        return Some(crate::folder::card(view, folder, mine, cx));
    }
    let info = line.image.as_ref()?;
    let state = view.pictures.get(&info.transfer_id);
    let percent = state.map_or(0, |p| p.percent);
    let cancelled = state.is_some_and(|p| p.cancelled);
    let offered = !mine && !cancelled && state.is_some_and(|p| p.offered);
    let moving = !cancelled && !offered && state.is_none_or(|p| p.moving);
    let image = state.and_then(|p| p.preview.clone());
    let decoding = state.is_some_and(|p| p.decoding);
    let size = format_size(info.file_size);
    let mut col = div().flex().flex_col().gap(px(6.)).w(px(240.));
    if cancelled {
        col = col.child(transfer_card(
            &info.file_name,
            format!("✕ Cancelled ({size})"),
            None,
            None,
        ));
    } else if offered {
        col = col.child(transfer_card(
            &info.file_name,
            format!("{size} • accept to download"),
            None,
            Some(offer_buttons(&info.transfer_id, cx)),
        ));
    } else if moving {
        let send = if mine { state.and_then(|p| p.send) } else { None };
        let (status, bar) = match send {
            Some(s) if s.sending == 0 => (
                format!("Waiting for {} to accept ({size})", people(s.waiting)),
                None,
            ),
            Some(s) => {
                let waiting = if s.waiting > 0 {
                    format!(", {} waiting", s.waiting)
                } else {
                    String::new()
                };
                (
                    format!("Sending to {} • {percent}%{waiting} ({size})", people(s.sending)),
                    Some(percent),
                )
            }
            None => (
                format!(
                    "{} • {percent}% ({size})",
                    if mine { "Sending" } else { "Receiving" }
                ),
                Some(percent),
            ),
        };
        col = col.child(transfer_card(
            &info.file_name,
            status,
            bar,
            Some(cancel_button(&info.transfer_id, cx)),
        ));
    }
    if let Some(image) = image {
        let id = info.transfer_id.clone();
        col = col.child(
            div()
                .id(SharedString::from(format!("pic-{}", info.transfer_id)))
                .relative()
                .max_w(px(240.))
                .rounded(px(12.))
                .overflow_hidden()
                .border_1()
                .border_color(tokens::line())
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.open_lightbox(id.clone(), cx)))
                .child(
                    img(ImageSource::from(image))
                        .max_w(px(240.))
                        .max_h(px(240.))
                        .object_fit(ObjectFit::Contain),
                ),
        );
    } else if !moving && !cancelled && !offered && !decoding {
        // arrived, but not a type we can draw (non-image or AVIF): offer it to save
        let id = info.transfer_id.clone();
        let save_id = id.clone();
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
                .w(px(240.))
                .px(px(12.))
                .py(px(8.))
                .rounded(px(12.))
                .bg(tokens::surface())
                .hover(|s| s.bg(tokens::raised()))
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.))
                .cursor_pointer()
                .on_click(cx.listener(move |v, _, _, cx| v.save_picture(&save_id, cx)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(div().flex_none().text_size(px(18.)).child(icon))
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
                                        .child(info.file_name.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(tokens::text_2())
                                        .child(format_size(info.file_size)),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .bg(tokens::panel())
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(tokens::text())
                        .child(if state.is_some_and(|p| p.saved.is_some()) {
                            "Show"
                        } else {
                            "Save"
                        }),
                ),
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
                    .map(|el| {
                        if let Some(i) = p.preview.clone() {
                            el.child(
                                img(ImageSource::from(i))
                                    .size(px(48.))
                                    .object_fit(ObjectFit::Cover),
                            )
                            .into_any_element()
                        } else {
                            el.flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(22.))
                                .child(if p.folder.is_some() { "📁" } else { "📄" })
                                .into_any_element()
                        }
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
                            .child(format_size(p.size)),
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
                        v.clear_pending(cx);
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
    // the big copy once decoded, the bubble's preview until then
    let image = view
        .lightbox_image
        .clone()
        .or_else(|| view.pictures.get(&id).and_then(|p| p.preview.clone()));
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
                        img(ImageSource::from(i))
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

/// Who can be @mentioned in this room (and us), for drawing mentions.
pub(crate) fn mention_targets(room: &Snapshot) -> Vec<MentionTarget> {
    let mut targets: Vec<MentionTarget> = room
        .members
        .iter()
        .filter_map(|(id, m)| {
            Some(MentionTarget {
                peer_id: id.as_str().to_owned(),
                name: m.username.clone()?,
                is_self: false,
            })
        })
        .collect();
    targets.push(MentionTarget {
        peer_id: room.me.as_str().to_owned(),
        name: room.username.clone(),
        is_self: true,
    });
    targets
}

/// A message's text with its formatting: bold, italic, struck, `code`, @mentions, and links that
/// open in the browser (`rtc_core::chat_format`).
pub(crate) fn rich_text(id: SharedString, text: &str, targets: &[MentionTarget]) -> AnyElement {
    let mut shown = String::new();
    let mut highlights: Vec<(std::ops::Range<usize>, HighlightStyle)> = Vec::new();
    let mut links: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for piece in format_chat(text, targets) {
        let start = shown.len();
        shown.push_str(&piece.text);
        let range = start..shown.len();
        if range.is_empty() {
            continue;
        }
        let mut style = HighlightStyle::default();
        if piece.bold || piece.mention.is_some() {
            style.font_weight = Some(FontWeight::BOLD);
        }
        if piece.italic {
            style.font_style = Some(FontStyle::Italic);
        }
        if piece.strike {
            style.strikethrough = Some(StrikethroughStyle {
                thickness: px(1.),
                color: None,
            });
        }
        if piece.code {
            style.background_color = Some(tokens::surface());
        }
        if piece.mention.is_some() {
            style.color = Some(tokens::focus());
            if piece.mentions_self {
                style.background_color = Some(tokens::focus().opacity(0.25));
            }
        }
        if let Some(href) = piece.link {
            style.color = Some(tokens::focus());
            style.underline = Some(UnderlineStyle {
                thickness: px(1.),
                color: None,
                wavy: false,
            });
            links.push((range.clone(), href));
        }
        if style != HighlightStyle::default() {
            highlights.push((range, style));
        }
    }
    // selectable (drag, then Ctrl+C); links still open on a click
    let shown = SharedString::from(shown);
    let styled = StyledText::new(shown.clone()).with_highlights(highlights);
    crate::selectable::SelectableRich::new(id, shown, styled, links).into_any_element()
}

/// The message a chat line replies to, above its bubble.
pub(crate) fn quote_view(q: &Quote) -> impl IntoElement {
    div()
        .max_w(px(260.))
        .px(px(10.))
        .py(px(4.))
        .rounded(px(6.))
        .border_l_2()
        .border_color(tokens::focus())
        .bg(tokens::raised().opacity(0.5))
        .flex()
        .flex_col()
        .gap(px(1.))
        .child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(tokens::focus())
                .child(if q.mine { "You".to_owned() } else { q.name.clone() }),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(tokens::text_2())
                .truncate()
                .child(if q.text.is_empty() {
                    "…".to_owned()
                } else {
                    q.text.clone()
                }),
        )
}

/// "Replying to …" above the composer, until sent or dismissed.
pub(crate) fn reply_bar(view: &RoomView, cx: &mut Context<'_, RoomView>) -> Option<impl IntoElement> {
    let q = view.reply_to.as_ref()?;
    Some(
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .mb(px(8.))
            .pl(px(12.))
            .pr(px(6.))
            .py(px(6.))
            .rounded(px(8.))
            .border_l_2()
            .border_color(tokens::focus())
            .bg(tokens::surface())
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(tokens::text_2())
                            .child(format!(
                                "Replying to {}",
                                if q.mine { "yourself" } else { q.name.as_str() }
                            )),
                    )
                    .child(div().text_size(px(13.)).truncate().child(q.text.clone())),
            )
            .child(
                div()
                    .id("reply-cancel")
                    .size(px(26.))
                    .rounded(px(6.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(tokens::raised()))
                    .text_color(tokens::text_2())
                    .on_click(cx.listener(|v, _, _, cx| {
                        v.reply_to = None;
                        cx.notify();
                    }))
                    .child("✕"),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::{folder_files, sniff};

    #[test]
    fn a_folder_lists_its_files_in_order_with_their_paths() {
        let root = std::env::temp_dir()
            .join(format!("3rtc-folder-{}", std::process::id()))
            .join("Photos");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("2026")).unwrap();
        std::fs::write(root.join("b.txt"), b"bb").unwrap();
        std::fs::write(root.join("a.jpg"), b"a").unwrap();
        std::fs::write(root.join("2026").join("c.png"), b"ccc").unwrap();
        let files = folder_files(&root).unwrap();
        let rel: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(rel, vec!["Photos/2026/c.png", "Photos/a.jpg", "Photos/b.txt"]);
        assert_eq!(files.iter().map(|f| f.size).sum::<u64>(), 6);
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(folder_files(&empty).is_err());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn picture_types_from_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF1234WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff(b"%PDF-1.7"), None);
    }
}
