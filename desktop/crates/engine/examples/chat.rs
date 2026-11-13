//! A headless client on the engine: `cargo run -p rtc-engine --example chat -- <ws url> <name> [room]`.
//! Without a room code it creates one. Its voice is a 440 Hz tone. Type a line to chat;
//! `/mute`, `/unmute`, `/deafen`, `/undeafen`, `/restart-audio`, `/quit` do what they say;
//! `/react 🔥` sends a reaction, `/sound quack` a soundboard clip, `/image <path> [caption]` a
//! chat picture. Pictures that arrive are reported with their size and FNV-1a 64 hash.
//! Watch party: `/watch <link>` plays a YouTube or link source for everyone, `/queue <link>
//! [title]` queues it, `/next`, `/skip` (vote), `/exit`; `/play <t>`, `/pause <t>`, `/seek <t>`
//! act as if someone used the player, `/file <size> <name>` plays a video file from this
//! computer (or our own copy of the room's), `/share <path>` plays and offers a real file,
//! `/stream <name>` streams the room's file from its owner (`STREAM_READ <bytes> <fnv>` when
//! read through), `/state <t> <playing>` reports where it is, `/ended` that it
//! finished. What the player is told prints as `PLAYER …`, the room's watch state as
//! `WATCH showing=<key|-> queue=<ids> votes=<names>`.
//! Used by the cross-app tests (desktop engine ↔ web app in Chromium): one line per event,
//! `ROOM <code> muted=<bool> speaking=<bool> members=<name>[+][~speaking][!muted],…`.

#![allow(clippy::print_stdout)]

