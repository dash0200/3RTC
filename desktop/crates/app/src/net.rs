//! Connection details (`NetworkDiagnosticsModal.tsx`, `hooks/useNetworkStats.ts`,
//! `utils/networkMonitor.ts`), without the stream doctor: each connection's round trip, path,
//! loss, jitter and data rates, refreshed every 2.5 s while open, and a report to copy.

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::{
    AnyElement, ClipboardItem, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, div, prelude::FluentBuilder as _, px,
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

/// What the dialog shows.
#[derive(Default)]
pub(crate) struct NetState {
    pub(crate) peers: Vec<NetPeer>,
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
    let (label, color, g) = grade(s.avg, s.loss);
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

#[cfg(test)]
mod tests {
    use super::grade;

    #[test]
    fn grades_like_the_web_app() {
        assert_eq!(grade(None, 0.0).2, "?");
        assert_eq!(grade(Some(40.0), 0.5).2, "A+");
        assert_eq!(grade(Some(40.0), 2.0).2, "A");
        assert_eq!(grade(Some(150.0), 0.0).2, "B");
        assert_eq!(grade(Some(400.0), 0.0).0, "Poor / High Latency");
    }
}
