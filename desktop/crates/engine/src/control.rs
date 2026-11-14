//! Remote control of a shared screen, desktop to desktop (`screen-control`, `screen-input`; the
//! web app neither sends nor reads them). See `docs/PROTOCOL.md`, "Remote control".
//!
//! The sharer decides every time: a desktop viewer asks and the sharer allows or says no, or the
//! sharer offers and the viewer takes it. One viewer controls at a time. The sharer's app plays
//! the viewer's mouse and keys back over the shared screen or window
//! ([`rtc_platform_win::RemoteControl`]: a banner, Ctrl+Alt+Shift+X or their own mouse takes
//! control back). Control ends when the sharer takes it back, the viewer lets go, either leaves,
//! or the share stops.

use rtc_platform_win::{ControlArea, Injection, MouseKey, RemoteControl, TakeBack};
use rtc_protocol::PeerId;
use rtc_protocol::stream::{ControlAction, InputKind, ScreenInput, ScreenMessage};

use crate::{Engine, Msg, ScreenSource, Update};

/// What the UI shows about remote control.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ControlView {
    /// Viewer: the screen we watch can be controlled from here (a desktop app shares it).
    pub can_ask: bool,
    /// Viewer: we asked and wait for an answer.
    pub asked: bool,
    /// Viewer: the sharer offers us control.
    pub offered: bool,
    /// Viewer: we control the shared screen.
    pub mine: bool,
    /// Who controls the shared screen now (ours or theirs), by name.
    pub controller: Option<String>,
    /// Sharer: viewers asking for control (id, name), oldest first.
    pub asks: Vec<(PeerId, String)>,
    /// Sharer: viewers on the desktop app (id, name, offered control now).
    pub viewers: Vec<(PeerId, String, bool)>,
}

/// What the UI can do about remote control.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlCmd {
    /// Viewer: ask the sharer for control.
    Ask,
    /// Viewer: never mind.
    Cancel,
    /// Viewer: take the control offered.
    Accept,
    /// Viewer: no thanks.
    Decline,
    /// Viewer: stop controlling.
    Release,
    /// Viewer, while in control: one mouse or key event.
    Input(ScreenInput),
    /// Sharer: let this viewer control (answers their request).
    Allow(PeerId),
    /// Sharer: say no to this viewer's request.
    Deny(PeerId),
    /// Sharer: offer control to this viewer.
    Offer(PeerId),
    /// Sharer: take control back (and withdraw offers).
    Revoke,
}

/// Why control ended (for the notices).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ended {
    /// The sharer's hotkey or mouse, or the Stop button.
    TakenBack(Option<TakeBack>),
    /// The viewer let go.
    Released,
    /// The viewer left.
    Left,
    /// The share stopped.
    Stopped,
}

/// Both sides' state.
#[derive(Debug, Default)]
pub(crate) struct Control {
    // ---- sharing ----
    /// Who controls our screen.
    controller: Option<(PeerId, String)>,
    /// Playing their input back.
    session: Option<RemoteControl>,
    /// Requests waiting for us.
    asks: Vec<(PeerId, String)>,
    /// Viewers we offered control to.
    offers: Vec<PeerId>,
    /// Inputs played back (for the log).
    played: u64,
    // ---- watching ----
    asked: bool,
    offered: bool,
    mine: bool,
    /// Who controls the screen we watch (`state` from the sharer).
    their_controller: Option<String>,
    /// What the UI was last told.
    told: Option<ControlView>,
}

fn area(s: &ScreenSource) -> ControlArea {
    if s.window {
        ControlArea::Window(s.id)
    } else {
        ControlArea::Screen(s.id)
    }
}

/// A viewer's event as one to play back (`None`: not one we play).
pub(crate) fn injection(i: &ScreenInput) -> Option<Injection> {
    let (x, y) = (i.x.clamp(0.0, 1.0), i.y.clamp(0.0, 1.0));
    if !i.x.is_finite() || !i.y.is_finite() {
        return None;
    }
    Some(match i.e {
        InputKind::Move => Injection::Move { x, y },
        InputKind::MoveDelta => Injection::MoveDelta {
            dx: i.dx.clamp(-10000, 10000),
            dy: i.dy.clamp(-10000, 10000),
        },
        InputKind::Button => Injection::Button {
            button: match i.button {
                0 => MouseKey::Left,
                1 => MouseKey::Middle,
                2 => MouseKey::Right,
                _ => return None,
            },
            down: i.down,
            x,
            y,
        },
        InputKind::Wheel => Injection::Wheel {
            x,
            y,
            dx: i.dx,
            dy: i.dy,
        },
        InputKind::Key if (1..=0xFE).contains(&i.vk) => Injection::Key {
            vk: i.vk,
            down: i.down,
        },
        InputKind::Key | InputKind::Other => return None,
    })
}

