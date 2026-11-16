//! Connection details (`NetworkDiagnosticsModal.tsx`, `hooks/useNetworkStats.ts`,
//! `utils/networkMonitor.ts`), without the stream doctor: each connection's round trip, path,
//! loss, jitter and data rates, refreshed every 2.5 s while open, and a report to copy.

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::{
    AnyElement, ClipboardItem, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use rtc_engine::NetPeer;
use rtc_protocol::PeerId;
use rtc_ui::button::{Button, Variant};
use rtc_ui::{Icon, icon, tokens};

use crate::view::{Dialog, RoomView};

/// How often the details refresh (`PING_INTERVAL_MS`).
const EVERY: Duration = Duration::from_millis(2500);
/// Round trips kept for the graph (`MAX_HISTORY_SAMPLES`).
const HISTORY: usize = 15;

/// Tabs in the network diagnostics dialog.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub(crate) enum NetTab {
    #[default]
    Hud,
    Topology,
}

/// Visualization modes for the Topology & Technical Distance Map.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub(crate) enum ViewMode {
    #[default]
    Graph,
    Radar,
    Matrix,
}

/// Radar center perspective.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub(crate) enum Perspective {
    #[default]
    Host,
    Me,
}

/// What the dialog shows.
#[derive(Default)]
pub(crate) struct NetState {
    pub(crate) peers: Vec<NetPeer>,
    pub(crate) tab: NetTab,
    pub(crate) view_mode: ViewMode,
    pub(crate) perspective: Perspective,
    pub(crate) selected_peer: Option<PeerId>,
    history: HashMap<PeerId, Vec<f64>>,
    ticker: Option<gpui_kit::Task<()>>,
    copied: bool,
}

/// A grade for a round trip and loss (`getNetworkHealthGrade`): label, colour, grade.
pub(crate) fn grade(ping_ms: Option<f64>, loss: f64) -> (&'static str, Hsla, &'static str) {
    match ping_ms {
        None => ("Connecting", tokens::sfx_muted(), "?"),
        Some(p) if p <= 50.0 && loss < 1.0 => ("Excellent", tokens::net_excellent(), "A+"),
        Some(p) if p <= 100.0 && loss < 3.0 => ("Good", tokens::net_good(), "A"),
        Some(p) if p <= 180.0 && loss < 8.0 => ("Fair", tokens::net_fair(), "B"),
        Some(_) => ("Poor / High Latency", tokens::net_poor(), "C"),
    }
}

/// Technical distance evaluation matching the web app.
pub(crate) fn technical_distance(
    rtt_ms: f64,
    conn_type: &str,
    loss_pct: f64,
    jitter_ms: f64,
) -> (u32, &'static str, Hsla) {
    let is_lan = conn_type.contains("LAN") || conn_type.contains("host");
    let is_relay = conn_type.contains("Relay") || conn_type.contains("relay");

    let multiplier = if is_relay {
        2.5
    } else if is_lan {
        0.8
    } else {
        1.0
    };
    let penalty = (loss_pct * 15.0) + (jitter_ms * 0.5);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let score = ((rtt_ms * multiplier + penalty).max(1.0).round()) as u32;

    if is_lan || score < 15 {
        (score, "⚡ LAN", tokens::net_excellent())
    } else if score < 50 {
        (score, "🟢 Near", tokens::net_excellent())
    } else if score < 120 {
        (score, "🟡 Medium", tokens::net_good())
    } else if score < 250 && !is_relay {
        (score, "🟠 Far", tokens::net_fair())
    } else {
        (score, "🔴 Distant", tokens::net_poor())
    }
}

/// The summary over everyone: average, min and max round trip, total rates, worst loss.
struct Summary {
    avg: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
    down: f64,
    up: f64,
    loss: f64,
    relay: bool,
}

fn summary(peers: &[NetPeer]) -> Summary {
    let pings: Vec<f64> = peers.iter().filter_map(|p| p.net.rtt_ms).collect();
    #[allow(clippy::cast_precision_loss)]
    let avg = (!pings.is_empty()).then(|| (pings.iter().sum::<f64>() / pings.len() as f64).round());
    Summary {
        avg,
        min: pings.iter().copied().reduce(f64::min).map(f64::round),
        max: pings.iter().copied().reduce(f64::max).map(f64::round),
        down: peers.iter().map(|p| p.down_kbps).sum(),
        up: peers.iter().map(|p| p.up_kbps).sum(),
        loss: peers.iter().map(|p| p.net.loss_percent()).fold(0.0, f64::max),
        relay: peers.iter().any(|p| p.net.connection_type() == "Relay (TURN)"),
    }
}

