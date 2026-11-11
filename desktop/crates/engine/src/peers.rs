//! The peer connections, keyed by peer id: opening them the web app's way (voice and video
//! transceivers, `chat-<peer>` and the pre-negotiated `bulk` channel), applying signaling in the
//! right order, and turning libwebrtc's callbacks into engine messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rtc_core::{Input, LinkState, RemoteSignal};
use rtc_protocol::PeerId;
use rtc_protocol::peer::Envelope;
use rtc_protocol::sdp::{IceCandidate, SessionDescription};
use rtc_protocol::signaling::ClientMessage;
use rtc_webrtc::libwebrtc::MediaType;
use rtc_webrtc::libwebrtc::data_channel::{DataChannel, DataChannelState};
use rtc_webrtc::libwebrtc::media_stream_track::MediaStreamTrack;
use rtc_webrtc::libwebrtc::peer_connection::{
    AnswerOptions, OfferOptions, PeerConnection, PeerConnectionState,
};
use rtc_webrtc::libwebrtc::rtp_parameters::Priority;
use rtc_webrtc::libwebrtc::rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit};
use rtc_webrtc::libwebrtc::session_description::SessionDescription as RtcDescription;
use rtc_webrtc::stats::{self, Levels};
use rtc_webrtc::{channels, convert, factory::Factory, sdp};

/// How often each connection's audio levels are read.
const LEVELS_EVERY: Duration = Duration::from_millis(150);
/// How often the voice totals go to the log (in level ticks: about every 10 s).
const FLOW_EVERY_TICKS: u32 = 67;

/// Something a peer connection did (from libwebrtc's threads).
#[derive(Debug)]
pub(crate) enum PeerEvent {
    /// The other side opened a channel to us.
    Channel {
        peer: PeerId,
        generation: u64,
        channel: DataChannel,
    },
    /// The main channel opened or closed.
    MainState {
        peer: PeerId,
        generation: u64,
        open: bool,
    },
    /// A message on the main channel.
    Message {
        peer: PeerId,
        generation: u64,
        text: String,
    },
    /// The connection's state changed.
    Link {
        peer: PeerId,
        generation: u64,
        state: PeerConnectionState,
    },
    /// Audio levels on this connection.
    Levels {
        peer: PeerId,
        generation: u64,
        levels: Levels,
    },
}

type Sink = Arc<dyn Fn(PeerEvent) + Send + Sync>;

struct Link {
    pc: PeerConnection,
    /// Which connection this is: events from a replaced one are ignored.
    generation: u64,
    main: Option<DataChannel>,
    _bulk: Option<DataChannel>,
    has_remote: bool,
    pending: Vec<IceCandidate>,
    levels: tokio::task::JoinHandle<()>,
}

pub(crate) struct Peers {
    factory: Factory,
    voice: MediaStreamTrack,
    signaling: rtc_signaling::Handle,
    sink: Sink,
    links: HashMap<PeerId, Link>,
    next_generation: u64,
}

/// Offers keep every transceiver's direction (libwebrtc's default would stop receiving).
const fn offer_options(ice_restart: bool) -> OfferOptions {
    OfferOptions {
        ice_restart,
        offer_to_receive_audio: None,
        offer_to_receive_video: None,
    }
}

/// Our description with the web app's Opus settings.
fn tuned(desc: &RtcDescription) -> Option<RtcDescription> {
    let mut wire = convert::description_out(desc);
    wire.sdp = sdp::tune_opus(&wire.sdp);
    convert::description_in(&wire).ok()
}

/// Theirs, tuned the same way before it's applied (as the web app does).
fn tuned_in(desc: &SessionDescription) -> Option<RtcDescription> {
    let wire = SessionDescription {
        kind: desc.kind,
        sdp: sdp::tune_opus(&desc.sdp),
    };
    convert::description_in(&wire).ok()
}

impl Peers {
    pub(crate) fn new(
        factory: Factory,
        voice: MediaStreamTrack,
        signaling: rtc_signaling::Handle,
        sink: impl Fn(PeerEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            factory,
            voice,
            signaling,
            sink: Arc::new(sink),
            links: HashMap::new(),
            next_generation: 0,
        }
    }

