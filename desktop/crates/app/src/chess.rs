//! Chess on screen (`chess/index.tsx`): the board (tap a piece, then a square; promotion choice),
//! the panel (status, last move, seats, lobby buttons, draw offers, the move list, Resign, Flip,
//! Rematch), and on the deciding app the computer's moves.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Bounds, Context, Pixels, canvas, div, img, px};
use rtc_core::{ActivityCommand, StoreView};
use rtc_engine::Snapshot;
use rtc_games::chess::engine::{self, Color};
use rtc_games::chess::{self, State, act};
use rtc_ui::button::{Button, Variant};
use rtc_ui::tokens;
use serde_json::Value;

use crate::view::RoomView;

const KEY: &str = "act:chess";
/// How long the computer "thinks" before its move appears.
const BOT_DELAY: Duration = Duration::from_millis(700);

/// This device's view of the game.
#[derive(Debug, Default)]
pub(crate) struct ChessUi {
    /// The piece picked up: (state seq, square).
    selected: Option<(i64, usize)>,
    /// A promotion being chosen: (seq, from, to).
    promo: Option<(i64, usize, usize)>,
    /// The board turned around here.
    flip: bool,
    /// "Resign?" asked at this seq.
    resign_ask: Option<i64>,
    /// The computer's move asked for at this seq (deciding app).
    bot_sent: Option<i64>,
    /// The seat asked back (so it's asked once).
    reclaim_sent: Option<String>,
    /// Where the board area is.
    pub(crate) area: Rc<Cell<Option<Bounds<Pixels>>>>,
}

fn reason_text(r: &str) -> &'static str {
    match r {
        "checkmate" => "by checkmate",
        "resign" => "by resignation",
        "stalemate" => "Stalemate: a draw",
        "repetition" => "Draw by threefold repetition",
        "fifty" => "Draw by the fifty-move rule",
        "material" => "Draw: not enough pieces left to mate",
        "agreed" => "Draw agreed",
        _ => "",
    }
}

fn piece_name(letter: char) -> &'static str {
    match letter {
        'K' => "King",
        'Q' => "Queen",
        'R' => "Rook",
        'B' => "Bishop",
        'N' => "Knight",
        _ => "Pawn",
    }
}

/// The last move in words ("White Knight g1 → f3, takes, check").
fn describe(m: &chess::Played, color: Option<Color>) -> (char, String) {
    let side = color.map_or("", Color::name);
    let (from, to) = (engine::square_name(m.from), engine::square_name(m.to));
    if m.san.starts_with("O-O") {
        let which = if m.san.starts_with("O-O-O") {
            "queenside"
        } else {
            "kingside"
        };
        return ('k', format!("{side} castled {which} (King {from} → {to})"));
    }
    let letter = m
        .san
        .chars()
        .next()
        .filter(|c| "KQRBN".contains(*c))
        .unwrap_or('P');
    let mut extra = Vec::new();
    if m.san.contains('x') {
        extra.push("takes".to_owned());
    }
    if let Some(p) = &m.promo {
        extra.push(format!(
            "becomes a {}",
            piece_name(p.to_ascii_uppercase().chars().next().unwrap_or('Q'))
        ));
    }
    if m.san.ends_with('#') {
        extra.push("checkmate".to_owned());
    } else if m.san.ends_with('+') {
        extra.push("check".to_owned());
    }
    let tail = if extra.is_empty() {
        String::new()
    } else {
        format!(", {}", extra.join(", "))
    };
    (
        letter.to_ascii_lowercase(),
        format!("{side} {} {from} → {to}{tail}", piece_name(letter)),
    )
}

fn piece_img(p: u8, size: f32) -> impl IntoElement {
    let c = if p.is_ascii_uppercase() { 'w' } else { 'b' };
    img(format!("chess/{c}{}.svg", p.to_ascii_lowercase() as char)).size(px(size))
}

fn piece_icon(color: Color, t: char, size: f32) -> impl IntoElement {
    img(format!("chess/{}{t}.svg", color.key())).size(px(size))
}