impl RoomView {
    /// Opens the details and keeps them fresh while open.
    pub(crate) fn open_net(&mut self, cx: &mut Context<'_, Self>) {
        self.open_dialog(Dialog::Network, cx);
        self.net.copied = false;
        if let Some(e) = &self.engine {
            e.net_stats();
        }
        self.net.ticker = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(EVERY).await;
                let Ok(true) = this.update(cx, |v, _| {
                    let open = v.dialog == Some(Dialog::Network);
                    if open && let Some(e) = &v.engine {
                        e.net_stats();
                    }
                    if !open {
                        v.net.ticker = None;
                    }
                    open
                }) else {
                    break;
                };
            }
        }));
    }

    /// "Ping Now".
    pub(crate) fn ping_now(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(e) = &self.engine {
            e.net_stats();
        }
        self.show_toast("Ping probe sent to mesh peers", cx);
    }

    /// New details from the engine.
    pub(crate) fn on_net(&mut self, peers: Vec<NetPeer>) {
        for p in &peers {
            if let Some(rtt) = p.net.rtt_ms {
                let h = self.net.history.entry(p.peer.clone()).or_default();
                h.push(rtt.round());
                if h.len() > HISTORY {
                    h.remove(0);
                }
            }
        }
        self.net.history.retain(|k, _| peers.iter().any(|p| p.peer == *k));
        self.net.peers = peers;
    }

    fn name_of(&self, peer: &PeerId) -> String {
        self.room
            .as_ref()
            .and_then(|r| r.members.iter().find(|(p, _)| p == peer))
            .and_then(|(_, m)| m.username.clone())
            .unwrap_or_else(|| peer.as_str().chars().take(6).collect())
    }

    /// The Markdown report (`generateDiagnosticReport`).
    fn report(&self) -> String {
        let s = summary(&self.net.peers);
        let room = self.in_room().map_or_else(|| "N/A".to_owned(), |r| r.to_string());
        let name = if self.settings.username.is_empty() {
            "Anonymous"
        } else {
            &self.settings.username
        };
        let ms = |v: Option<f64>| v.map_or_else(|| "N/A".to_owned(), |v| format!("{v} ms"));
        let mut md = String::from("# 3RTC WebRTC P2P Network Diagnostic Report\n");
        md += &format!(
            "- **Generated:** {}\n",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")
        );
        md += &format!("- **Room ID:** {room}\n");
        md += &format!("- **Local Client:** {name}\n");
        md += &format!("- **Connected Peers:** {}\n", self.net.peers.len());
        md += &format!(
            "- **Overall Connection:** {}\n",
            if s.relay { "Relay (TURN)" } else { "Direct P2P" }
        );
        md += &format!("- **Average Latency:** {}\n", ms(s.avg));
        md += &format!(
            "- **Min / Max Latency:** {} ms / {} ms\n",
            s.min.unwrap_or(0.0),
            s.max.unwrap_or(0.0)
        );
        md += &format!(
            "- **Total Throughput:** ↓ {:.1} KB/s | ↑ {:.1} KB/s\n",
            s.down, s.up
        );
        md += "- **Video Sync Drift:** In Sync (<20ms)\n\n";
        md += "## Peer Connections Breakdown\n";
        if self.net.peers.is_empty() {
            md += "_No active peer connections in current session._\n";
        }
        for (i, p) in self.net.peers.iter().enumerate() {
            let n = &p.net;
            let hist = self.net.history.get(&p.peer);
            #[allow(clippy::cast_precision_loss)]
            let avg = hist
                .filter(|h| !h.is_empty())
                .map(|h| (h.iter().sum::<f64>() / h.len() as f64).round());
            md += &format!("### Peer #{}: {}\n", i + 1, self.name_of(&p.peer));
            md += &format!("- **Peer ID:** `{}`\n", p.peer);
            md += &format!("- **Connection Mode:** {}\n", n.connection_type());
            md += &format!("- **Protocol:** {}\n", n.protocol);
            md += &format!(
                "- **RTT (Ping):** {} ms (Avg: {} ms)\n",
                n.rtt_ms
                    .map_or_else(|| "N/A".to_owned(), |v| format!("{}", v.round())),
                avg.map_or_else(|| "N/A".to_owned(), |v| v.to_string())
            );
            md += &format!("- **Packet Loss:** {}%\n", n.loss_percent());
            md += &format!("- **Audio Jitter:** {:.1} ms\n", n.jitter_ms);
            md += &format!("- **Bandwidth:** ↓ {} KB/s | ↑ {} KB/s\n", p.down_kbps, p.up_kbps);
            md += &format!("- **Local Candidate:** {} (hidden)\n", n.local_type);
            md += &format!("- **Remote Candidate:** {} (hidden)\n\n", n.remote_type);
        }
        md
    }

    pub(crate) fn copy_report(&mut self, cx: &mut Context<'_, Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(self.report()));
        self.net.copied = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(2200)).await;
            let _ = this.update(cx, |v, cx| {
                v.net.copied = false;
                cx.notify();
            });
        })
        .detach();
    }
}

fn tile(
    label: &'static str,
    tag: Option<(String, Hsla)>,
    value: AnyElement,
    sub: String,
) -> impl IntoElement {
    div()
        .flex_1()
        .min_w_0()
        .p(px(14.))
        .rounded(px(14.))
        .bg(tokens::bg())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(
            div()
                .flex()
                .flex_wrap()
                .justify_between()
                .gap_x(px(6.))
                .child(
                    div()
                        .text_size(px(10.5))
                        .font_weight(FontWeight::BOLD)
                        .text_color(tokens::text_3())
                        .child(label),
                )
                .when_some(tag, |el, (t, c)| {
                    el.child(
                        div()
                            .text_size(px(10.5))
                            .font_weight(FontWeight::BOLD)
                            .text_color(c)
                            .child(t),
                    )
                }),
        )
        .child(value)
        .child(div().text_size(px(11.5)).text_color(tokens::text_2()).child(sub))
}

fn big(text: String, color: Hsla, unit: Option<&'static str>) -> AnyElement {
    div()
        .flex()
        .items_end()
        .gap(px(4.))
        .child(
            div()
                .text_size(px(22.))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(color)
                .whitespace_nowrap()
                .child(text),
        )
        .when_some(unit, |el, u| {
            el.child(
                div()
                    .pb(px(3.))
                    .text_size(px(12.))
                    .text_color(tokens::text_2())
                    .child(u),
            )
        })
        .into_any_element()
}

/// The latency graph: one bar per sample, the newest bright.
fn graph(samples: &[f64]) -> AnyElement {
    if samples.len() < 2 {
        return div()
            .h(px(60.))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(12.))
            .text_color(tokens::text_3())
            .child("Collecting latency samples...")
            .into_any_element();
    }
    let min = samples.iter().copied().fold(f64::MAX, f64::min);
    let max = samples.iter().copied().fold(f64::MIN, f64::max);
    let range = (max - min).max(10.0);
    let last = samples.len() - 1;
    div()
        .h(px(60.))
        .flex()
        .items_end()
        .gap(px(4.))
        .children(samples.iter().enumerate().map(|(i, v)| {
            #[allow(clippy::cast_possible_truncation)]
            let h = (6.0 + (v - min) / range * 48.0) as f32;
            div().flex_1().h(px(h)).rounded_t(px(3.)).bg(if i == last {
                tokens::net_excellent()
            } else {
                Hsla {
                    a: 0.6,
                    ..tokens::net_good()
                }
            })
        }))
        .into_any_element()
}