use anyhow::{Context, bail};
use rtc_core::{Command, PlayerCmd, PlayerReport, UserAction, WatchCommand};
use rtc_engine::{Config, Handle, MicSource, OutgoingImage, Phase, Update};
use rtc_protocol::media::{Link, detect_link};
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
    let mut last_watch = String::new();
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
                            let w = format!(
                                "WATCH showing={} queue={} votes={}",
                                s.watch.showing.as_ref().map_or_else(|| "-".to_owned(), rtc_core::Showing::key),
                                s.watch.queue.iter().map(|q| q.title.as_str()).collect::<Vec<_>>().join("|"),
                                s.watch.skip_votes.join("|")
                            );
                            if w != last_watch {
                                println!("{w}");
                                last_watch = w;
                            }
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
                    Update::Player(c) => match c {
                        PlayerCmd::Open { showing, start, playing } => {
                            println!("PLAYER open {} t={start:.1} playing={playing}", showing.key());
                        }
                        PlayerCmd::Play { at, .. } => println!("PLAYER play t={:.1}", at.unwrap_or(-1.0)),
                        PlayerCmd::Pause { at, .. } => println!("PLAYER pause t={:.1}", at.unwrap_or(-1.0)),
                        PlayerCmd::Seek { to, drift, .. } => println!("PLAYER seek t={to:.1} drift={drift}"),
                        PlayerCmd::Close => println!("PLAYER close"),
                        PlayerCmd::Subtitles { name, vtt } => {
                            println!("PLAYER subtitles {name} {} cues", vtt.matches("-->").count());
                        }
                    },
                    Update::Pop => {}
                    Update::Log(l) => println!("LOG {l}"),
                    Update::StreamReady { name, size, reader } => {
                        println!("STREAM_READY {size} {name}");
                        // read it as a player would: the end first (an index), then front to back
                        std::thread::spawn(move || {
                            let started = std::time::Instant::now();
                            let mut buf = vec![0u8; 1 << 20];
                            let tail = size.saturating_sub(4096);
                            let _ = reader.read_at(tail, &mut buf[..4096]);
                            let mut pos = 0u64;
                            let mut hash = 0xcbf2_9ce4_8422_2325u64;
                            while pos < size {
                                match reader.read_at(pos, &mut buf) {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        hash = buf[..n].iter().fold(hash, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3));
                                        pos += n as u64;
                                    }
                                    Err(e) => {
                                        println!("STREAM_ERROR {e}");
                                        return;
                                    }
                                }
                            }
                            println!("STREAM_READ {pos} {hash:016x} {:.1}s", started.elapsed().as_secs_f64());
                        });
                    }
                    Update::StreamEnded(why) => println!("STREAM_ENDED {why}"),
                    Update::FileFormat { name, description } => println!("FILE_FORMAT {name}: {description}"),
                    Update::FileProblems(list) => println!("FILE_PROBLEMS {}", list.join(" | ")),
                    Update::Screen { sharer, mine, feed } => {
                        println!("SCREEN sharer={} mine={mine}", sharer.as_deref().unwrap_or("-"));
                        if let Some(feed) = feed.filter(|_| !mine) {
                            // shown at this size (RTC_SCREEN_TARGET=WxH): frames come scaled to it
                            if let Some((w, h)) = std::env::var("RTC_SCREEN_TARGET")
                                .ok()
                                .and_then(|t| t.split_once('x').map(|(w, h)| (w.parse().unwrap_or(0), h.parse().unwrap_or(0))))
                            {
                                feed.set_target(w, h);
                            }
                            // report the pictures as their size changes (for 30 s), and the stats
                            tokio::spawn(async move {
                                let mut last = (0, 0);
                                for i in 0..300 {
                                    if i % 10 == 9 {
                                        let st = feed.stats();
                                        println!("SCREEN_STATS {}x{} fps={}", st.width, st.height, st.fps);
                                    }
                                    if let (n, Some(f)) = feed.latest()
                                        && n > 5
                                        && (f.width, f.height) != last
                                    {
                                        last = (f.width, f.height);
                                        let lit = f.bgra.chunks(4).filter(|p| p[0] > 40 || p[1] > 40 || p[2] > 40).count();
                                        println!("SCREEN_FRAME {}x{} lit={lit}", f.width, f.height);
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                }
                            });
                        }
                    }
                    Update::ScreenPointer { name, x, y, active, .. } => println!("SCREEN_POINTER {name} {x:.2} {y:.2} {active}"),
                    Update::ScreenPing { name, x, y } => println!("SCREEN_PING {name} {x:.2} {y:.2}"),
                    Update::ScreenError(e) => println!("SCREEN_ERROR {e}"),
                    Update::ScreenSending { encoder, viewers } => {
                        let v: Vec<String> = viewers
                            .iter()
                            .map(|v| format!("{}:{}:{}:{}", v.name, v.height, if v.hardware { "hw" } else { "sw" }, if v.web { "web" } else { "desktop" }))
                            .collect();
                        println!("SCREEN_SENDING encoder={} viewers={}", encoder.as_deref().unwrap_or("-"), v.join(","));
                    }
                    Update::StreamProgress(_) | Update::Devices(_) | Update::Net(_) => {}
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
                    Some(l) if l.starts_with("/watch ") => match detect_link(&l["/watch ".len()..]) {
                        Ok(Link::YouTube(id)) => engine.command(Command::Watch(WatchCommand::PlayYouTube { id, title: "Test video".into() })),
                        Ok(Link::Media { media, .. }) => engine.command(Command::Watch(WatchCommand::PlayLink(media))),
                        Err(e) => println!("NOTICE {e}"),
                    },
                    Some(l) if l.starts_with("/queue ") => {
                        let rest = l["/queue ".len()..].trim();
                        let (link, title) = rest.split_once(' ').unwrap_or((rest, ""));
                        let (video_id, media) = match detect_link(link) {
                            Ok(Link::YouTube(id)) => (Some(id), None),
                            Ok(Link::Media { media, .. }) => (None, Some(media)),
                            Err(e) => {
                                println!("NOTICE {e}");
                                continue;
                            }
                        };
                        engine.command(Command::Watch(WatchCommand::QueueAdd {
                            id: Handle::new_message_id(),
                            video_id,
                            media,
                            title: title.to_owned(),
                            autoplay: true,
                        }));
                    }
                    Some(l) if l.starts_with("/file ") => {
                        // `/file <size> <name…>`: a video file from this computer (or our copy)
                        let rest = l["/file ".len()..].trim();
                        let (size, name) = rest.split_once(' ').unwrap_or(("0", rest));
                        engine.command(Command::Watch(WatchCommand::PlayFile {
                            name: name.to_owned(),
                            size: size.parse().unwrap_or(0),
                        }));
                    }
                    Some(l) if l.starts_with("/share ") => {
                        // `/share <path>`: play a file from this computer and offer it to viewers
                        let path = std::path::PathBuf::from(l["/share ".len()..].trim());
                        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        engine.command(Command::Watch(WatchCommand::PlayFile { name: name.clone(), size }));
                        engine.share_file(Some((path, name, size)));
                    }
                    Some(l) if l.starts_with("/stream ") => engine.stream_from(l["/stream ".len()..].trim().to_owned()),
                    Some(l) if l == "/unshare" => engine.share_file(None),
                    Some(l) if l.starts_with("/subs ") => {
                        // `/subs <path>`: share a subtitle file with the room
                        let path = l["/subs ".len()..].trim();
                        let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        if let Some(vtt) = std::fs::read_to_string(path).ok().and_then(|t| rtc_core::files::to_vtt(&name, &t)) {
                            engine.command(Command::Watch(WatchCommand::ShareSubtitles { name, vtt }));
                        }
                    }
                    Some(l) if l == "/stopstream" => engine.stop_stream(),
                    Some(l) if l == "/screens" => {
                        for s in rtc_engine::screen_sources() {
                            println!("SCREEN_SOURCE {} {} {}", s.id, s.window, s.title);
                        }
                    }
                    Some(l) if l == "/sharescreen" => {
                        let first = rtc_engine::screen_sources().into_iter().find(|s| !s.window);
                        if first.is_none() {
                            println!("SCREEN_ERROR no screen to share");
                        }
                        engine.share_screen(first);
                    }
                    Some(l) if l == "/stopscreen" => engine.share_screen(None),
                    Some(l) if l.starts_with("/screenopts") => {
                        // /screenopts <max height, 0 = native> <fps>
                        let v: Vec<u32> = l["/screenopts".len()..].split_whitespace().filter_map(|x| x.parse().ok()).collect();
                        engine.screen_options(rtc_engine::ScreenOptions {
                            max_height: v.first().copied().unwrap_or(0),
                            fps: v.get(1).copied().unwrap_or(60),
                        });
                    }
                    Some(l) if l.starts_with("/quality") => {
                        engine.screen_quality(l["/quality".len()..].trim().parse().unwrap_or(0));
                    }
                    Some(l) if l.starts_with("/pointer") => {
                        let v: Vec<f64> = l["/pointer".len()..].split_whitespace().filter_map(|x| x.parse().ok()).collect();
                        engine.screen_pointer((v.len() == 2).then(|| (v[0], v[1])));
                    }
                    Some(l) if l == "/next" => engine.command(Command::Watch(WatchCommand::QueueNext)),
                    Some(l) if l == "/skip" => engine.command(Command::Watch(WatchCommand::VoteSkip)),
                    Some(l) if l == "/exit" => engine.command(Command::Watch(WatchCommand::Exit)),
                    Some(l) if l == "/ended" => engine.command(Command::Watch(WatchCommand::Player(PlayerReport::Ended))),
                    Some(l) if l.starts_with("/play ") || l.starts_with("/pause ") || l.starts_with("/seek ") => {
                        let (verb, t) = l[1..].split_once(' ').unwrap_or(("", "0"));
                        let action = match verb {
                            "play" => UserAction::Play,
                            "pause" => UserAction::Pause,
                            _ => UserAction::Seek,
                        };
                        let time = t.trim().parse().unwrap_or(0.0);
                        engine.command(Command::Watch(WatchCommand::Player(PlayerReport::User { action, time })));
                    }
                    Some(l) if l.starts_with("/state ") => {
                        let mut it = l["/state ".len()..].split_whitespace();
                        let time = it.next().and_then(|t| t.parse().ok()).unwrap_or(0.0);
                        let playing = it.next() == Some("true");
                        engine.command(Command::Watch(WatchCommand::Player(PlayerReport::State {
                            time,
                            playing,
                            buffering: false,
                            duration: 0.0,
                        })));
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