    fn create(&mut self, peer: &PeerId, initiator: bool) -> Option<&mut Link> {
        self.close(peer);
        let pc = match self.factory.peer_connection() {
            Ok(pc) => pc,
            Err(e) => {
                tracing::error!("{e}");
                return None;
            }
        };
        self.next_generation += 1;
        let generation = self.next_generation;
        let signaling = self.signaling.clone();
        let target = peer.clone();
        pc.on_ice_candidate(Some(Box::new(move |c| {
            signaling.send(ClientMessage::IceCandidate {
                target_id: target.clone(),
                candidate: convert::candidate_out(&c),
            });
        })));
        let sink = Arc::clone(&self.sink);
        let from = peer.clone();
        pc.on_data_channel(Some(Box::new(move |channel| {
            sink(PeerEvent::Channel {
                peer: from.clone(),
                generation,
                channel,
            });
        })));
        let sink = Arc::clone(&self.sink);
        let from = peer.clone();
        pc.on_connection_state_change(Some(Box::new(move |state| {
            sink(PeerEvent::Link {
                peer: from.clone(),
                generation,
                state,
            });
        })));
        // Voice: a track added before any description, so as the answerer it takes the offered
        // audio line and the answer stays send-and-receive.
        if let Err(e) = pc.add_track(self.voice.clone(), &["voice"]) {
            tracing::error!("voice track to {peer}: {e:?}");
        }
        if initiator {
            // as usePeerMesh: a video transceiver up front, so a screen share needs no new offer
            let init = RtpTransceiverInit {
                direction: RtpTransceiverDirection::SendRecv,
                stream_ids: Vec::new(),
                send_encodings: Vec::new(),
            };
            if let Err(e) = pc.add_transceiver_for_media(MediaType::Video, init) {
                tracing::warn!("video transceiver to {peer}: {e:?}");
            }
        }
        // the bulk channel is pre-negotiated: both sides create it
        let bulk = pc
            .create_data_channel(channels::BULK_LABEL, channels::bulk_init())
            .ok();
        let levels = tokio::spawn(watch_levels(
            pc.clone(),
            peer.clone(),
            generation,
            Arc::clone(&self.sink),
        ));
        let link = Link {
            pc,
            generation,
            main: None,
            _bulk: bulk,
            has_remote: false,
            pending: Vec::new(),
            levels,
        };
        Some(self.links.entry(peer.clone()).insert_entry(link).into_mut())
    }

    fn watch_main(sink: &Sink, peer: &PeerId, generation: u64, dc: &DataChannel) {
        let s = Arc::clone(sink);
        let p = peer.clone();
        dc.on_state_change(Some(Box::new(move |state| {
            let open = match state {
                DataChannelState::Open => true,
                DataChannelState::Closed => false,
                _ => return,
            };
            s(PeerEvent::MainState {
                peer: p.clone(),
                generation,
                open,
            });
        })));
        let s = Arc::clone(sink);
        let p = peer.clone();
        dc.on_message(Some(Box::new(move |buf| {
            if buf.binary {
                return;
            }
            let text = String::from_utf8_lossy(buf.data).into_owned();
            s(PeerEvent::Message {
                peer: p.clone(),
                generation,
                text,
            });
        })));
    }

    /// Starts a connection; the initiator opens `chat-<peer>` and sends the offer.
    pub(crate) async fn open(&mut self, peer: PeerId, initiator: bool) {
        let sink = Arc::clone(&self.sink);
        let Some(link) = self.create(&peer, initiator) else {
            return;
        };
        if !initiator {
            return;
        }
        match link
            .pc
            .create_data_channel(&channels::main_label(&peer), channels::main_init())
        {
            Ok(dc) => {
                Self::watch_main(&sink, &peer, link.generation, &dc);
                link.main = Some(dc);
            }
            Err(e) => tracing::error!("main channel to {peer}: {e:?}"),
        }
        self.offer(&peer, false).await;
    }