/// The dialog.
pub(crate) fn dialog(view: &RoomView, cx: &mut Context<'_, RoomView>) -> AnyElement {
    let s = summary(&view.net.peers);
    let (label, color, _) = grade(s.avg, s.loss);
    div()
        .flex()
        .flex_col()
        .gap(px(14.))
        .p(px(20.))
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(12.))
                .child(
                    div()
                        .size(px(40.))
                        .rounded(px(12.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(Hsla {
                            a: 0.15,
                            ..tokens::net_good()
                        })
                        .child(icon(Icon::Signal, px(20.), tokens::net_good())),
                )
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .text_size(px(18.))
                                        .font_weight(FontWeight::BOLD)
                                        .child("P2P Network Diagnostics HUD"),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .px(px(8.))
                                        .py(px(2.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(Hsla { a: 0.33, ..color })
                                        .text_color(color)
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(div().size(px(7.)).rounded_full().bg(color))
                                        .child(label),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(12.5))
                                .text_color(tokens::text_2())
                                .child("Real-time WebRTC mesh telemetry, candidate pairs & sync metrics"),
                        ),
                )
                .child(
                    div()
                        .id("net-close")
                        .size(px(32.))
                        .rounded(px(8.))
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
        // Tabs Navigation
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .border_b_1()
                .border_color(tokens::line())
                .pb(px(8.))
                .child(
                    div()
                        .id("tab-hud")
                        .px(px(14.))
                        .py(px(6.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .bg(if view.net.tab == NetTab::Hud {
                            tokens::raised()
                        } else {
                            gpui_kit::transparent_black()
                        })
                        .text_color(if view.net.tab == NetTab::Hud {
                            tokens::net_good()
                        } else {
                            tokens::text_2()
                        })
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.net.tab = NetTab::Hud;
                            cx.notify();
                        }))
                        .child("📊 Telemetry HUD"),
                )
                .child(
                    div()
                        .id("tab-topo")
                        .px(px(14.))
                        .py(px(6.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .bg(if view.net.tab == NetTab::Topology {
                            tokens::raised()
                        } else {
                            gpui_kit::transparent_black()
                        })
                        .text_color(if view.net.tab == NetTab::Topology {
                            tokens::net_good()
                        } else {
                            tokens::text_2()
                        })
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(|v, _, _, cx| {
                            v.net.tab = NetTab::Topology;
                            cx.notify();
                        }))
                        .child("🗺️ Topology & Technical Distance Map"),
                ),
        )
        .child(match view.net.tab {
            NetTab::Hud => hud_view(view, cx).into_any_element(),
            NetTab::Topology => topology_view(view, cx).into_any_element(),
        })
        .into_any_element()
}

fn room_capacity_advisor_card(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let room = view.room.as_ref();
    let is_host = room.and_then(|r| r.host.as_ref()) == room.map(|r| &r.me);
    let is_hub = room.is_some_and(|r| r.topology == "hub");
    let current_max = room.map(|r| r.max_users).unwrap_or(if is_hub { 32 } else { 4 });

    let s = summary(&view.net.peers);
    let down_kbps = s.down;
    let up_kbps = s.up;
    let down_mbps = (down_kbps * 8.0) / 1024.0;
    let up_mbps = (up_kbps * 8.0) / 1024.0;
    let est_down_mbps = down_mbps.max(15.0);
    let est_up_mbps = if up_mbps > 0.5 { up_mbps.max(6.0) } else { 10.0 };

    let rec_peers: u32 = if is_hub {
        if est_up_mbps < 8.0 {
            6
        } else if est_up_mbps < 15.0 {
            8
        } else if est_up_mbps < 25.0 {
            12
        } else if est_up_mbps < 45.0 {
            18
        } else if est_up_mbps < 80.0 {
            25
        } else {
            (est_up_mbps / 2.2).floor() as u32 + 2
        }
    } else if est_up_mbps >= 12.0 {
        6
    } else {
        4
    };

    let suggestion = if is_hub {
        format!(
            "Based on your ~{est_up_mbps:.1} Mbps upload & ~{est_down_mbps:.1} Mbps download, ~{rec_peers} peers can join smoothly in Hub mode."
        )
    } else {
        format!("Mesh mode is best for ~{rec_peers} peers. Switch to Hub (HStar) mode for larger rooms.")
    };

    div()
        .p(px(16.))
        .rounded(px(12.))
        .bg(tokens::surface())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight::BOLD)
                                .text_color(tokens::text())
                                .child("⚡ Room Peer Capacity & Dynamic Advisor"),
                        )
                        .child(
                            div()
                                .px(px(8.))
                                .py(px(2.))
                                .rounded_full()
                                .bg(if is_hub {
                                    Hsla {
                                        a: 0.25,
                                        ..tokens::focus()
                                    }
                                } else {
                                    Hsla {
                                        a: 0.15,
                                        ..tokens::accent()
                                    }
                                })
                                .text_color(if is_hub { tokens::focus() } else { tokens::accent() })
                                .text_size(px(11.))
                                .font_weight(FontWeight::BOLD)
                                .child(if is_hub {
                                    "⭐ Host Hub Mode"
                                } else {
                                    "🕸️ Full Mesh"
                                }),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child(format!("⬇️ Avg Down: {est_down_mbps:.1} Mbps"))
                        .child(format!("⬆️ Avg Up: {est_up_mbps:.1} Mbps")),
                ),
        )
        .child(
            div()
                .p(px(10.))
                .rounded(px(8.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Max Room Peers:"),
                        )
                        .when(is_host, |el| {
                            el.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(
                                        Button::new("peer-dec", "-")
                                            .min_height(px(26.))
                                            .padding_x(px(8.))
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                let next = current_max.saturating_sub(1).max(2);
                                                v.command(rtc_core::Command::SetRoomSize(next));
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        div()
                                            .w(px(36.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(tokens::accent())
                                            .text_size(px(14.))
                                            .child(current_max.to_string()),
                                    )
                                    .child(
                                        Button::new("peer-inc", "+")
                                            .min_height(px(26.))
                                            .padding_x(px(8.))
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                let next = current_max + 1;
                                                v.command(rtc_core::Command::SetRoomSize(next));
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(tokens::text_3())
                                            .ml(px(6.))
                                            .child("Presets:"),
                                    )
                                    .children([4u32, 8, 12, 16, 24, 32, 50].into_iter().map(|preset| {
                                        let active = current_max == preset;
                                        Button::new(format!("preset-{preset}"), preset.to_string())
                                            .min_height(px(24.))
                                            .padding_x(px(8.))
                                            .font_size(px(11.))
                                            .variant(if active { Variant::Primary } else { Variant::Ghost })
                                            .on_click(cx.listener(move |v, _, _, cx| {
                                                v.command(rtc_core::Command::SetRoomSize(preset));
                                                cx.notify();
                                            }))
                                    })),
                            )
                        })
                        .when(!is_host, |el| {
                            el.child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(tokens::accent())
                                    .child(format!("{current_max} peers (Host managed)")),
                            )
                        }),
                )
                .when(is_host && current_max != rec_peers, |el| {
                    el.child(
                        Button::new("apply-rec", format!("Apply Recommended: {rec_peers} Peers"))
                            .min_height(px(26.))
                            .padding_x(px(10.))
                            .font_size(px(11.5))
                            .variant(Variant::Primary)
                            .on_click(cx.listener(move |v, _, _, cx| {
                                v.command(rtc_core::Command::SetRoomSize(rec_peers));
                                cx.notify();
                            })),
                    )
                }),
        )
        .child(
            div()
                .p(px(10.))
                .rounded(px(8.))
                .bg(Hsla {
                    a: 0.1,
                    ..tokens::accent()
                })
                .border_1()
                .border_color(Hsla {
                    a: 0.25,
                    ..tokens::accent()
                })
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text())
                        .child(format!("💡 {suggestion}")),
                )
                .when(is_host && !is_hub && rec_peers > 4, |el| {
                    el.child(
                        Button::new("hud-switch-hub", "Switch to Hub Mode")
                            .min_height(px(24.))
                            .padding_x(px(8.))
                            .font_size(px(11.))
                            .variant(Variant::Secondary)
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.command(rtc_core::Command::SetTopology("hub".to_owned()));
                                cx.notify();
                            })),
                    )
                }),
        )
}

