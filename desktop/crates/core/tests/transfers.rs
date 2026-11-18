//! Chat files: who gets them, accepting big ones and folder files, and what a cancel affects
//! (the web app's rules, `client-ts/tests/unit/transferCancel.test.ts`).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests: failing loudly is the point

use rtc_core::transfers::{ACCEPT_MIN_BYTES, CancelOutcome, Ended, SendStatus, Transfers, needs_accept};
use rtc_core::{FOLDER_MAX_FILES, clean_folder};
use rtc_protocol::PeerId;
use rtc_protocol::peer::{Envelope, FolderEntry, PeerMessage};

fn pid(s: &str) -> PeerId {
    PeerId::new(s).unwrap()
}

#[test]
fn only_big_files_wait_to_be_accepted() {
    assert_eq!(
        ACCEPT_MIN_BYTES,
        8 * 1024 * 1024,
        "the web app uses the same size"
    );
    assert!(!needs_accept(ACCEPT_MIN_BYTES - 1));
    assert!(needs_accept(ACCEPT_MIN_BYTES));
}

#[test]
fn an_offered_file_goes_only_to_those_who_accept() {
    let mut t = Transfers::default();
    t.sending("tx", [pid("bob"), pid("carol")], true);
    assert_eq!(
        t.status("tx"),
        Some(SendStatus {
            waiting: 2,
            sending: 0,
            sent: 0
        })
    );
    assert!(t.on_accept("tx", &pid("bob")), "bob gets it now");
    assert!(!t.on_accept("tx", &pid("bob")), "once");
    assert!(!t.on_accept("tx", &pid("mallory")), "not offered to them");
    assert_eq!(t.delivered("tx", &pid("bob")), None, "carol may still accept");
    assert_eq!(
        t.status("tx"),
        Some(SendStatus {
            waiting: 1,
            sending: 0,
            sent: 1
        })
    );
    assert_eq!(
        t.on_cancel("tx", &pid("carol")),
        CancelOutcome::Over(Ended::Finished),
        "carol declined: bob has it, it's over"
    );
    assert!(!t.is_ours("tx"));
}

#[test]
fn nobody_accepting_stops_it() {
    let mut t = Transfers::default();
    t.sending("tx", [pid("bob"), pid("carol")], true);
    assert_eq!(t.on_cancel("tx", &pid("bob")), CancelOutcome::StopTo(pid("bob")));
    assert_eq!(
        t.on_cancel("tx", &pid("carol")),
        CancelOutcome::Over(Ended::NobodyGotIt)
    );
}

#[test]
fn a_small_file_goes_to_everyone_at_once() {
    let mut t = Transfers::default();
    t.sending("tx", [pid("bob"), pid("carol")], false);
    assert!(!t.on_accept("tx", &pid("bob")), "nothing to accept");
    assert_eq!(t.delivered("tx", &pid("bob")), None);
    assert_eq!(t.delivered("tx", &pid("carol")), Some(Ended::Finished));
}

#[test]
fn a_cancel_from_the_files_sender_cancels_it_for_the_receiver() {
    let mut t = Transfers::default();
    t.receiving("tx", &pid("alice"));
    assert_eq!(t.sender_of("tx"), Some(&pid("alice")));
    assert_eq!(t.on_cancel("tx", &pid("alice")), CancelOutcome::Cancelled);
    assert!(!t.is_theirs("tx"), "forgotten once cancelled");
    assert_eq!(t.on_cancel("tx", &pid("alice")), CancelOutcome::Ignore);
}

#[test]
fn another_receivers_cancel_does_not_cancel_it_for_us() {
    let mut t = Transfers::default();
    t.receiving("tx", &pid("alice"));
    assert_eq!(t.on_cancel("tx", &pid("bob")), CancelOutcome::Ignore);
    assert!(t.is_theirs("tx"));
}

#[test]
fn a_receiver_cancelling_only_stops_the_sending_to_them() {
    let mut t = Transfers::default();
    t.sending("tx", [pid("bob"), pid("carol")], false);
    assert_eq!(t.on_cancel("tx", &pid("bob")), CancelOutcome::StopTo(pid("bob")));
    assert!(t.is_ours("tx"), "carol still gets it");
    assert_eq!(
        t.on_cancel("tx", &pid("bob")),
        CancelOutcome::Ignore,
        "bob is out already"
    );
    assert_eq!(t.on_cancel("tx", &pid("mallory")), CancelOutcome::Ignore);
}