    /// Makes and sends an offer (with an ICE restart when asked).
    pub(crate) async fn offer(&mut self, peer: &PeerId, ice_restart: bool) {
        let signaling = self.signaling.clone();
        let Some(link) = self.links.get_mut(peer) else {
            return;
        };
        let offer = match link.pc.create_offer(offer_options(ice_restart)).await {
            Ok(o) => o,
            Err(e) => return tracing::error!("offer to {peer}: {e:?}"),
        };
        let offer = tuned(&offer).unwrap_or(offer);
        if let Err(e) = link.pc.set_local_description(offer.clone()).await {
            return tracing::error!("local offer for {peer}: {e:?}");
        }
        tune_sender(&link.pc);
        signaling.send(ClientMessage::Offer {
            target_id: peer.clone(),
            offer: convert::description_out(&offer),
            fresh: false,
            ice_restart,
        });
    }

    /// Applies an offer, answer or candidate from the other side.
    pub(crate) async fn signal(&mut self, peer: PeerId, signal: RemoteSignal) {
        match signal {
            RemoteSignal::Offer { offer, fresh } => {
                let signaling = self.signaling.clone();
                let link = if fresh || !self.links.contains_key(&peer) {
                    self.create(&peer, false)
                } else {
                    self.links.get_mut(&peer)
                };
                let Some(link) = link else { return };
                let Some(desc) = tuned_in(&offer) else {
                    return tracing::warn!("unreadable offer from {peer}");
                };
                if let Err(e) = link.pc.set_remote_description(desc).await {
                    return tracing::warn!("offer from {peer}: {e:?}");
                }
                link.has_remote = true;
                Self::flush(link).await;
                let answer = match link.pc.create_answer(AnswerOptions::default()).await {
                    Ok(a) => a,
                    Err(e) => return tracing::error!("answer to {peer}: {e:?}"),
                };
                let answer = tuned(&answer).unwrap_or(answer);
                if let Err(e) = link.pc.set_local_description(answer.clone()).await {
                    return tracing::error!("local answer for {peer}: {e:?}");
                }
                tune_sender(&link.pc);
                signaling.send(ClientMessage::Answer {
                    target_id: peer,
                    answer: convert::description_out(&answer),
                });
            }
            RemoteSignal::Answer(answer) => {
                let Some(link) = self.links.get_mut(&peer) else {
                    return;
                };
                let Some(desc) = tuned_in(&answer) else { return };
                if let Err(e) = link.pc.set_remote_description(desc).await {
                    return tracing::warn!("answer from {peer}: {e:?}");
                }
                link.has_remote = true;
                Self::flush(link).await;
            }
            RemoteSignal::Candidate(c) => {
                let Some(link) = self.links.get_mut(&peer) else {
                    return;
                };
                if link.has_remote {
                    Self::add(link, &c).await;
                } else {
                    link.pending.push(c);
                }
            }
        }
    }

    async fn flush(link: &mut Link) {
        for c in std::mem::take(&mut link.pending) {
            Self::add(link, &c).await;
        }
    }

    async fn add(link: &Link, c: &IceCandidate) {
        if c.candidate.is_empty() {
            return; // end-of-candidates
        }
        match convert::candidate_in(c) {
            Ok(rc) => {
                if let Err(e) = link.pc.add_ice_candidate(rc).await {
                    tracing::debug!("candidate rejected: {e:?}");
                }
            }
            Err(e) => tracing::debug!("{e}"),
        }
    }

    fn current(&self, peer: &PeerId, generation: u64) -> bool {
        self.links.get(peer).is_some_and(|l| l.generation == generation)
    }