fn hud_view(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let s = summary(&view.net.peers);
    let (_, color, g) = grade(s.avg, s.loss);
    let first = view
        .net
        .peers
        .first()
        .and_then(|p| view.net.history.get(&p.peer))
        .cloned()
        .unwrap_or_default();
    let fmt = |v: f64| format!("{v:.1}").trim_end_matches(".0").to_owned();
    div()
        .flex()
        .flex_col()
        .gap(px(14.))
        .child(room_capacity_advisor_card(view, cx))
        .child(
            div()
                .flex()
                .gap(px(10.))
                .child(tile(
                    "RTT LATENCY (PING)",
                    Some((g.to_owned(), color)),
                    big(
                        s.avg.map_or_else(|| "--".to_owned(), |v| v.to_string()),
                        color,
                        Some("ms"),
                    ),
                    format!(
                        "Min: {}ms • Max: {}ms",
                        s.min.map_or_else(|| "--".to_owned(), |v| v.to_string()),
                        s.max.map_or_else(|| "--".to_owned(), |v| v.to_string())
                    ),
                ))
                .child(tile(
                    "CONNECTION MODE",
                    Some(("DIRECT MESH".to_owned(), tokens::net_excellent())),
                    big(
                        (if s.relay { "Relay (TURN)" } else { "Direct P2P" }).to_owned(),
                        tokens::text(),
                        None,
                    ),
                    "Zero Relay Servers • Full Mesh".to_owned(),
                ))
                .child(tile(
                    "PLAYBACK SYNC DRIFT",
                    None,
                    big("—".to_owned(), tokens::text(), None),
                    "No video playing".to_owned(),
                ))
                .child(tile(
                    "NETWORK BANDWIDTH",
                    Some(("LIVE".to_owned(), tokens::text_2())),
                    big(format!("↓ {}", fmt(s.down)), tokens::text(), Some("KB/s")),
                    format!("↑ {} KB/s Outbound", fmt(s.up)),
                )),
        )
        .child(
            div()
                .p(px(14.))
                .rounded(px(14.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::BOLD)
                                        .child("Rolling Latency Sparkline"),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.5))
                                        .text_color(tokens::text_3())
                                        .child("Last 15 RTT Probe Samples"),
                                ),
                        )
                        .child(
                            Button::new("ping-now", "Ping Now")
                                .min_height(px(30.))
                                .font_size(px(12.5))
                                .on_click(cx.listener(|v, _, _, cx| v.ping_now(cx))),
                        ),
                )
                .child(graph(&first)),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::BOLD)
                                .child(format!("Connected Peers Telemetry ({})", view.net.peers.len())),
                        )
                        .child(
                            div()
                                .text_size(px(11.5))
                                .text_color(tokens::text_3())
                                .child("Individual WebRTC PeerConnection stats"),
                        ),
                )
                .when(view.net.peers.is_empty(), |el| {
                    el.child(
                        div()
                            .p(px(14.))
                            .rounded(px(12.))
                            .bg(tokens::bg())
                            .text_size(px(13.))
                            .text_color(tokens::text_2())
                            .child("Waiting for room peers to connect direct P2P mesh..."),
                    )
                })
                .children(view.net.peers.iter().map(|p| {
                    let n = &p.net;
                    let (_, pc, _) = grade(n.rtt_ms, n.loss_percent());
                    let (dist_score, dist_label, dist_col) = technical_distance(
                        n.rtt_ms.unwrap_or(50.0),
                        n.connection_type(),
                        n.loss_percent(),
                        n.jitter_ms,
                    );
                    let cell = |k: &'static str, v: String| {
                        div()
                            .flex()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .child(div().text_color(tokens::text_3()).child(k))
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(v))
                    };
                    div()
                        .p(px(12.))
                        .rounded(px(12.))
                        .bg(tokens::bg())
                        .border_1()
                        .border_color(tokens::line())
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
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(view.name_of(&p.peer)),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(tokens::text_3())
                                        .font_family(tokens::FONT_MONO)
                                        .child(format!(
                                            "ID: {}",
                                            p.peer.as_str().chars().take(8).collect::<String>()
                                        )),
                                )
                                .child(
                                    div()
                                        .px(px(7.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(Hsla { a: 0.27, ..pc })
                                        .text_color(pc)
                                        .text_size(px(11.))
                                        .child(n.connection_type()),
                                )
                                .child(
                                    div()
                                        .px(px(7.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(Hsla { a: 0.35, ..dist_col })
                                        .text_color(dist_col)
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(format!("Dist: {dist_score} ({dist_label})")),
                                )
                                .child(div().flex_1())
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.))
                                        .text_color(pc)
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(div().size(px(7.)).rounded_full().bg(pc))
                                        .child(n.rtt_ms.map_or_else(
                                            || "Probing...".to_owned(),
                                            |v| format!("{} ms", v.round()),
                                        )),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_x(px(18.))
                                .gap_y(px(4.))
                                .child(cell("Packet Loss:", format!("{}%", n.loss_percent())))
                                .child(cell("Audio Jitter:", format!("{:.1} ms", n.jitter_ms)))
                                .child(cell("Protocol:", n.protocol.clone()))
                                .child(cell(
                                    "Data Rate:",
                                    format!("↓ {} KB/s ↑ {} KB/s", p.down_kbps, p.up_kbps),
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .text_size(px(11.5))
                                .text_color(tokens::text_2())
                                .child("ICE Pair:")
                                .child(format!("Local: {}", n.local_type))
                                .child("↔")
                                .child(format!("Remote: {}", n.remote_type)),
                        )
                })),
        )
        .child(
            div()
                .flex()
                .justify_between()
                .pt(px(4.))
                .child(
                    Button::new(
                        "net-copy",
                        if view.net.copied {
                            "✓ Report Copied!"
                        } else {
                            "Copy Diagnostic Report"
                        },
                    )
                    .min_height(px(38.))
                    .on_click(cx.listener(|v, _, _, cx| v.copy_report(cx))),
                )
                .child(
                    Button::new("net-done", "Done")
                        .variant(Variant::Primary)
                        .min_height(px(38.))
                        .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                ),
        )
        .into_any_element()
}