#[test]
fn receivers_leaving_count_as_not_receiving() {
    let mut t = Transfers::default();
    t.sending("a", [pid("bob"), pid("carol")], false);
    t.sending("b", [pid("bob")], true);
    t.sending("c", [pid("bob"), pid("dave")], false);
    assert_eq!(t.delivered("c", &pid("dave")), None);
    assert_eq!(
        t.peer_gone(&pid("bob")),
        vec![
            ("b".to_owned(), Ended::NobodyGotIt),
            ("c".to_owned(), Ended::Finished)
        ],
        "a still goes to carol"
    );
    assert!(t.is_ours("a"));
    assert_eq!(
        t.peer_gone(&pid("carol")),
        vec![("a".to_owned(), Ended::NobodyGotIt)]
    );
    assert!(t.peer_gone(&pid("eve")).is_empty());
}

#[test]
fn a_finished_transfer_and_leaving_the_room_forget_everything() {
    let mut t = Transfers::default();
    t.sending("tx", [pid("bob")], false);
    t.receiving("rx", &pid("alice"));
    t.finish("tx");
    assert_eq!(t.on_cancel("tx", &pid("bob")), CancelOutcome::Ignore);
    t.reset();
    assert_eq!(t.on_cancel("rx", &pid("alice")), CancelOutcome::Ignore);
}

fn entry(tid: &str, path: &str, size: f64) -> FolderEntry {
    FolderEntry {
        transfer_id: tid.to_owned(),
        path: path.to_owned(),
        file_name: String::new(),
        file_size: size,
        mime_type: "image/png".to_owned(),
    }
}

#[test]
fn a_folder_offer_is_cleaned() {
    let f = clean_folder(
        "fold".to_owned(),
        "",
        vec![
            entry("b", "Photos/2026/b.png", 10.0),
            entry("a", "Photos/a.png", 5.0),
            entry("x", "../../Windows/evil.dll", 1.0),
            entry("", "Photos/c.png", 1.0),
            entry("fold", "Photos/d.png", 1.0),
            entry("n", "Photos/neg.png", -4.0),
        ],
    )
    .unwrap();
    assert_eq!(
        f.name, "Photos",
        "named after its top folder when the name is missing"
    );
    let paths: Vec<&str> = f.files.iter().map(|x| x.path.as_str()).collect();
    assert!(paths.contains(&"Photos/2026/b.png"));
    assert!(paths.contains(&"Photos/a.png"));
    assert!(paths.iter().all(|p| !p.contains("..")), "{paths:?}");
    assert!(
        !f.files
            .iter()
            .any(|x| x.transfer_id.is_empty() || x.transfer_id == "fold")
    );
    assert_eq!(
        f.files.iter().find(|x| x.transfer_id == "n").map(|x| x.file_size),
        Some(0)
    );
    assert_eq!(
        f.files
            .iter()
            .find(|x| x.transfer_id == "b")
            .map(|x| x.file_name.as_str()),
        Some("b.png")
    );
    assert!(clean_folder(String::new(), "x", vec![entry("a", "a.png", 1.0)]).is_none());
    assert!(clean_folder("f".to_owned(), "x", Vec::new()).is_none());
    let many: Vec<FolderEntry> = (0..FOLDER_MAX_FILES + 5)
        .map(|i| entry(&format!("t{i}"), &format!("F/{i}.png"), 1.0))
        .collect();
    assert_eq!(
        clean_folder("f".to_owned(), "F", many).unwrap().files.len(),
        FOLDER_MAX_FILES
    );
}

#[test]
fn the_web_apps_messages_are_the_same() {
    for action in ["cancel", "accept"] {
        let e = Envelope::from_json(&format!(
            r#"{{"type":"p2p-file-control","transferId":"t1","action":"{action}","timestamp":1}}"#
        ))
        .unwrap();
        assert_eq!(
            e.message,
            PeerMessage::P2pFileControl {
                transfer_id: "t1".to_owned(),
                action: action.to_owned(),
                start_chunk: None,
            }
        );
    }
    let out = Envelope {
        sender: None,
        timestamp: Some(1.0),
        message: PeerMessage::P2pFolderOffer {
            id: "m1".to_owned(),
            folder_id: "f1".to_owned(),
            name: "Photos".to_owned(),
            caption: String::new(),
            is_host: false,
            files: vec![entry("t1", "Photos/a.png", 3.0)],
        },
    }
    .to_json()
    .unwrap();
    assert!(out.contains(r#""type":"p2p-folder-offer""#), "{out}");
    assert!(out.contains(r#""folderId":"f1""#), "{out}");
    assert!(out.contains(r#""transferId":"t1""#), "{out}");
    assert!(out.contains(r#""path":"Photos/a.png""#), "{out}");
    let back = Envelope::from_json(&out).unwrap();
    assert!(matches!(back.message, PeerMessage::P2pFolderOffer { ref files, .. } if files.len() == 1));
}