    /// Turns a callback into a room input (or handles it here). Levels come back separately.
    pub(crate) fn on_event(&mut self, e: PeerEvent) -> Option<Input> {
        match e {
            PeerEvent::Channel {
                peer,
                generation,
                channel,
            } => {
                let sink = Arc::clone(&self.sink);
                let link = self.links.get_mut(&peer).filter(|l| l.generation == generation)?;
                if !channel.label().starts_with("chat-") {
                    return None;
                }
                Self::watch_main(&sink, &peer, generation, &channel);
                let open = channel.state() == DataChannelState::Open;
                link.main = Some(channel);
                open.then_some(Input::ChannelOpen(peer))
            }
            PeerEvent::MainState {
                peer,
                generation,
                open,
            } => {
                self.current(&peer, generation).then_some(())?;
                Some(if open {
                    Input::ChannelOpen(peer)
                } else {
                    Input::ChannelClosed(peer)
                })
            }
            PeerEvent::Message {
                peer,
                generation,
                text,
            } => {
                self.current(&peer, generation).then_some(())?;
                match Envelope::from_json(&text) {
                    Ok(envelope) => Some(Input::Peer { from: peer, envelope }),
                    Err(e) => {
                        tracing::debug!("unreadable message from {peer}: {e}");
                        None
                    }
                }
            }
            PeerEvent::Link {
                peer,
                generation,
                state,
            } => {
                self.current(&peer, generation).then_some(())?;
                let state = match state {
                    PeerConnectionState::Connected => LinkState::Connected,
                    PeerConnectionState::Disconnected => LinkState::Disconnected,
                    PeerConnectionState::Failed => LinkState::Failed,
                    _ => return None,
                };
                Some(Input::Link { peer, state })
            }
            PeerEvent::Levels { .. } => None,
        }
    }

    /// Whether `generation` is still `peer`'s connection.
    pub(crate) fn is_current(&self, peer: &PeerId, generation: u64) -> bool {
        self.current(peer, generation)
    }

    /// Sends on the main channel, if it's open.
    pub(crate) fn send(&self, peer: &PeerId, envelope: &Envelope) {
        let Some(dc) = self.links.get(peer).and_then(|l| l.main.as_ref()) else {
            return;
        };
        if dc.state() != DataChannelState::Open {
            return;
        }
        if let Ok(text) = envelope.to_json()
            && let Err(e) = dc.send(text.as_bytes(), false)
        {
            tracing::debug!("send to {peer}: {e:?}");
        }
    }

    pub(crate) fn close(&mut self, peer: &PeerId) {
        if let Some(link) = self.links.remove(peer) {
            link.levels.abort();
            if let Some(dc) = &link.main {
                dc.on_message(None);
                dc.on_state_change(None);
                dc.close();
            }
            link.pc.on_connection_state_change(None);
            link.pc.on_ice_candidate(None);
            link.pc.on_data_channel(None);
            link.pc.close();
        }
    }

    pub(crate) fn close_all(&mut self) {
        let all: Vec<_> = self.links.keys().cloned().collect();
        for p in all {
            self.close(&p);
        }
    }
}

/// Voice sender: 128 kbps, high priority (`tuneAudioSender`).
fn tune_sender(pc: &PeerConnection) {
    for sender in pc.senders() {
        if !matches!(sender.track(), Some(MediaStreamTrack::Audio(_))) {
            continue;
        }
        let mut params = sender.parameters();
        if let Some(enc) = params.encodings.first_mut() {
            enc.max_bitrate = Some(sdp::voice_bitrate(4));
            enc.priority = Priority::High;
            if let Err(e) = sender.set_parameters(params) {
                tracing::debug!("voice sender parameters: {e:?}");
            }
        }
    }
}

async fn watch_levels(pc: PeerConnection, peer: PeerId, generation: u64, sink: Sink) {
    let mut tick = tokio::time::interval(LEVELS_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks: u32 = 0;
    let mut last_flow = stats::Flow::default();
    loop {
        tick.tick().await;
        if pc.connection_state() != PeerConnectionState::Connected {
            continue;
        }
        if let Ok(report) = pc.get_stats().await {
            ticks += 1;
            if ticks % FLOW_EVERY_TICKS == 1 {
                let flow = stats::flow(&report);
                let ms = |v: Option<f64>| v.map_or_else(|| "?".to_owned(), |v| format!("{v:.0} ms"));
                tracing::info!(
                    "audio with {peer}: {flow}; network round trip {} {}; their voice waits {} in our jitter buffer",
                    ms(flow.rtt_ms),
                    flow.path.as_deref().unwrap_or("(path unknown)"),
                    ms(flow.jitter_buffer_ms_since(&last_flow)),
                );
                last_flow = flow;
            }
            sink(PeerEvent::Levels {
                peer: peer.clone(),
                generation,
                levels: stats::levels(&report),
            });
        }
    }
}
