//! A headless client on the engine: `cargo run -p rtc-engine --example chat -- <ws url> <name> [room]`.
//! Without a room code it creates one. Its voice is a 440 Hz tone. Type a line to chat;
//! `/mute`, `/unmute`, `/deafen`, `/undeafen`, `/restart-audio`, `/quit` do what they say.
//! Used by the cross-app tests (desktop engine ↔ web app in Chromium): one line per event,
//! `ROOM <code> muted=<bool> speaking=<bool> members=<name>[+][~speaking][!muted],…`.

#![allow(clippy::print_stdout)]

use anyhow::{Context, bail};
use rtc_core::Command;
use rtc_engine::{Config, Handle, MicSource, Phase, Update};
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
        // a 440 Hz tone, so the other side can check it hears us
        // RTC_MIC=device uses the real sound card (libwebrtc's platform audio), anything else a tone.
        mic: if std::env::var("RTC_MIC").as_deref() == Ok("device") {
            MicSource::Device
        } else {
            MicSource::Tone(440.0)
        },
    });
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
                    Update::Chat(c) => println!("CHAT {}: {}", c.name, c.text),
                    Update::Notice(n) => println!("NOTICE {n}"),
                    Update::Log(l) => println!("LOG {l}"),
                    Update::Devices(_) => {}
                }
            }
            line = lines.next_line() => {
                match line? {
                    Some(l) if l == "/mute" => engine.command(Command::SetMuted(true)),
                    Some(l) if l == "/unmute" => engine.command(Command::SetMuted(false)),
                    Some(l) if l == "/deafen" => engine.command(Command::SetDeafened(true)),
                    Some(l) if l == "/undeafen" => engine.command(Command::SetDeafened(false)),
                    Some(l) if l == "/restart-audio" => engine.restart_audio(),
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

fn rand_id() -> u32 {
    std::process::id()
}
