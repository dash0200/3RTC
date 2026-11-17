//! Two peer connections in one process, connected the way two 3RTC apps are: SDP and
//! candidates pass through the protocol's JSON (as the signaling server relays them), the
//! offering side opens `chat-<peer>` plus the pre-negotiated `bulk` channel, and a chat message
//! goes across in the web app's format.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stderr)] // tests: failing loudly is the point

use std::time::Duration;

use libwebrtc::data_channel::DataChannel;
use libwebrtc::peer_connection::{AnswerOptions, OfferOptions};
use rtc_protocol::PeerId;
use rtc_protocol::peer::{Envelope, PeerMessage};
use rtc_protocol::sdp::{IceCandidate, SessionDescription};
use rtc_webrtc::{channels, convert, factory::Factory};
use tokio::sync::mpsc;
use tokio::time::timeout;

/// Through JSON and back, as the server would relay it.
fn relay<T: serde::Serialize + serde::de::DeserializeOwned>(v: &T) -> T {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_apps_connect_and_chat() {
    // No STUN: both ends are on this machine, host candidates are enough (and CI has no network guarantee).
    let factory = Factory::new(Vec::new());
    let desktop = factory.peer_connection().unwrap();
    let web = factory.peer_connection().unwrap();
    let web_id = PeerId::new("web-peer").unwrap();

    let (desktop_ice_tx, mut desktop_ice) = mpsc::unbounded_channel::<IceCandidate>();
    let (web_ice_tx, mut web_ice) = mpsc::unbounded_channel::<IceCandidate>();
    desktop.on_ice_candidate(Some(Box::new(move |c| {
        let _ = desktop_ice_tx.send(convert::candidate_out(&c));
    })));
    web.on_ice_candidate(Some(Box::new(move |c| {
        let _ = web_ice_tx.send(convert::candidate_out(&c));
    })));
    let (web_dc_tx, mut web_dcs) = mpsc::unbounded_channel::<DataChannel>();
    web.on_data_channel(Some(Box::new(move |dc| {
        let _ = web_dc_tx.send(dc);
    })));

    // The offering side's channels, as usePeerMesh opens them
    let main = desktop
        .create_data_channel(&channels::main_label(&web_id), channels::main_init())
        .unwrap();
    let _bulk_desktop = desktop
        .create_data_channel(channels::BULK_LABEL, channels::bulk_init())
        .unwrap();
    let _bulk_web = web
        .create_data_channel(channels::BULK_LABEL, channels::bulk_init())
        .unwrap();

    let offer = desktop.create_offer(OfferOptions::default()).await.unwrap();
    desktop.set_local_description(offer.clone()).await.unwrap();
    let wire: SessionDescription = relay(&convert::description_out(&offer));
    web.set_remote_description(convert::description_in(&wire).unwrap())
        .await
        .unwrap();

    let answer = web.create_answer(AnswerOptions::default()).await.unwrap();
    web.set_local_description(answer.clone()).await.unwrap();
    let wire: SessionDescription = relay(&convert::description_out(&answer));
    desktop
        .set_remote_description(convert::description_in(&wire).unwrap())
        .await
        .unwrap();

    // Trickle the first candidates each way through the protocol's JSON
    let c = timeout(Duration::from_secs(10), desktop_ice.recv())
        .await
        .unwrap()
        .unwrap();
    web.add_ice_candidate(convert::candidate_in(&relay(&c)).unwrap())
        .await
        .unwrap();
    let c = timeout(Duration::from_secs(10), web_ice.recv())
        .await
        .unwrap()
        .unwrap();
    desktop
        .add_ice_candidate(convert::candidate_in(&relay(&c)).unwrap())
        .await
        .unwrap();

    let web_main = timeout(Duration::from_secs(15), web_dcs.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(web_main.label(), "chat-web-peer");

    let (got_tx, mut got) = mpsc::unbounded_channel::<String>();
    web_main.on_message(Some(Box::new(move |b| {
        let _ = got_tx.send(String::from_utf8_lossy(b.data).into_owned());
    })));

    let hello = Envelope {
        sender: Some("Darshan".into()),
        timestamp: Some(1.0),
        message: PeerMessage::Chat {
            id: "m1".into(),
            is_host: true,
            text: "hello from desktop".into(),
            reply_to: None,
            mentions: Vec::new(),
        },
    };
    // the channel may still be opening: retry the send briefly
    let text = hello.to_json().unwrap();
    let mut sent = false;
    for _ in 0..50 {
        if main.send(text.as_bytes(), false).is_ok() {
            sent = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(sent, "main channel never opened");
    let received = timeout(Duration::from_secs(10), got.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(Envelope::from_json(&received).unwrap(), hello);

    desktop.close();
    web.close();
}