fn mini_btn(
    id: impl Into<gpui_kit::ElementId>,
    label: &str,
    danger: bool,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    div()
        .id(id)
        .min_h(px(32.))
        .px(px(10.))
        .flex()
        .items_center()
        .rounded(px(8.))
        .border_1()
        .border_color(if danger {
            tokens::danger_line()
        } else {
            tokens::line_strong()
        })
        .when(danger, |el| el.bg(tokens::danger_bg()))
        .text_size(px(12.5))
        .text_color(if danger {
            tokens::danger_text()
        } else {
            tokens::text()
        })
        .cursor_pointer()
        .hover(|s| s.bg(tokens::raised()))
        .child(label.to_owned())
}

impl RoomView {
    fn chess_send(&mut self, action: Value, cx: &mut Context<'_, Self>) {
        self.activity_command(
            ActivityCommand::Dispatch {
                key: KEY.to_owned(),
                action,
            },
            cx,
        );
    }

    fn chess_state(&self) -> Option<(State, StoreView)> {
        let r = self.room.as_ref()?;
        let (_, v) = r.stores.iter().find(|(k, _)| k == KEY)?;
        Some((State::from_value(&v.state)?, v.clone()))
    }

    /// After every room update: the deciding app plays the computer's moves, and a seat we had
    /// before a restart is asked back.
    pub(crate) fn chess_after(&mut self, cx: &mut Context<'_, Self>) {
        let Some((s, v)) = self.chess_state() else { return };
        let Some(room) = self.room.as_ref() else { return };
        let me = room.me.as_str().to_owned();
        let my_client = room.client_id.clone();
        let username = room.username.clone();
        // the computer's move
        let deciding = v.presence.authority.as_ref().is_some_and(|a| a.as_str() == me);
        let bot_turn = s.phase == "playing" && s.seats.get(s.pos.turn).is_some_and(chess::Seat::is_bot);
        if deciding && bot_turn && self.activity.chess.bot_sent != Some(s.seq) {
            self.activity.chess.bot_sent = Some(s.seq);
            let seq = s.seq;
            cx.spawn(async move |v, cx| {
                cx.background_executor().timer(BOT_DELAY).await;
                let _ = v.update(cx, |v, cx| {
                    // still the computer's turn at this point of the game?
                    if v.chess_state().is_some_and(|(s, _)| s.seq == seq) {
                        v.chess_send(act::auto(seq), cx);
                    }
                });
            })
            .detach();
        }
        // our seat back after a restart
        let present: Vec<&str> = v
            .presence
            .members
            .iter()
            .map(rtc_protocol::PeerId::as_str)
            .collect();
        if s.seat_of(&me).is_none() {
            let old = [Color::W, Color::B].into_iter().find(|&c| {
                s.seats.get(c).is_some_and(|seat| {
                    !seat.is_bot()
                        && !present.contains(&seat.id.as_str())
                        && seat.cid.as_deref() == Some(my_client.as_str())
                })
            });
            if let Some(c) = old {
                let key = format!("{}:{}", c.key(), s.seats.get(c).map_or("", |x| x.id.as_str()));
                if self.activity.chess.reclaim_sent.as_ref() != Some(&key) {
                    self.activity.chess.reclaim_sent = Some(key);
                    self.chess_send(act::sit(c, &username), cx);
                }
            }
        }
    }

    /// What the bubble says: it's your move, or a draw is offered to you.
    pub(crate) fn chess_attention(&self) -> Option<String> {
        let (s, _) = self.chess_state()?;
        let me = self.room.as_ref()?.me.as_str().to_owned();
        let mine = s.seat_of(&me)?;
        if s.phase != "playing" {
            return None;
        }
        if s.draw_offer.is_some_and(|d| d != mine) {
            return Some("Draw offered".to_owned());
        }
        (s.pos.turn == mine).then(|| {
            if engine::in_check(&s.pos, s.pos.turn) {
                "Check! Your move".to_owned()
            } else {
                "Your move".to_owned()
            }
        })
    }