fn topology_view(view: &RoomView, cx: &mut Context<'_, RoomView>) -> impl IntoElement {
    let room = view.room.as_ref();
    let is_hub = room.is_some_and(|r| r.topology == "hub");
    let is_host = room.and_then(|r| r.host.as_ref()) == room.map(|r| &r.me);
    let my_name = room
        .map(|r| {
            if r.username.is_empty() {
                "You".to_owned()
            } else {
                r.username.clone()
            }
        })
        .unwrap_or_else(|| "You".to_owned());
    let host_name = room
        .and_then(|r| {
            r.host.as_ref().map(|h| {
                if h == &r.me {
                    format!("{my_name} (You)")
                } else {
                    view.name_of(h)
                }
            })
        })
        .unwrap_or_else(|| "Host".to_owned());

    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        // Header & Mode Bar
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .flex_wrap()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::BOLD)
                                        .text_color(tokens::text())
                                        .child("NETWORK TOPOLOGY & TECHNICAL DISTANCE MAP"),
                                )
                                .child(
                                    div()
                                        .px(px(8.))
                                        .py(px(2.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(if is_hub {
                                            tokens::sfx_purple()
                                        } else {
                                            tokens::net_good()
                                        })
                                        .bg(Hsla {
                                            a: 0.15,
                                            ..(if is_hub {
                                                tokens::sfx_purple()
                                            } else {
                                                tokens::net_good()
                                            })
                                        })
                                        .text_color(if is_hub {
                                            tokens::sfx_lilac()
                                        } else {
                                            tokens::net_good()
                                        })
                                        .text_size(px(11.5))
                                        .font_weight(FontWeight::BOLD)
                                        .child(if is_hub {
                                            "⭐ Host Hub Topology"
                                        } else {
                                            "🕸️ Full Mesh Topology"
                                        }),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(11.5))
                                .text_color(tokens::text_3())
                                .child("Real-time peer technical distance computed from RTT latency, packet loss, audio jitter & ICE candidate path"),
                        ),
                )
                // Controls: Mode selector & Hub toggle
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        // View mode selector
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .p(px(2.))
                                .rounded(px(8.))
                                .bg(tokens::bg())
                                .border_1()
                                .border_color(tokens::line())
                                .child(
                                    div()
                                        .id("btn-mode-graph")
                                        .px(px(8.))
                                        .py(px(4.))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .text_size(px(11.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .bg(if view.net.view_mode == ViewMode::Graph {
                                            tokens::raised()
                                        } else {
                                            gpui_kit::transparent_black()
                                        })
                                        .text_color(if view.net.view_mode == ViewMode::Graph {
                                            tokens::net_good()
                                        } else {
                                            tokens::text_2()
                                        })
                                        .on_click(cx.listener(|v, _, _, cx| {
                                            v.net.view_mode = ViewMode::Graph;
                                            cx.notify();
                                        }))
                                        .child("🕸️ Graph"),
                                )
                                .child(
                                    div()
                                        .id("btn-mode-radar")
                                        .px(px(8.))
                                        .py(px(4.))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .text_size(px(11.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .bg(if view.net.view_mode == ViewMode::Radar {
                                            tokens::raised()
                                        } else {
                                            gpui_kit::transparent_black()
                                        })
                                        .text_color(if view.net.view_mode == ViewMode::Radar {
                                            tokens::net_good()
                                        } else {
                                            tokens::text_2()
                                        })
                                        .on_click(cx.listener(|v, _, _, cx| {
                                            v.net.view_mode = ViewMode::Radar;
                                            cx.notify();
                                        }))
                                        .child("🎯 Radar"),
                                )
                                .child(
                                    div()
                                        .id("btn-mode-matrix")
                                        .px(px(8.))
                                        .py(px(4.))
                                        .rounded(px(6.))
                                        .cursor_pointer()
                                        .text_size(px(11.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .bg(if view.net.view_mode == ViewMode::Matrix {
                                            tokens::raised()
                                        } else {
                                            gpui_kit::transparent_black()
                                        })
                                        .text_color(if view.net.view_mode == ViewMode::Matrix {
                                            tokens::net_good()
                                        } else {
                                            tokens::text_2()
                                        })
                                        .on_click(cx.listener(|v, _, _, cx| {
                                            v.net.view_mode = ViewMode::Matrix;
                                            cx.notify();
                                        }))
                                        .child("📊 Matrix"),
                                ),
                        )
                        // Host Hub Switcher (or status badge for guests)
                        .child(if is_host {
                            Button::new(
                                "switch-topology",
                                if is_hub {
                                    "Switch to 🕸️ Full Mesh"
                                } else {
                                    "Switch to ⭐ Host Hub"
                                },
                            )
                            .variant(if is_hub {
                                Variant::Secondary
                            } else {
                                Variant::Primary
                            })
                            .min_height(px(28.))
                            .font_size(px(11.5))
                            .on_click(cx.listener(move |v, _, _, cx| {
                                let next = if is_hub { "mesh" } else { "hub" };
                                v.command(rtc_core::Command::SetTopology(next.to_owned()));
                                cx.notify();
                            }))
                            .into_any_element()
                        } else {
                            div()
                                .px(px(10.))
                                .py(px(4.))
                                .rounded(px(6.))
                                .bg(tokens::bg())
                                .border_1()
                                .border_color(tokens::line())
                                .text_size(px(11.5))
                                .text_color(tokens::text_3())
                                .child(if is_hub {
                                    "⭐ Hub managed by Host"
                                } else {
                                    "🕸️ Full Mesh active"
                                })
                                .into_any_element()
                        }),
                ),
        )
        // Radar Perspective Switcher
        .when(view.net.view_mode == ViewMode::Radar, |el| {
            el.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(12.))
                    .text_color(tokens::text_2())
                    .child("Radar Center Perspective:")
                    .child(
                        div()
                            .id("btn-persp-host")
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .bg(if view.net.perspective == Perspective::Host {
                                tokens::focus()
                            } else {
                                tokens::bg()
                            })
                            .text_color(if view.net.perspective == Perspective::Host {
                                tokens::white()
                            } else {
                                tokens::text_2()
                            })
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.net.perspective = Perspective::Host;
                                cx.notify();
                            }))
                            .child("👑 Host Perspective"),
                    )
                    .child(
                        div()
                            .id("btn-persp-me")
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(4.))
                            .cursor_pointer()
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .bg(if view.net.perspective == Perspective::Me {
                                tokens::focus()
                            } else {
                                tokens::bg()
                            })
                            .text_color(if view.net.perspective == Perspective::Me {
                                tokens::white()
                            } else {
                                tokens::text_2()
                            })
                            .on_click(cx.listener(|v, _, _, cx| {
                                v.net.perspective = Perspective::Me;
                                cx.notify();
                            }))
                            .child("👤 My Perspective"),
                    ),
            )
        })
        // View content
        .child(match view.net.view_mode {
            ViewMode::Graph => graph_view(view, is_hub, &host_name, &my_name, cx),
            ViewMode::Radar => radar_view(view, is_hub, &host_name, &my_name),
            ViewMode::Matrix => matrix_view(view, is_hub, is_host, &my_name),
        })
        // Bottom actions
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(14.))
                .pt(px(10.))
                .border_t_1()
                .border_color(tokens::line())
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(12.))
                        .text_color(tokens::text_3())
                        .child(if is_hub {
                            "⭐ Host Hub: Centralized star relay minimizes guest bandwidth & optimizes movie sync."
                        } else {
                            "🕸️ Full Mesh: Decentralized P2P connects all peers directly with zero server overhead."
                        }),
                )
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            Button::new(
                                "net-copy-topo",
                                if view.net.copied {
                                    "✓ Report Copied!"
                                } else {
                                    "Copy Diagnostic Report"
                                },
                            )
                            .min_height(px(34.))
                            .font_size(px(12.5))
                            .on_click(cx.listener(|v, _, _, cx| v.copy_report(cx))),
                        )
                        .child(
                            Button::new("net-done-topo", "Done")
                                .variant(Variant::Primary)
                                .min_height(px(34.))
                                .font_size(px(12.5))
                                .on_click(cx.listener(|v, _, _, cx| v.close_dialog(cx))),
                        ),
                ),
        )
}