impl Engine {
    fn control_msg(action: ControlAction) -> ScreenMessage {
        ScreenMessage::Control {
            action,
            peer_id: None,
            username: None,
        }
    }

    fn member_name(&self, p: &PeerId) -> String {
        self.room
            .members()
            .get(p)
            .and_then(|m| m.username.clone())
            .unwrap_or_else(|| "Someone".to_owned())
    }

    fn is_desktop(&self, p: &PeerId) -> bool {
        self.room.members().get(p).is_some_and(|m| m.desktop)
    }

    /// Tells the UI, if anything changed.
    pub(crate) fn publish_control(&mut self) {
        let c = &self.control;
        let sharing = self.screen.capture.is_some();
        let view = if sharing {
            let mut viewers: Vec<(PeerId, String, bool)> = self
                .room
                .members()
                .iter()
                .filter(|(_, m)| m.desktop)
                .map(|(p, m)| {
                    (
                        p.clone(),
                        m.username.clone().unwrap_or_else(|| "Someone".to_owned()),
                        c.offers.contains(p),
                    )
                })
                .collect();
            viewers.sort_by(|a, b| a.1.cmp(&b.1));
            ControlView {
                controller: c.controller.as_ref().map(|(_, n)| n.clone()),
                asks: c.asks.clone(),
                viewers,
                ..ControlView::default()
            }
        } else {
            let sharer = self.screen.sharer.as_ref().map(|(p, _)| p.clone());
            ControlView {
                can_ask: sharer.is_some_and(|p| self.is_desktop(&p)),
                asked: c.asked,
                offered: c.offered,
                mine: c.mine,
                controller: c.their_controller.clone(),
                ..ControlView::default()
            }
        };
        if self.control.told.as_ref() != Some(&view) {
            self.control.told = Some(view.clone());
            let _ = self.updates.send(Update::Control(view));
        }
    }

    /// Tells every desktop viewer who controls our screen now.
    fn broadcast_control_state(&self) {
        let m = ScreenMessage::Control {
            action: ControlAction::State,
            peer_id: self
                .control
                .controller
                .as_ref()
                .map(|(p, _)| p.as_str().to_owned()),
            username: self.control.controller.as_ref().map(|(_, n)| n.clone()),
        };
        for (p, member) in self.room.members() {
            if member.desktop {
                self.screen_send(p, &m);
            }
        }
    }

    /// The UI's remote-control commands.
    pub(crate) fn control_cmd(&mut self, cmd: ControlCmd) {
        let sharer = self.screen.sharer.as_ref().map(|(p, n)| (p.clone(), n.clone()));
        match cmd {
            // ---- watching ----
            ControlCmd::Ask => {
                if let Some((p, _)) = sharer.filter(|(p, _)| self.is_desktop(p))
                    && !self.control.mine
                {
                    self.control.asked = true;
                    self.screen_send(&p, &Self::control_msg(ControlAction::Request));
                }
            }
            ControlCmd::Cancel => {
                if let Some((p, _)) = sharer
                    && std::mem::take(&mut self.control.asked)
                {
                    self.screen_send(&p, &Self::control_msg(ControlAction::Cancel));
                }
            }
            ControlCmd::Accept => {
                if let Some((p, _)) = sharer
                    && std::mem::take(&mut self.control.offered)
                {
                    self.screen_send(&p, &Self::control_msg(ControlAction::Accept));
                }
            }
            ControlCmd::Decline => {
                if let Some((p, _)) = sharer
                    && std::mem::take(&mut self.control.offered)
                {
                    self.screen_send(&p, &Self::control_msg(ControlAction::Decline));
                }
            }
            ControlCmd::Release => {
                if let Some((p, _)) = sharer
                    && std::mem::take(&mut self.control.mine)
                {
                    self.screen_send(&p, &Self::control_msg(ControlAction::Release));
                    let _ = self
                        .updates
                        .send(Update::Log("🖱️ You stopped controlling the screen".to_owned()));
                }
            }
            ControlCmd::Input(i) => {
                if let Some((p, _)) = sharer.filter(|_| self.control.mine) {
                    self.screen_send(&p, &ScreenMessage::Input(i));
                }
                return;
            }
            // ---- sharing ----
            ControlCmd::Allow(p) => {
                if self.control.asks.iter().any(|(a, _)| *a == p) {
                    self.grant_control(&p);
                }
            }
            ControlCmd::Deny(p) => {
                if let Some(i) = self.control.asks.iter().position(|(a, _)| *a == p) {
                    self.control.asks.remove(i);
                    self.screen_send(&p, &Self::control_msg(ControlAction::Deny));
                }
            }
            ControlCmd::Offer(p) => {
                if self.screen.capture.is_some()
                    && self.is_desktop(&p)
                    && self.control.controller.as_ref().is_none_or(|(c, _)| *c != p)
                    && !self.control.offers.contains(&p)
                {
                    self.control.offers.push(p.clone());
                    self.screen_send(&p, &Self::control_msg(ControlAction::Offer));
                    let name = self.member_name(&p);
                    let _ = self.updates.send(Update::Log(format!(
                        "🖱️ You offered {name} control of your screen"
                    )));
                }
            }
            ControlCmd::Revoke => {
                for p in std::mem::take(&mut self.control.offers) {
                    self.screen_send(&p, &Self::control_msg(ControlAction::Revoke));
                }
                self.end_control(Ended::TakenBack(None));
            }
        }
        self.publish_control();
    }