    fn chess_click(&mut self, sq: usize, cx: &mut Context<'_, Self>) {
        let Some((s, _)) = self.chess_state() else { return };
        let Some(me) = self.room.as_ref().map(|r| r.me.as_str().to_owned()) else {
            return;
        };
        let Some(mine) = s.seat_of(&me) else { return };
        if s.phase != "playing"
            || s.pos.turn != mine
            || self.activity.chess.promo.is_some_and(|p| p.0 == s.seq)
        {
            return;
        }
        let legal = engine::legal_moves(&s.pos);
        let selected = self.activity.chess.selected.filter(|x| x.0 == s.seq).map(|x| x.1);
        if let Some(from) = selected {
            let options: Vec<engine::Move> = legal
                .iter()
                .filter(|m| m.from == from && m.to == sq)
                .copied()
                .collect();
            if !options.is_empty() {
                if options.iter().any(|m| m.promo.is_some()) {
                    self.activity.chess.promo = Some((s.seq, from, sq));
                } else {
                    self.activity.chess.selected = None;
                    self.chess_send(act::mv(from, sq, None), cx);
                }
                cx.notify();
                return;
            }
        }
        let own = engine::color_of(s.pos.board.as_bytes()[sq]) == Some(mine);
        self.activity.chess.selected = own.then_some((s.seq, sq));
        cx.notify();
    }

    fn chess_promote(&mut self, p: Option<u8>, cx: &mut Context<'_, Self>) {
        if let (Some((seq, from, to)), Some(p)) = (self.activity.chess.promo.take(), p)
            && self.chess_state().is_some_and(|(s, _)| s.seq == seq)
        {
            self.activity.chess.selected = None;
            self.chess_send(act::mv(from, to, Some(p)), cx);
        }
        cx.notify();
    }
}

