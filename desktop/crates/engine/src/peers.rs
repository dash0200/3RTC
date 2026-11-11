//! The peer connections, keyed by peer id: opening them the web app's way, applying signaling
//! in the right order, and turning libwebrtc's callbacks into engine messages.

use std::collections::HashMap;
use std::sync::Arc;

use rtc_core::{Input, RemoteSignal};
use rtc_protocol::PeerId;
use rtc_protocol::peer::Envelope;
use rtc_protocol::sdp::IceCandidate;
use rtc_protocol::signaling::ClientMessage;
use rtc_webrtc::libwebrtc::data_channel::{DataChannel, DataChannelState};
use rtc_webrtc::libwebrtc::peer_connection::{AnswerOptions, OfferOptions, PeerConnection};
use rtc_webrtc::{channels, convert, factory::Factory};

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
}

pub(crate) struct Peers {
    factory: Factory,
    signaling: rtc_signaling::Handle,
    sink: Sink,
    links: HashMap<PeerId, Link>,
    next_generation: u64,
}

impl Peers {
    pub(crate) fn new(
        factory: Factory,
        signaling: rtc_signaling::Handle,
        sink: impl Fn(PeerEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            factory,
            signaling,
            sink: Arc::new(sink),
            links: HashMap::new(),
            next_generation: 0,
        }
    }

    fn create(&mut self, peer: &PeerId) -> Option<&mut Link> {
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
        // the bulk channel is pre-negotiated: both sides create it
        let bulk = pc
            .create_data_channel(channels::BULK_LABEL, channels::bulk_init())
            .ok();
        let link = Link {
            pc,
            generation,
            main: None,
            _bulk: bulk,
            has_remote: false,
            pending: Vec::new(),
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
        let signaling = self.signaling.clone();
        let Some(link) = self.create(&peer) else { return };
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
        let offer = match link.pc.create_offer(OfferOptions::default()).await {
            Ok(o) => o,
            Err(e) => return tracing::error!("offer to {peer}: {e:?}"),
        };
        if let Err(e) = link.pc.set_local_description(offer.clone()).await {
            return tracing::error!("local offer for {peer}: {e:?}");
        }
        signaling.send(ClientMessage::Offer {
            target_id: peer,
            offer: convert::description_out(&offer),
            fresh: false,
            ice_restart: false,
        });
    }

    /// Applies an offer, answer or candidate from the other side.
    pub(crate) async fn signal(&mut self, peer: PeerId, signal: RemoteSignal) {
        match signal {
            RemoteSignal::Offer { offer, fresh } => {
                let signaling = self.signaling.clone();
                let link = if fresh || !self.links.contains_key(&peer) {
                    self.create(&peer)
                } else {
                    self.links.get_mut(&peer)
                };
                let Some(link) = link else { return };
                let Ok(desc) = convert::description_in(&offer) else {
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
                if let Err(e) = link.pc.set_local_description(answer.clone()).await {
                    return tracing::error!("local answer for {peer}: {e:?}");
                }
                signaling.send(ClientMessage::Answer {
                    target_id: peer,
                    answer: convert::description_out(&answer),
                });
            }
            RemoteSignal::Answer(answer) => {
                let Some(link) = self.links.get_mut(&peer) else {
                    return;
                };
                let Ok(desc) = convert::description_in(&answer) else {
                    return;
                };
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

    /// Turns a callback into a room input (or handles it here).
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
                self.links.get(&peer).filter(|l| l.generation == generation)?;
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
                self.links.get(&peer).filter(|l| l.generation == generation)?;
                match Envelope::from_json(&text) {
                    Ok(envelope) => Some(Input::Peer { from: peer, envelope }),
                    Err(e) => {
                        tracing::debug!("unreadable message from {peer}: {e}");
                        None
                    }
                }
            }
        }
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
            if let Some(dc) = &link.main {
                dc.on_message(None);
                dc.on_state_change(None);
                dc.close();
            }
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