    /// `p` controls our screen from now on (one viewer at a time).
    fn grant_control(&mut self, p: &PeerId) {
        let Some(source) = self.screen.shared.clone() else {
            return;
        };
        if self.control.controller.as_ref().is_some_and(|(c, _)| c == p) {
            return;
        }
        self.end_control(Ended::TakenBack(None));
        self.control.asks.retain(|(a, _)| a != p);
        self.control.offers.retain(|o| o != p);
        let name = self.member_name(p);
        let queue = self.queue_tx.clone();
        match RemoteControl::start(area(&source), &name, move |why| {
            let _ = queue.send(Msg::TakeBack(why));
        }) {
            Ok(session) => {
                self.control.session = Some(session);
                self.control.controller = Some((p.clone(), name.clone()));
                self.control.played = 0;
                self.screen_send(p, &Self::control_msg(ControlAction::Grant));
                self.broadcast_control_state();
                let _ = self
                    .updates
                    .send(Update::Log(format!("🖱️ {name} is controlling your screen")));
            }
            Err(e) => {
                tracing::warn!("control: couldn't start ({e})");
                self.screen_send(p, &Self::control_msg(ControlAction::Deny));
                let _ = self
                    .updates
                    .send(Update::Notice(format!("{name} can't control your screen: {e}")));
            }
        }
    }

    /// Ends control of our screen (if anyone has it).
    pub(crate) fn end_control(&mut self, why: Ended) {
        self.control.session = None;
        let Some((p, name)) = self.control.controller.take() else {
            return;
        };
        tracing::info!(
            "control: {name} stopped ({why:?}, {} inputs)",
            self.control.played
        );
        if why != Ended::Released && why != Ended::Left {
            self.screen_send(&p, &Self::control_msg(ControlAction::Revoke));
        }
        if why != Ended::Stopped {
            self.broadcast_control_state();
        }
        let text = match why {
            Ended::TakenBack(Some(TakeBack::Hotkey)) => {
                format!("You took back control from {name} (Ctrl+Alt+Shift+X)")
            }
            Ended::TakenBack(Some(TakeBack::Mouse)) => {
                format!("You took back control from {name} (your mouse)")
            }
            Ended::TakenBack(None) => format!("You took back control from {name}"),
            Ended::Released => format!("{name} stopped controlling your screen"),
            Ended::Left => format!("{name} left: control is back with you"),
            Ended::Stopped => format!("Control ended: you stopped sharing ({name} had it)"),
        };
        let _ = self.updates.send(Update::Notice(text.clone()));
        let _ = self.updates.send(Update::Log(format!("🖱️ {text}")));
    }

    /// The sharer pressed the hotkey or used their mouse.
    pub(crate) fn take_back(&mut self, why: TakeBack) {
        self.end_control(Ended::TakenBack(Some(why)));
        self.publish_control();
    }

    /// Our share stopped: control and everything asked or offered ends.
    pub(crate) fn control_share_stopped(&mut self) {
        self.end_control(Ended::Stopped);
        self.control.asks.clear();
        self.control.offers.clear();
        self.publish_control();
    }

    /// The screen we watch changed hands or stopped: nothing asked, offered or held any more.
    pub(crate) fn control_watch_reset(&mut self) {
        let c = &mut self.control;
        c.asked = false;
        c.offered = false;
        c.mine = false;
        c.their_controller = None;
        self.publish_control();
    }

    /// Someone left: their control, request or offer goes.
    pub(crate) fn control_peer_gone(&mut self, p: &PeerId) {
        if self.control.controller.as_ref().is_some_and(|(c, _)| c == p) {
            self.end_control(Ended::Left);
        }
        self.control.asks.retain(|(a, _)| a != p);
        self.control.offers.retain(|o| o != p);
        self.publish_control();
    }