fn graph_view(
    view: &RoomView,
    is_hub: bool,
    host_name: &str,
    _my_name: &str,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let peers = &view.net.peers;
    let selected_peer_id = view
        .net
        .selected_peer
        .as_ref()
        .or_else(|| peers.first().map(|p| &p.peer));
    let selected = peers.iter().find(|p| Some(&p.peer) == selected_peer_id);

    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .p(px(14.))
                .rounded(px(12.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .flex_col()
                .gap(px(12.))
                .when(is_hub, |el| {
                    el.child(
                        div()
                            .p(px(12.))
                            .rounded(px(10.))
                            .border_1()
                            .border_color(tokens::sfx_purple())
                            .bg(Hsla { a: 0.08, ..tokens::sfx_purple() })
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .size(px(36.))
                                            .rounded_full()
                                            .bg(tokens::sfx_purple())
                                            .text_color(tokens::white())
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .text_size(px(16.))
                                            .child("👑"),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .flex_col()
                                            .child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(6.))
                                                    .child(
                                                        div()
                                                            .text_size(px(14.))
                                                            .font_weight(FontWeight::BOLD)
                                                            .child(host_name.to_owned()),
                                                    )
                                                    .child(
                                                        div()
                                                            .px(px(6.))
                                                            .py(px(1.))
                                                            .rounded_full()
                                                            .bg(tokens::sfx_purple())
                                                            .text_color(tokens::white())
                                                            .text_size(px(10.))
                                                            .font_weight(FontWeight::BOLD)
                                                            .child("HUB RELAY"),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(11.5))
                                                    .text_color(tokens::text_2())
                                                    .child("Central Media & Signaling Star Router • Zero Server Fees"),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_end()
                                    .child(
                                        div()
                                            .text_size(px(11.5))
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(tokens::live())
                                            .child("⚡ Active Hub"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(tokens::text_3())
                                            .child(format!("{} connected peers", peers.len())),
                                    ),
                            ),
                    )
                })
                .when(!is_hub, |el| {
                    el.child(
                        div()
                            .p(px(10.))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(tokens::line())
                            .bg(tokens::panel())
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(icon(Icon::Signal, px(16.), tokens::net_good()))
                                    .child(
                                        div()
                                            .text_size(px(12.5))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(tokens::text())
                                            .child("Decentralized Full Mesh: Direct P2P tunnel to each participant"),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(tokens::text_3())
                                    .child(format!("{} P2P links", peers.len())),
                            ),
                    )
                })
                .when(peers.is_empty(), |el| {
                    el.child(
                        div()
                            .p(px(20.))
                            .flex()
                            .flex_col()
                            .items_center()
                            .justify_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(tokens::text_2())
                                    .child("No peers connected yet"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(tokens::text_3())
                                    .child(if is_hub {
                                        "When friends join, they will link directly into your Desktop Hub."
                                    } else {
                                        "Invite friends using the room code or QR code to establish peer mesh."
                                    }),
                            ),
                    )
                })
                .children(peers.iter().map(|p| {
                    let n = &p.net;
                    let (score, label, col) = technical_distance(
                        n.rtt_ms.unwrap_or(50.0),
                        n.connection_type(),
                        n.loss_percent(),
                        n.jitter_ms,
                    );
                    let name = view.name_of(&p.peer);
                    let is_sel = selected.is_some_and(|s| s.peer == p.peer);
                    let peer_id = p.peer.clone();

                    div()
                        .id(SharedString::from(format!("node-{}", p.peer)))
                        .p(px(10.))
                        .rounded(px(8.))
                        .border_1()
                        .border_color(if is_sel { tokens::focus() } else { tokens::line() })
                        .bg(if is_sel { tokens::raised() } else { tokens::panel() })
                        .cursor_pointer()
                        .hover(|s| s.bg(tokens::raised()))
                        .on_click(cx.listener(move |v, _, _, cx| {
                            v.net.selected_peer = Some(peer_id.clone());
                            cx.notify();
                        }))
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .size(px(32.))
                                        .rounded_full()
                                        .bg(tokens::line())
                                        .text_color(tokens::text())
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .text_size(px(12.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(peer_initials(&name)),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(6.))
                                                .child(
                                                    div()
                                                        .text_size(px(13.))
                                                        .font_weight(FontWeight::SEMIBOLD)
                                                        .child(name),
                                                )
                                                .child(
                                                    div()
                                                        .px(px(6.))
                                                        .py(px(1.))
                                                        .rounded(px(4.))
                                                        .bg(tokens::bg())
                                                        .text_size(px(10.))
                                                        .text_color(tokens::text_3())
                                                        .child(p.peer.as_str().chars().take(6).collect::<String>()),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(11.5))
                                                .text_color(tokens::text_3())
                                                .child(format!(
                                                    "{} • Jitter {:.1}ms • Loss {:.1}%",
                                                    n.connection_type(),
                                                    n.jitter_ms,
                                                    n.loss_percent()
                                                )),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(10.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .items_end()
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::BOLD)
                                                .text_color(col)
                                                .child(format!("{} ms", n.rtt_ms.map_or(0.0, f64::round))),
                                        )
                                        .child(
                                            div()
                                                .text_size(px(10.5))
                                                .text_color(tokens::text_3())
                                                .child(format!("Score: {score}")),
                                        ),
                                )
                                .child(
                                    div()
                                        .px(px(8.))
                                        .py(px(3.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(Hsla { a: 0.35, ..col })
                                        .bg(Hsla { a: 0.12, ..col })
                                        .text_color(col)
                                        .text_size(px(11.))
                                        .font_weight(FontWeight::BOLD)
                                        .child(label),
                                ),
                        )
                })),
        )
        // Inspector card
        .when_some(selected, |el, sel| {
            let n = &sel.net;
            let (score, label, col) = technical_distance(
                n.rtt_ms.unwrap_or(50.0),
                n.connection_type(),
                n.loss_percent(),
                n.jitter_ms,
            );
            let name = view.name_of(&sel.peer);

            el.child(
                div()
                    .p(px(12.))
                    .rounded(px(10.))
                    .border_1()
                    .border_color(tokens::line())
                    .bg(tokens::bg())
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::BOLD)
                                            .child(format!("Peer Inspection: {name}")),
                                    )
                                    .child(
                                        div()
                                            .px(px(6.))
                                            .py(px(1.))
                                            .rounded(px(4.))
                                            .bg(tokens::raised())
                                            .text_size(px(10.5))
                                            .text_color(tokens::text_2())
                                            .child(format!("`{}`", sel.peer)),
                                    ),
                            )
                            .child(
                                div()
                                    .px(px(8.))
                                    .py(px(2.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(Hsla { a: 0.35, ..col })
                                    .bg(Hsla { a: 0.12, ..col })
                                    .text_color(col)
                                    .text_size(px(11.))
                                    .font_weight(FontWeight::BOLD)
                                    .child(label),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(inspector_tile("RTT LATENCY", format!("{} ms", n.rtt_ms.map_or(0.0, f64::round)), col))
                            .child(inspector_tile("CANDIDATES", format!("{} → {}", n.local_type, n.remote_type), tokens::text()))
                            .child(inspector_tile("LOSS / JITTER", format!("{:.1}% • {:.1}ms", n.loss_percent(), n.jitter_ms), tokens::text()))
                            .child(inspector_tile("TECH DISTANCE", format!("Score: {score}"), col)),
                    ),
            )
        })
        .into_any_element()
}

