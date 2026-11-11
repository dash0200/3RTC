//! A terminal chat client on the engine: `cargo run -p rtc-engine --example chat -- <ws url> <name> [room]`.
//! Without a room code it creates one. Type a line to send it; `/quit` leaves.
//! Used by the cross-app test (desktop engine ↔ web app in Chromium).

#![allow(clippy::print_stdout)]

use anyhow::{Context, bail};
use rtc_core::Command;
use rtc_engine::{Config, Handle, Phase, Update};
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
        signaling_url: url,
        username: name,
        client_id: ClientId::new(format!("cli-{:08x}", rand_id()))?,
        build: "000000.0000".into(),
        ice: Vec::new(),
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
                            let names: Vec<_> = s.members.iter()
                                .map(|(_, m)| format!("{}{}", m.username.as_deref().unwrap_or("?"), if m.connected { "+" } else { "" }))
                                .collect();
                            println!("ROOM {id} members={}", names.join(","));
                        }
                    }
                    Update::Chat(c) => println!("CHAT {}: {}", if c.name.is_empty() { "*" } else { &c.name }, c.text),
                    Update::Notice(n) => println!("NOTICE {n}"),
                }
            }
            line = lines.next_line() => {
                match line? {
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
