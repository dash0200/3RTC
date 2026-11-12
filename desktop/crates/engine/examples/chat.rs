//! A headless client on the engine: `cargo run -p rtc-engine --example chat -- <ws url> <name> [room]`.
//! Without a room code it creates one. Its voice is a 440 Hz tone. Type a line to chat;
//! `/mute`, `/unmute`, `/deafen`, `/undeafen`, `/restart-audio`, `/quit` do what they say;
//! `/react 🔥` sends a reaction, `/sound quack` a soundboard clip, `/image <path> [caption]` a
//! chat picture. Pictures that arrive are reported with their size and FNV-1a 64 hash.
//! Used by the cross-app tests (desktop engine ↔ web app in Chromium): one line per event,
//! `ROOM <code> muted=<bool> speaking=<bool> members=<name>[+][~speaking][!muted],…`.

#![allow(clippy::print_stdout)]

use anyhow::{Context, bail};
use rtc_core::Command;
use rtc_engine::{Config, Handle, MicSource, OutgoingImage, Phase, Update};
use rtc_protocol::{ClientId, RoomId};
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let mut args = std::env::args().skip(1);
    let (Some(url), Some(name)) = (args.next(), args.next()) else {
        bail!("usage: chat <ws url> <name> [room]");
    };
    let room = args
        .next()
        .map(|r| RoomId::parse(&r))
        .transpose()
        .context("room code")?;
    let (engine, mut updates) = rtc_engine::start(Config {
        signaling_urls: vec![url],
        username: name,
        client_id: ClientId::new(format!("cli-{:08x}", rand_id()))?,
        build: "000000.0000".into(),
        ice: Vec::new(),
        // RTC_MIC=pipeline: the real sound card through our own audio path; =device: through
        // libwebrtc's platform audio ("classic"); anything else a tone.
        mic: match std::env::var("RTC_MIC").as_deref() {
            Ok("pipeline") => MicSource::Pipeline,
            Ok("device") => MicSource::Device,
            _ => MicSource::Tone(440.0),
        },
    });
    // a steady test tone sounds like noise to RNNoise, which would (rightly) remove it
    engine.set_isolation(std::env::var("RTC_ISOLATION").as_deref() == Ok("1"));
    let mut asked = false;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        tokio::select! {
            u = updates.recv() => {
                let Some(u) = u else { break };
                match u {
                    Update::Room(s) => {
                        if s.online && !asked {
                            asked = true;
                            engine.command(room.map_or(Command::CreateRoom, Command::Join));
                        }
                        if let Phase::InRoom(id) = s.phase {
                            let names: Vec<_> = s
                                .members
                                .iter()
                                .map(|(_, m)| {
                                    format!(
                                        "{}{}{}{}",
                                        m.username.as_deref().unwrap_or("?"),
                                        if m.connected { "+" } else { "" },
                                        if m.speaking { "~" } else { "" },
                                        if m.muted { "!" } else { "" }
                                    )
                                })
                                .collect();
                            println!("ROOM {id} muted={} speaking={} members={}", s.muted, s.speaking, names.join(","));
                        }
                    }
                    Update::Chat(c) => match &c.image {
                        Some(i) => println!("IMAGE_START {} {} {} {}: {}", i.transfer_id, i.file_name, i.file_size, c.name, c.text),
                        None => println!("CHAT {}: {}", c.name, c.text),
                    },
                    Update::Reaction(r) => println!("REACTION {} {} x{}", r.name, r.emoji, r.combo),
                    Update::Sound(s) => println!("SOUND {} {}", s.name, s.sound_id),
                    Update::ImageProgress { transfer_id, percent } => println!("IMAGE_PROGRESS {transfer_id} {percent}"),
                    Update::ImageReady { transfer_id, bytes } => {
                        println!("IMAGE_READY {transfer_id} {} {:016x}", bytes.len(), fnv(&bytes));
                    }
                    Update::Notice(n) => println!("NOTICE {n}"),
                    Update::Log(l) => println!("LOG {l}"),
                    Update::Devices(_) | Update::Net(_) => {}
                }
            }
            line = lines.next_line() => {
                match line? {
                    Some(l) if l == "/mute" => engine.command(Command::SetMuted(true)),
                    Some(l) if l == "/unmute" => engine.command(Command::SetMuted(false)),
                    Some(l) if l == "/deafen" => engine.command(Command::SetDeafened(true)),
                    Some(l) if l == "/undeafen" => engine.command(Command::SetDeafened(false)),
                    Some(l) if l == "/restart-audio" => engine.restart_audio(),
                    Some(l) if l.starts_with("/react ") => engine.command(Command::React {
                        id: Handle::new_message_id(),
                        emoji: l["/react ".len()..].trim().to_owned(),
                        lane: 50.0,
                    }),
                    Some(l) if l.starts_with("/sound ") => {
                        let id = l["/sound ".len()..].trim().to_owned();
                        engine.command(Command::PlaySound { sound_name: id.clone(), sound_id: id, emoji: "🎵".into() });
                    }
                    Some(l) if l.starts_with("/image ") => {
                        let rest = l["/image ".len()..].trim();
                        let (path, caption) = rest.split_once(' ').unwrap_or((rest, ""));
                        match std::fs::read(path) {
                            Ok(bytes) => engine.send_image(OutgoingImage {
                                id: Handle::new_message_id(),
                                transfer_id: Handle::new_message_id(),
                                file_name: std::path::Path::new(path)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                mime: rtc_protocol::image::mime_for_name(path).unwrap_or("image/png").to_owned(),
                                bytes: bytes.into(),
                                caption: caption.to_owned(),
                            }),
                            Err(e) => println!("NOTICE can't read {path}: {e}"),
                        }
                    }
                    Some(l) if l == "/quit" => {
                        engine.command(Command::Leave);
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        break;
                    }
                    Some(l) => engine.command(Command::SendChat { id: Handle::new_message_id(), text: l }),
                    None => {}
                }
            }
        }
    }
    Ok(())
}

/// FNV-1a, 64 bits: the test compares pictures by size and this.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn rand_id() -> u32 {
    std::process::id()
}