fn radar_view(view: &RoomView, _is_hub: bool, host_name: &str, my_name: &str) -> AnyElement {
    let peers = &view.net.peers;
    let center_name = if view.net.perspective == Perspective::Host {
        host_name
    } else {
        my_name
    };

    let bands: [(&'static str, &'static str, Hsla, f64, f64); 5] = [
        (
            "⚡ Zone 0: Local LAN",
            "Direct subnet link (<15 ms)",
            tokens::net_excellent(),
            0.0,
            15.0,
        ),
        (
            "🟢 Zone 1: Near / Low Latency",
            "Direct P2P WAN link (15–50 ms)",
            tokens::net_good(),
            15.0,
            50.0,
        ),
        (
            "🟡 Zone 2: Medium Latency",
            "Standard regional routing (50–120 ms)",
            tokens::net_fair(),
            50.0,
            120.0,
        ),
        (
            "🟠 Zone 3: Far / High Latency",
            "Cross-region / transatlantic (120–250 ms)",
            tokens::warn(),
            120.0,
            250.0,
        ),
        (
            "🔴 Zone 4: Distant / Relayed",
            "Cloud TURN relay fallback (>250 ms or TURN)",
            tokens::net_poor(),
            250.0,
            10000.0,
        ),
    ];

    div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(
            div()
                .p(px(8.))
                .rounded(px(8.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .size(px(24.))
                        .rounded_full()
                        .bg(tokens::focus())
                        .text_color(tokens::white())
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(12.))
                        .child("🎯"),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(tokens::text_2())
                        .child(format!("Radar center perspective: {center_name} (Distances calculated relative to this participant)")),
                ),
        )
        .children(bands.iter().map(|(name, sub, col, min_s, max_s)| {
            let in_tier: Vec<_> = peers
                .iter()
                .filter(|p| {
                    let (score, _, _) = technical_distance(
                        p.net.rtt_ms.unwrap_or(50.0),
                        p.net.connection_type(),
                        p.net.loss_percent(),
                        p.net.jitter_ms,
                    );
                    f64::from(score) >= *min_s && f64::from(score) < *max_s
                })
                .collect();

            div()
                .p(px(10.))
                .rounded(px(10.))
                .border_1()
                .border_color(if !in_tier.is_empty() { *col } else { tokens::line() })
                .bg(if !in_tier.is_empty() { Hsla { a: 0.05, ..*col } } else { tokens::bg() })
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::BOLD)
                                        .text_color(*col)
                                        .child(*name),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .text_color(tokens::text_3())
                                        .child(*sub),
                                ),
                        )
                        .child(
                            div()
                                .px(px(6.))
                                .py(px(1.))
                                .rounded_full()
                                .bg(tokens::raised())
                                .text_size(px(10.5))
                                .text_color(tokens::text_2())
                                .child(format!("{} peers", in_tier.len())),
                        ),
                )
                .when(in_tier.is_empty(), |el| {
                    el.child(
                        div()
                            .text_size(px(11.5))
                            .text_color(tokens::text_3())
                            .child("— No participants in this distance range"),
                    )
                })
                .when(!in_tier.is_empty(), |el| {
                    el.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.))
                            .children(in_tier.into_iter().map(|p| {
                                let peer_name = view.name_of(&p.peer);
                                let rtt = p.net.rtt_ms.map_or(0.0, f64::round);
                                div()
                                    .px(px(10.))
                                    .py(px(4.))
                                    .rounded(px(6.))
                                    .bg(tokens::raised())
                                    .border_1()
                                    .border_color(tokens::line())
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .size(px(18.))
                                            .rounded_full()
                                            .bg(tokens::line())
                                            .text_size(px(10.))
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .child(peer_initials(&peer_name)),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(peer_name),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::BOLD)
                                            .text_color(*col)
                                            .child(format!("{rtt}ms")),
                                    )
                            })),
                    )
                })
        }))
        .into_any_element()
}