    /// A `screen-control` from `from`.
    pub(crate) fn control_message(
        &mut self,
        from: &PeerId,
        action: ControlAction,
        peer_id: Option<&str>,
        username: Option<String>,
    ) {
        let from_sharer = self.screen.sharer.as_ref().is_some_and(|(p, _)| p == from);
        let sharing = self.screen.capture.is_some();
        let name = self.member_name(from);
        match action {
            // ---- to us, sharing (only from desktop viewers) ----
            ControlAction::Request if sharing && self.is_desktop(from) => {
                if self.control.controller.as_ref().is_some_and(|(c, _)| c == from) {
                    return;
                }
                if !self.control.asks.iter().any(|(a, _)| a == from) {
                    self.control.asks.push((from.clone(), name.clone()));
                    let _ = self
                        .updates
                        .send(Update::Log(format!("🖱️ {name} asks to control your screen")));
                }
            }
            ControlAction::Cancel if sharing => self.control.asks.retain(|(a, _)| a != from),
            ControlAction::Accept if sharing && self.control.offers.contains(from) => {
                self.grant_control(from);
            }
            ControlAction::Decline if sharing => {
                if let Some(i) = self.control.offers.iter().position(|o| o == from) {
                    self.control.offers.remove(i);
                    let _ = self.updates.send(Update::Notice(format!(
                        "{name} doesn't want to control your screen"
                    )));
                }
            }
            ControlAction::Release if sharing => {
                if self.control.controller.as_ref().is_some_and(|(c, _)| c == from) {
                    self.end_control(Ended::Released);
                }
            }
            // ---- to us, watching (only from the sharer) ----
            ControlAction::Offer if from_sharer && !self.control.mine => self.control.offered = true,
            ControlAction::Grant if from_sharer => {
                let c = &mut self.control;
                c.asked = false;
                c.offered = false;
                c.mine = true;
                let _ = self.updates.send(Update::Notice(format!(
                    "You control {name}'s screen. Click the picture to use their keyboard too."
                )));
                let _ = self
                    .updates
                    .send(Update::Log(format!("🖱️ You are controlling {name}'s screen")));
            }
            ControlAction::Deny if from_sharer => {
                if std::mem::take(&mut self.control.asked) {
                    let _ = self.updates.send(Update::Notice(format!(
                        "{name} said no to controlling their screen"
                    )));
                }
            }
            ControlAction::Revoke if from_sharer => {
                self.control.offered = false;
                if std::mem::take(&mut self.control.mine) {
                    let _ = self.updates.send(Update::Notice(format!(
                        "{name} took back control of their screen"
                    )));
                    let _ = self
                        .updates
                        .send(Update::Log(format!("🖱️ {name} took back control")));
                }
            }
            ControlAction::State if from_sharer => {
                let me = self.room.identity().peer_id.as_str().to_owned();
                self.control.their_controller = username.filter(|_| peer_id.is_some());
                let now_mine = peer_id == Some(me.as_str());
                if self.control.mine && !now_mine {
                    self.control.mine = false;
                }
            }
            _ => return,
        }
        self.publish_control();
    }

    /// A `screen-input` from `from`: played back if they control our screen.
    pub(crate) fn control_input(&mut self, from: &PeerId, i: &ScreenInput) {
        if self.control.controller.as_ref().is_none_or(|(c, _)| c != from) {
            return;
        }
        let Some(inj) = injection(i) else { return };
        self.control.played += 1;
        match inj {
            Injection::Move { .. } => tracing::trace!("control: {inj:?}"),
            Injection::Wheel { .. } => tracing::debug!("control: {inj:?}"),
            // buttons and keys show in the log (the cross-app test reads them)
            _ => tracing::info!("control: input {inj:?}"),
        }
        if let Some(s) = &self.control.session {
            s.input(inj);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_become_playback_or_nothing() {
        let i = |e, button, vk| ScreenInput {
            e,
            x: 1.5,
            y: -0.2,
            button,
            down: true,
            vk,
            ..ScreenInput::default()
        };
        assert_eq!(
            injection(&i(InputKind::Button, 2, 0)),
            Some(Injection::Button {
                button: MouseKey::Right,
                down: true,
                x: 1.0,
                y: 0.0
            })
        );
        assert_eq!(injection(&i(InputKind::Button, 7, 0)), None);
        assert_eq!(
            injection(&i(InputKind::Key, 0, 0x41)),
            Some(Injection::Key { vk: 0x41, down: true })
        );
        assert_eq!(injection(&i(InputKind::Key, 0, 0)), None);
        assert_eq!(injection(&i(InputKind::Key, 0, 0x1FF)), None);
        assert_eq!(injection(&i(InputKind::Other, 0, 0)), None);
        let mut delta = i(InputKind::MoveDelta, 0, 0);
        delta.dx = 12;
        delta.dy = -5;
        assert_eq!(injection(&delta), Some(Injection::MoveDelta { dx: 12, dy: -5 }));
        let mut nan = i(InputKind::Move, 0, 0);
        nan.x = f64::NAN;
        assert_eq!(injection(&nan), None);
    }
}