/// The game.
#[allow(clippy::too_many_lines)]
pub(crate) fn view(
    view: &RoomView,
    room: &Snapshot,
    store: &Value,
    cx: &mut Context<'_, RoomView>,
) -> AnyElement {
    let Some(s) = State::from_value(store) else {
        return div().into_any_element();
    };
    let presence = room
        .stores
        .iter()
        .find(|(k, _)| k == KEY)
        .map(|(_, v)| {
            v.presence
                .members
                .iter()
                .map(|p| p.as_str().to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let me = room.me.as_str().to_owned();
    let host_here = room
        .host
        .as_ref()
        .is_some_and(|h| *h == room.me || presence.iter().any(|p| p == h.as_str()));
    let can_manage = room.host.as_ref() == Some(&room.me) || !host_here;
    let my_color = s.seat_of(&me);
    let turn = s.pos.turn;
    let name_of = |c: Color| {
        s.seats
            .get(c)
            .map_or_else(|| c.name().to_owned(), |x| x.name.clone())
    };
    let away = |c: Color| {
        s.seats
            .get(c)
            .is_some_and(|x| !x.is_bot() && !presence.contains(&x.id))
    };
    let ui = &view.activity.chess;
    let flipped = my_color.map_or(ui.flip, |c| (c == Color::B) != ui.flip);
    let my_turn = s.phase == "playing" && my_color == Some(turn);
    let draw_to_me =
        s.phase == "playing" && my_color.is_some() && s.draw_offer.is_some_and(|d| Some(d) != my_color);
    let check = s.phase != "lobby" && engine::in_check(&s.pos, turn);

    let status = if s.phase == "lobby" {
        if s.seats.w.is_none() || s.seats.b.is_none() {
            if my_color.is_some() {
                "Waiting for an opponent.".to_owned()
            } else {
                "Pick a side to play, or watch.".to_owned()
            }
        } else {
            "Both seats taken. Ready to start.".to_owned()
        }
    } else if let (true, Some(r)) = (s.phase == "over", &s.result) {
        match r.winner {
            None => format!("{}.", reason_text(&r.reason)),
            Some(w) => {
                let who = if my_color == Some(w) {
                    "You win".to_owned()
                } else {
                    format!("{} wins", name_of(w))
                };
                format!("{who} {}.", reason_text(&r.reason))
            }
        }
    } else {
        let c = if check { "Check! " } else { "" };
        if my_turn {
            format!("{c}Your move.")
        } else if s.seats.get(turn).is_some_and(chess::Seat::is_bot) {
            format!("{c}The computer is thinking…")
        } else if away(turn) {
            format!("{c}{} left the game.", name_of(turn))
        } else {
            format!("{c}{} to move.", name_of(turn))
        }
    };

    // ---- the board ----
    let area = view.activity.chess.area.get();
    let avail_w = area.map_or(640.0, |a| f32::from(a.size.width) - 300.0 - 40.0);
    let avail_h = area.map_or(640.0, |a| f32::from(a.size.height) - 40.0);
    let board_px = avail_w.min(avail_h).clamp(240.0, 900.0);
    let sq_px = (board_px / 8.0).floor();
    let board = s.pos.board.as_bytes();
    let selected = ui.selected.filter(|x| x.0 == s.seq).map(|x| x.1);
    let legal = if my_turn {
        engine::legal_moves(&s.pos)
    } else {
        Vec::new()
    };
    let targets: Vec<usize> = selected.map_or_else(Vec::new, |f| {
        legal.iter().filter(|m| m.from == f).map(|m| m.to).collect()
    });
    let last = s.moves.last().cloned();
    let check_sq = if check {
        engine::king_square(board, turn)
    } else {
        None
    };
    let mut squares = Vec::with_capacity(64);
    for sq in 0..64usize {
        let (row, col) = (sq >> 3, sq & 7);
        let (x, y) = if flipped { (7 - col, 7 - row) } else { (col, row) };
        let light = (row + col) % 2 == 0;
        let is_last = last.as_ref().is_some_and(|m| m.from == sq || m.to == sq);
        let p = board[sq];
        let capture_hint = targets.contains(&sq)
            && (p != b'.'
                || (selected.is_some_and(|f| engine::type_of(board[f]) == b'p')
                    && i64::try_from(sq).ok() == Some(s.pos.ep)));
        squares.push(
            div()
                .id(("chess-sq", sq))
                .absolute()
                .left(px(x as f32 * sq_px))
                .top(px(y as f32 * sq_px))
                .size(px(sq_px))
                .bg(if light {
                    tokens::chess_light()
                } else {
                    tokens::chess_dark()
                })
                .when(is_last, |el| {
                    el.child(
                        div()
                            .absolute()
                            .size_full()
                            .bg(tokens::chess_mark().opacity(0.42)),
                    )
                })
                .when(selected == Some(sq), |el| {
                    el.child(
                        div()
                            .absolute()
                            .size_full()
                            .bg(tokens::chess_mark().opacity(0.62)),
                    )
                })
                .when(check_sq == Some(sq), |el| {
                    el.child(div().absolute().size_full().bg(tokens::accent().opacity(0.55)))
                })
                .when(p != b'.', |el| {
                    el.child(
                        div()
                            .absolute()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(piece_img(p, sq_px * 0.92)),
                    )
                })
                .when(targets.contains(&sq), |el| {
                    el.child(
                        div()
                            .absolute()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(if capture_hint {
                                div()
                                    .size(px(sq_px * 0.88))
                                    .rounded_full()
                                    .border(px((sq_px * 0.08).max(3.0)))
                                    .border_color(tokens::chess_hint().opacity(0.24))
                            } else {
                                div()
                                    .size(px(sq_px * 0.3))
                                    .rounded_full()
                                    .bg(tokens::chess_hint().opacity(0.22))
                            }),
                    )
                })
                .when(my_turn, gpui_kit::Styled::cursor_pointer)
                .on_click(cx.listener(move |v, _, _, cx| v.chess_click(sq, cx))),
        );
    }
    let files = "abcdefgh";
    let coords_rank = (0..8).map(|i| {
        let n = if flipped { i + 1 } else { 8 - i };
        div()
            .absolute()
            .left(px(-20.))
            .top(px(i as f32 * sq_px))
            .h(px(sq_px))
            .w(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(13.))
            .text_color(tokens::text_3())
            .child(n.to_string())
    });
    let coords_file = (0..8).map(|i| {
        let f = files.chars().nth(if flipped { 7 - i } else { i }).unwrap_or('a');
        div()
            .absolute()
            .left(px(i as f32 * sq_px))
            .top(px(8.0 * sq_px + 2.0))
            .w(px(sq_px))
            .flex()
            .justify_center()
            .text_size(px(13.))
            .text_color(tokens::text_3())
            .child(f.to_string())
    });
    let promo = ui.promo.filter(|p| p.0 == s.seq).map(|_| {
        let color = turn;
        div()
            .absolute()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(tokens::black(0.55))
            .rounded(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(10.))
                    .px(px(16.))
                    .py(px(14.))
                    .rounded(px(14.))
                    .bg(tokens::surface())
                    .border_1()
                    .border_color(tokens::line_strong())
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(tokens::text_2())
                            .child("Promote to"),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .children(b"qrbn".iter().copied().map(|t| {
                                div()
                                    .id(("chess-promo", usize::from(t)))
                                    .size(px(60.))
                                    .p(px(4.))
                                    .rounded(px(10.))
                                    .border_1()
                                    .border_color(tokens::line_strong())
                                    .bg(tokens::chess_light())
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |v, _, _, cx| v.chess_promote(Some(t), cx)))
                                    .child(piece_icon(color, t as char, 50.0))
                            })),
                    )
                    .child(
                        mini_btn("chess-promo-cancel", "Cancel", false)
                            .on_click(cx.listener(|v, _, _, cx| v.chess_promote(None, cx))),
                    ),
            )
    });
    let board_el = div()
        .relative()
        .flex_none()
        .size(px(sq_px * 8.0))
        .ml(px(22.))
        .mb(px(22.))
        .child(
            div()
                .absolute()
                .size_full()
                .rounded(px(10.))
                .overflow_hidden()
                .children(squares),
        )
        .children(coords_rank)
        .children(coords_file)
        .children(promo);

    // ---- the panel ----
    let last_line = last.as_ref().map(|m| {
        let color = engine::color_of(board[m.to]);
        let (piece, text) = describe(m, color);
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .py(px(8.))
            .rounded(px(10.))
            .bg(tokens::surface())
            .text_size(px(13.5))
            .child(
                div()
                    .size(px(28.))
                    .rounded(px(6.))
                    .bg(tokens::chess_light())
                    .child(piece_icon(color.unwrap_or(Color::W), piece, 28.0)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(tokens::text_3())
                            .child("Last move"),
                    )
                    .child(text),
            )
    });
    let captured = chess::captured(&s.pos.board);
    let lost = |c: Color| {
        captured
            .iter()
            .find(|(k, _)| *k == c)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let material = |c: Color| lost(c).iter().map(|&t| engine::piece_value(t)).sum::<i64>() / 100;
    let top = if flipped { Color::W } else { Color::B };
    let seat_rows = [top, top.other()].map(|c| {
        let seat = s.seats.get(c).cloned();
        let is_away = away(c);
        let taken = lost(c.other());
        let adv = material(c.other()) - material(c);
        let mut row = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(10.))
            .py(px(6.))
            .min_h(px(44.))
            .rounded(px(10.))
            .bg(tokens::surface())
            .border_1()
            .border_color(if s.phase == "playing" && turn == c {
                tokens::chess_dark()
            } else {
                tokens::surface()
            })
            .child(
                div()
                    .size(px(30.))
                    .rounded(px(8.))
                    .p(px(2.))
                    .bg(if c == Color::W {
                        tokens::chess_dark()
                    } else {
                        tokens::chess_light()
                    })
                    .child(piece_icon(c, 'k', 26.0)),
            );
        let label = seat.as_ref().map_or_else(
            || format!("{}: free", c.name()),
            |x| {
                if x.id == me {
                    format!("{} (you)", x.name)
                } else {
                    x.name.clone()
                }
            },
        );
        row = row.child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(14.))
                        .text_color(if seat.is_some() {
                            tokens::text()
                        } else {
                            tokens::text_3()
                        })
                        .child(label)
                        .when(is_away, |el| el.child(tag("away", false)))
                        .when(s.result.as_ref().is_some_and(|r| r.winner == Some(c)), |el| {
                            el.child(tag("winner", true))
                        }),
                )
                .when(s.phase != "lobby", |el| {
                    el.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(2.))
                            .min_h(px(16.))
                            .children(taken.iter().map(|&t| {
                                div()
                                    .size(px(18.))
                                    .rounded(px(4.))
                                    .bg(tokens::chess_light())
                                    .child(piece_icon(c.other(), t as char, 18.0))
                            }))
                            .when(adv > 0, |el| {
                                el.child(
                                    div()
                                        .ml(px(10.))
                                        .text_size(px(12.))
                                        .text_color(tokens::text_2())
                                        .child(format!("+{adv}")),
                                )
                            }),
                    )
                }),
        );
        if s.phase == "lobby" && seat.is_none() {
            row = row
                .child(
                    mini_btn(
                        ("chess-play", c as usize),
                        if my_color.is_some() { "Switch" } else { "Play" },
                        false,
                    )
                    .on_click(cx.listener(move |v, _, _, cx| {
                        let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                        v.chess_send(act::sit(c, &name), cx);
                    })),
                )
                .when(can_manage, |el| {
                    el.child(
                        mini_btn(("chess-bot", c as usize), "+ Computer", false)
                            .on_click(cx.listener(move |v, _, _, cx| v.chess_send(act::add_bot(c), cx))),
                    )
                });
        } else if s.phase == "lobby" && seat.as_ref().is_some_and(|x| x.id == me || can_manage) {
            let mine = seat.as_ref().is_some_and(|x| x.id == me);
            row = row.child(
                mini_btn(
                    ("chess-leave", c as usize),
                    if mine { "Leave" } else { "Remove" },
                    false,
                )
                .on_click(cx.listener(move |v, _, _, cx| {
                    v.chess_send(if mine { act::stand() } else { act::clear_seat(c) }, cx);
                })),
            );
        } else if s.phase == "playing" && is_away {
            if my_color.is_none() {
                row = row.child(mini_btn(("chess-take", c as usize), "Take seat", false).on_click(
                    cx.listener(move |v, _, _, cx| {
                        let name = v.room.as_ref().map(|r| r.username.clone()).unwrap_or_default();
                        v.chess_send(act::sit(c, &name), cx);
                    }),
                ));
            }
            if can_manage || my_color.is_some() {
                row = row.child(
                    mini_btn(("chess-hand", c as usize), "Computer plays", false)
                        .on_click(cx.listener(move |v, _, _, cx| v.chess_send(act::hand_to_bot(c), cx))),
                );
            }
        }
        row
    });

    let mut panel = div()
        .id("chess-panel")
        .w(px(280.))
        .flex_none()
        .max_h_full()
        .overflow_y_scroll()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(div().text_size(px(15.)).child(status))
        .children(last_line)
        .child(div().flex().flex_col().gap(px(6.)).children(seat_rows));

    if s.phase == "lobby" {
        let both = s.seats.w.is_some() && s.seats.b.is_some();
        let mut row = div().flex().flex_wrap().gap(px(8.)).items_center();
        if (can_manage || my_color.is_some()) && both {
            row = row.child(
                mini_btn("chess-swap", "Swap colours", false)
                    .on_click(cx.listener(|v, _, _, cx| v.chess_send(act::swap(), cx))),
            );
        }
        if can_manage || my_color.is_some() {
            row = row.child(
                div().flex_1().child(
                    Button::new("chess-start", if both { "Start game" } else { "Need 2 players" })
                        .variant(Variant::Primary)
                        .full_width()
                        .on_click(cx.listener(move |v, _, _, cx| {
                            if both {
                                v.chess_send(act::start(), cx);
                            }
                        })),
                ),
            );
        } else {
            row = row.child(
                div()
                    .text_size(px(13.))
                    .text_color(tokens::text_3())
                    .child("A player or the host starts the game."),
            );
        }
        panel = panel.child(row);
    }
    if draw_to_me && let Some(d) = s.draw_offer {
        panel = panel.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .px(px(12.))
                .py(px(10.))
                .rounded(px(10.))
                .bg(tokens::raised())
                .border_1()
                .border_color(tokens::chess_dark())
                .text_size(px(14.))
                .child(format!("{} offers a draw.", name_of(d)))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new("chess-accept", "Accept")
                                .variant(Variant::Primary)
                                .on_click(
                                    cx.listener(|v, _, _, cx| v.chess_send(act::answer_draw(true), cx)),
                                ),
                        )
                        .child(
                            Button::new("chess-decline", "Decline")
                                .variant(Variant::Secondary)
                                .on_click(
                                    cx.listener(|v, _, _, cx| v.chess_send(act::answer_draw(false), cx)),
                                ),
                        ),
                ),
        );
    }
    if !s.moves.is_empty() {
        let rows: Vec<(usize, String, String)> = s
            .moves
            .chunks(2)
            .enumerate()
            .map(|(i, pair)| {
                (
                    i + 1,
                    pair[0].san.clone(),
                    pair.get(1).map(|m| m.san.clone()).unwrap_or_default(),
                )
            })
            .collect();
        panel = panel.child(
            div()
                .id("chess-moves")
                .max_h(px(180.))
                .overflow_y_scroll()
                .py(px(6.))
                .px(px(4.))
                .rounded(px(10.))
                .bg(tokens::surface())
                .font_family(tokens::FONT_MONO)
                .text_size(px(13.))
                .children(rows.into_iter().map(|(n, w, b)| {
                    div()
                        .flex()
                        .px(px(8.))
                        .py(px(2.))
                        .child(
                            div()
                                .w(px(34.))
                                .text_color(tokens::text_3())
                                .child(format!("{n}.")),
                        )
                        .child(div().flex_1().child(w))
                        .child(div().flex_1().child(b))
                })),
        );
    }
    let mut actions = div().flex().flex_wrap().gap(px(8.)).items_center();
    if s.phase == "playing"
        && let Some(mine) = my_color
    {
        if s.draw_offer == Some(mine) {
            actions = actions.child(
                mini_btn("chess-cancel-draw", "Cancel draw offer", false)
                    .on_click(cx.listener(|v, _, _, cx| v.chess_send(act::answer_draw(false), cx))),
            );
        } else if s.draw_offer.is_none() && !s.seats.get(mine.other()).is_some_and(chess::Seat::is_bot) {
            actions = actions.child(
                mini_btn("chess-offer", "Offer draw", false)
                    .on_click(cx.listener(|v, _, _, cx| v.chess_send(act::offer_draw(), cx))),
            );
        }
        let seq = s.seq;
        if ui.resign_ask == Some(s.seq) {
            actions = actions
                .child(
                    mini_btn("chess-resign-yes", "Yes, resign", true)
                        .on_click(cx.listener(|v, _, _, cx| v.chess_send(act::resign(), cx))),
                )
                .child(
                    mini_btn("chess-resign-no", "Keep playing", false).on_click(cx.listener(
                        |v, _, _, cx| {
                            v.activity.chess.resign_ask = None;
                            cx.notify();
                        },
                    )),
                );
        } else {
            actions = actions.child(mini_btn("chess-resign", "Resign", false).on_click(cx.listener(
                move |v, _, _, cx| {
                    v.activity.chess.resign_ask = Some(seq);
                    cx.notify();
                },
            )));
        }
    }
    if s.phase != "lobby" {
        actions = actions.child(mini_btn("chess-flip", "⇅ Flip", false).on_click(cx.listener(
            |v, _, _, cx| {
                v.activity.chess.flip = !v.activity.chess.flip;
                cx.notify();
            },
        )));
    }
    if s.phase == "over" && (can_manage || my_color.is_some()) {
        actions = actions.child(
            Button::new("chess-again", "Rematch")
                .variant(Variant::Primary)
                .on_click(cx.listener(|v, _, _, cx| v.chess_send(act::again(), cx))),
        );
    }
    panel = panel.child(actions);

    let area_cell = Rc::clone(&view.activity.chess.area);
    div()
        .size_full()
        .relative()
        .child(
            canvas(move |b, _, _| area_cell.set(Some(b)), |_, (), _, _| {})
                .absolute()
                .size_full(),
        )
        .child(
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(24.))
                .p(px(16.))
                .child(board_el)
                .child(panel),
        )
        .into_any_element()
}

fn tag(text: &'static str, win: bool) -> impl IntoElement {
    div()
        .px(px(6.))
        .rounded(px(6.))
        .text_size(px(11.))
        .bg(if win {
            tokens::chess_dark().opacity(0.25)
        } else {
            tokens::raised()
        })
        .text_color(if win {
            tokens::live_text()
        } else {
            tokens::text_2()
        })
        .child(text)
}