fn matrix_view(view: &RoomView, _is_hub: bool, is_host: bool, my_name: &str) -> AnyElement {
    let peers = &view.net.peers;

    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(
            div()
                .p(px(8.))
                .rounded(px(8.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .text_size(px(11.5))
                .font_weight(FontWeight::BOLD)
                .text_color(tokens::text_2())
                .child(div().w(px(160.)).child("PARTICIPANT"))
                .child(div().w(px(130.)).child("ROLE / CLIENT"))
                .child(div().w(px(80.)).child("PING (RTT)"))
                .child(div().w(px(110.)).child("PATH TYPE"))
                .child(div().w(px(70.)).child("LOSS %"))
                .child(div().flex_1().child("TECHNICAL DISTANCE")),
        )
        // Self row
        .child(
            div()
                .p(px(8.))
                .rounded(px(8.))
                .bg(tokens::raised())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .text_size(px(12.))
                .child(
                    div()
                        .w(px(160.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child("👤")
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(format!("{my_name} (You)")),
                        ),
                )
                .child(div().w(px(130.)).text_color(tokens::text_2()).child(if is_host {
                    "👑 Host • Desktop"
                } else {
                    "Participant • Desktop"
                }))
                .child(
                    div()
                        .w(px(80.))
                        .text_color(tokens::net_excellent())
                        .font_weight(FontWeight::BOLD)
                        .child("0 ms"),
                )
                .child(
                    div()
                        .w(px(110.))
                        .text_color(tokens::text_2())
                        .child("Local Loopback"),
                )
                .child(div().w(px(70.)).text_color(tokens::text_3()).child("0.0%"))
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::BOLD)
                        .text_color(tokens::net_excellent())
                        .child("Score 0 (⚡ Local)"),
                ),
        )
        // Peers rows
        .children(peers.iter().map(|p| {
            let n = &p.net;
            let (score, label, col) = technical_distance(
                n.rtt_ms.unwrap_or(50.0),
                n.connection_type(),
                n.loss_percent(),
                n.jitter_ms,
            );
            let name = view.name_of(&p.peer);
            let rtt = n.rtt_ms.map_or(0.0, f64::round);

            div()
                .p(px(8.))
                .rounded(px(8.))
                .bg(tokens::bg())
                .border_1()
                .border_color(tokens::line())
                .flex()
                .items_center()
                .text_size(px(12.))
                .child(
                    div()
                        .w(px(160.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .size(px(20.))
                                .rounded_full()
                                .bg(tokens::line())
                                .text_size(px(10.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(peer_initials(&name)),
                        )
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(name)),
                )
                .child(div().w(px(130.)).text_color(tokens::text_2()).child("Guest Peer"))
                .child(
                    div()
                        .w(px(80.))
                        .text_color(col)
                        .font_weight(FontWeight::BOLD)
                        .child(format!("{rtt} ms")),
                )
                .child(
                    div()
                        .w(px(110.))
                        .text_color(tokens::text_2())
                        .child(n.connection_type().to_owned()),
                )
                .child(
                    div()
                        .w(px(70.))
                        .text_color(tokens::text_3())
                        .child(format!("{:.1}%", n.loss_percent())),
                )
                .child(
                    div()
                        .flex_1()
                        .font_weight(FontWeight::BOLD)
                        .text_color(col)
                        .child(format!("Score {score} ({label})")),
                )
        }))
        .into_any_element()
}

fn inspector_tile(label: &'static str, val: String, col: Hsla) -> impl IntoElement {
    div()
        .flex_1()
        .min_w_0()
        .p(px(8.))
        .rounded(px(6.))
        .bg(tokens::panel())
        .border_1()
        .border_color(tokens::line())
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            div()
                .text_size(px(10.5))
                .font_weight(FontWeight::BOLD)
                .text_color(tokens::text_3())
                .child(label),
        )
        .child(
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::BOLD)
                .text_color(col)
                .child(val),
        )
}

fn peer_initials(name: &str) -> String {
    let mut chars = name.chars().filter(|c| c.is_alphanumeric());
    match (chars.next(), chars.next()) {
        (Some(a), Some(b)) => format!("{}{}", a.to_uppercase(), b.to_lowercase()),
        (Some(a), None) => a.to_uppercase().to_string(),
        _ => "?".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{grade, technical_distance};

    #[test]
    fn grades_like_the_web_app() {
        assert_eq!(grade(None, 0.0).2, "?");
        assert_eq!(grade(Some(40.0), 0.5).2, "A+");
        assert_eq!(grade(Some(40.0), 2.0).2, "A");
        assert_eq!(grade(Some(150.0), 0.0).2, "B");
        assert_eq!(grade(Some(400.0), 0.0).0, "Poor / High Latency");
    }

    #[test]
    fn technical_distance_calculates_tiers_and_penalties() {
        // LAN
        let (lan_score, lan_label, _) = technical_distance(8.0, "host (LAN)", 0.0, 0.5);
        assert!(lan_score < 15);
        assert_eq!(lan_label, "⚡ LAN");

        // Near P2P
        let (near_score, near_label, _) = technical_distance(32.0, "srflx (P2P)", 0.0, 1.0);
        assert!((15..50).contains(&near_score));
        assert_eq!(near_label, "🟢 Near");

        // Medium P2P
        let (med_score, med_label, _) = technical_distance(75.0, "srflx (P2P)", 0.5, 3.0);
        assert!((50..120).contains(&med_score));
        assert_eq!(med_label, "🟡 Medium");

        // Far P2P
        let (far_score, far_label, _) = technical_distance(160.0, "srflx (P2P)", 1.0, 4.0);
        assert!((120..250).contains(&far_score));
        assert_eq!(far_label, "🟠 Far");

        // TURN Relay penalty (2.5x multiplier)
        let (relay_score, relay_label, _) = technical_distance(120.0, "Relay (TURN)", 0.0, 2.0);
        assert!(relay_score >= 250);
        assert_eq!(relay_label, "🔴 Distant");
    }
}
