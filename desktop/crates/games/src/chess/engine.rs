//! Chess rules (`chess/engine.ts`): legal moves (castling, en passant, promotion), check, mate,
//! draws, move names (SAN) and the small computer player. The same move order and arithmetic as
//! the web app, so both pick the same moves.
//!
//! Board: 64 squares, index 0 = a8 … 63 = h1 (FEN order). `.` is empty, upper case is White.

use serde::{Deserialize, Serialize};

/// A side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Color {
    /// White.
    #[serde(rename = "w")]
    W,
    /// Black.
    #[serde(rename = "b")]
    B,
}

impl Color {
    /// The other side.
    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::W => Self::B,
            Self::B => Self::W,
        }
    }

    /// `"w"` / `"b"`.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::W => "w",
            Self::B => "b",
        }
    }

    /// "White" / "Black".
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::W => "White",
            Self::B => "Black",
        }
    }

    /// From `"w"` / `"b"` only.
    #[must_use]
    pub fn parse(v: &serde_json::Value) -> Option<Self> {
        match v.as_str()? {
            "w" => Some(Self::W),
            "b" => Some(Self::B),
            _ => None,
        }
    }
}

/// A position (`Position`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    /// 64 characters.
    pub board: String,
    /// Side to move.
    pub turn: Color,
    /// `KQkq` subset.
    pub castling: String,
    /// En passant target, −1 for none.
    pub ep: i64,
    /// Half-moves since a capture or pawn move.
    pub half: i64,
    /// Move number.
    pub full: i64,
}

/// A move; `promo` is `q`, `r`, `b` or `n`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Move {
    /// From square.
    pub from: usize,
    /// To square.
    pub to: usize,
    /// Promotion piece.
    pub promo: Option<u8>,
}

/// The starting board.
pub const START_BOARD: &str = "rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR";

/// The starting position.
#[must_use]
pub fn start() -> Position {
    Position {
        board: START_BOARD.to_owned(),
        turn: Color::W,
        castling: "KQkq".to_owned(),
        ep: -1,
        half: 0,
        full: 1,
    }
}

const FILES: &[u8; 8] = b"abcdefgh";

/// File 0..8.
#[must_use]
pub const fn file_of(sq: usize) -> usize {
    sq & 7
}

/// Rank 1..8.
#[must_use]
pub const fn rank_of(sq: usize) -> usize {
    8 - (sq >> 3)
}

/// `e4`.
#[must_use]
pub fn square_name(sq: usize) -> String {
    format!("{}{}", FILES[file_of(sq)] as char, rank_of(sq))
}

/// Colour of a piece byte.
#[must_use]
pub const fn color_of(p: u8) -> Option<Color> {
    if p == b'.' {
        None
    } else if p.is_ascii_uppercase() {
        Some(Color::W)
    } else {
        Some(Color::B)
    }
}

/// Lower-case kind.
#[must_use]
pub const fn type_of(p: u8) -> u8 {
    p.to_ascii_lowercase()
}

const KNIGHT: [(i32, i32); 8] = [
    (-2, -1),
    (-2, 1),
    (-1, -2),
    (-1, 2),
    (1, -2),
    (1, 2),
    (2, -1),
    (2, 1),
];
const KING: [(i32, i32); 8] = [
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
];
const DIAG: [(i32, i32); 4] = [(-1, -1), (-1, 1), (1, -1), (1, 1)];
const ORTHO: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

const fn on_board(f: i32, r: i32) -> bool {
    f >= 0 && f < 8 && r >= 0 && r < 8
}

#[allow(clippy::cast_sign_loss)]
const fn at(row: i32, col: i32) -> usize {
    (row * 8 + col) as usize
}

#[allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]
const fn rc(sq: usize) -> (i32, i32) {
    ((sq >> 3) as i32, (sq & 7) as i32)
}

/// Is `sq` attacked by `by`?
#[must_use]
pub fn attacked(board: &[u8], sq: usize, by: Color) -> bool {
    let (row, col) = rc(sq);
    let own = |p: u8, t: u8| p != b'.' && color_of(p) == Some(by) && type_of(p) == t;
    let pr = if by == Color::W { row + 1 } else { row - 1 };
    for dc in [-1, 1] {
        if on_board(col + dc, pr) && own(board[at(pr, col + dc)], b'p') {
            return true;
        }
    }
    for (dr, dc) in KNIGHT {
        if on_board(col + dc, row + dr) && own(board[at(row + dr, col + dc)], b'n') {
            return true;
        }
    }
    for (dr, dc) in KING {
        if on_board(col + dc, row + dr) && own(board[at(row + dr, col + dc)], b'k') {
            return true;
        }
    }
    for (dirs, kinds) in [(&DIAG, b"bq"), (&ORTHO, b"rq")] {
        for &(dr, dc) in dirs {
            let (mut r, mut c) = (row + dr, col + dc);
            while on_board(c, r) {
                let p = board[at(r, c)];
                if p != b'.' {
                    if color_of(p) == Some(by) && kinds.contains(&type_of(p)) {
                        return true;
                    }
                    break;
                }
                r += dr;
                c += dc;
            }
        }
    }
    false
}

/// Where `color`'s king is.
#[must_use]
pub fn king_square(board: &[u8], color: Color) -> Option<usize> {
    let k = if color == Color::W { b'K' } else { b'k' };
    board.iter().position(|&p| p == k)
}

/// `color` is in check.
#[must_use]
pub fn in_check(pos: &Position, color: Color) -> bool {
    let b = pos.board.as_bytes();
    king_square(b, color).is_some_and(|k| attacked(b, k, color.other()))
}

fn pseudo_moves(pos: &Position) -> Vec<Move> {
    let board = pos.board.as_bytes();
    let turn = pos.turn;
    let enemy = turn.other();
    let mut moves = Vec::new();
    let add = |moves: &mut Vec<Move>, from: usize, to: usize, pawn: bool| {
        if pawn && (rank_of(to) == 8 || rank_of(to) == 1) {
            for p in *b"qrbn" {
                moves.push(Move {
                    from,
                    to,
                    promo: Some(p),
                });
            }
        } else {
            moves.push(Move {
                from,
                to,
                promo: None,
            });
        }
    };
    for sq in 0..64 {
        let p = board[sq];
        if p == b'.' || color_of(p) != Some(turn) {
            continue;
        }
        let (row, col) = rc(sq);
        let t = type_of(p);
        if t == b'p' {
            let dir = if turn == Color::W { -1 } else { 1 };
            let start_row = if turn == Color::W { 6 } else { 1 };
            let one = row + dir;
            if on_board(col, one) && board[at(one, col)] == b'.' {
                add(&mut moves, sq, at(one, col), true);
                let two = row + 2 * dir;
                if row == start_row && board[at(two, col)] == b'.' {
                    moves.push(Move {
                        from: sq,
                        to: at(two, col),
                        promo: None,
                    });
                }
            }
            for dc in [-1, 1] {
                if !on_board(col + dc, one) {
                    continue;
                }
                let to = at(one, col + dc);
                let target = board[to];
                #[allow(clippy::cast_possible_wrap)]
                let is_ep = to as i64 == pos.ep;
                if (target != b'.' && color_of(target) == Some(enemy)) || is_ep {
                    add(&mut moves, sq, to, true);
                }
            }
        } else if t == b'n' || t == b'k' {
            for (dr, dc) in if t == b'n' { KNIGHT } else { KING } {
                if !on_board(col + dc, row + dr) {
                    continue;
                }
                let to = at(row + dr, col + dc);
                if color_of(board[to]) != Some(turn) {
                    moves.push(Move {
                        from: sq,
                        to,
                        promo: None,
                    });
                }
            }
        } else {
            let dirs: Vec<(i32, i32)> = match t {
                b'b' => DIAG.to_vec(),
                b'r' => ORTHO.to_vec(),
                _ => DIAG.iter().chain(ORTHO.iter()).copied().collect(),
            };
            for (dr, dc) in dirs {
                let (mut r, mut c) = (row + dr, col + dc);
                while on_board(c, r) {
                    let to = at(r, c);
                    let target = board[to];
                    if target == b'.' {
                        moves.push(Move {
                            from: sq,
                            to,
                            promo: None,
                        });
                    } else {
                        if color_of(target) == Some(enemy) {
                            moves.push(Move {
                                from: sq,
                                to,
                                promo: None,
                            });
                        }
                        break;
                    }
                    r += dr;
                    c += dc;
                }
            }
        }
    }
    let home: usize = if turn == Color::W { 60 } else { 4 };
    let (king, rook, ks, qs) = if turn == Color::W {
        (b'K', b'R', 'K', 'Q')
    } else {
        (b'k', b'r', 'k', 'q')
    };
    if board[home] == king && !attacked(board, home, enemy) {
        if pos.castling.contains(ks)
            && board[home + 1] == b'.'
            && board[home + 2] == b'.'
            && board[home + 3] == rook
            && !attacked(board, home + 1, enemy)
            && !attacked(board, home + 2, enemy)
        {
            moves.push(Move {
                from: home,
                to: home + 2,
                promo: None,
            });
        }
        if pos.castling.contains(qs)
            && board[home - 1] == b'.'
            && board[home - 2] == b'.'
            && board[home - 3] == b'.'
            && board[home - 4] == rook
            && !attacked(board, home - 1, enemy)
            && !attacked(board, home - 2, enemy)
        {
            moves.push(Move {
                from: home,
                to: home - 2,
                promo: None,
            });
        }
    }
    moves
}

/// The position after `m` (pseudo-legal for the side to move).
#[must_use]
pub fn make_move(pos: &Position, m: Move) -> Position {
    let mut b = pos.board.as_bytes().to_vec();
    let piece = b[m.from];
    let t = type_of(piece);
    let captured = b[m.to];
    let mut ep: i64 = -1;
    b[m.to] = match m.promo {
        Some(p) if pos.turn == Color::W => p.to_ascii_uppercase(),
        Some(p) => p,
        None => piece,
    };
    b[m.from] = b'.';
    #[allow(clippy::cast_possible_wrap)]
    if t == b'p' {
        if m.to as i64 == pos.ep {
            let victim = if pos.turn == Color::W { m.to + 8 } else { m.to - 8 };
            b[victim] = b'.';
        }
        if m.to.abs_diff(m.from) == 16 {
            ep = ((m.to + m.from) / 2) as i64;
        }
    }
    if t == b'k' && m.to.abs_diff(m.from) == 2 {
        if m.to > m.from {
            b[m.from + 1] = b[m.from + 3];
            b[m.from + 3] = b'.';
        } else {
            b[m.from - 1] = b[m.from - 4];
            b[m.from - 4] = b'.';
        }
    }
    let mut castling = pos.castling.clone();
    let drop = |castling: &mut String, sq: usize| {
        let lost = match sq {
            60 => "KQ",
            4 => "kq",
            63 => "K",
            56 => "Q",
            7 => "k",
            0 => "q",
            _ => "",
        };
        if !lost.is_empty() {
            castling.retain(|c| !lost.contains(c));
        }
    };
    drop(&mut castling, m.from);
    drop(&mut castling, m.to);
    let irreversible = t == b'p' || captured != b'.';
    Position {
        board: String::from_utf8_lossy(&b).into_owned(),
        turn: pos.turn.other(),
        castling,
        ep,
        half: if irreversible { 0 } else { pos.half + 1 },
        full: if pos.turn == Color::B {
            pos.full + 1
        } else {
            pos.full
        },
    }
}

/// Every legal move, in the web app's order.
#[must_use]
pub fn legal_moves(pos: &Position) -> Vec<Move> {
    pseudo_moves(pos)
        .into_iter()
        .filter(|&m| !in_check(&make_move(pos, m), pos.turn))
        .collect()
}

/// The legal move matching from/to (promotion defaults to queen).
#[must_use]
pub fn find_legal(pos: &Position, from: usize, to: usize, promo: Option<u8>) -> Option<Move> {
    let all: Vec<Move> = legal_moves(pos)
        .into_iter()
        .filter(|m| m.from == from && m.to == to)
        .collect();
    if all.is_empty() {
        return None;
    }
    if all.len() == 1 && all[0].promo.is_none() {
        return Some(all[0]);
    }
    let want = promo.unwrap_or(b'q');
    all.into_iter().find(|m| m.promo == Some(want))
}

/// The move's name (Nf3, exd5, O-O, e8=Q+, Qh4#).
#[must_use]
pub fn san(pos: &Position, m: Move) -> String {
    let board = pos.board.as_bytes();
    let piece = board[m.from];
    let t = type_of(piece);
    let mut name;
    if t == b'k' && m.to.abs_diff(m.from) == 2 {
        name = if m.to > m.from {
            "O-O".to_owned()
        } else {
            "O-O-O".to_owned()
        };
    } else {
        #[allow(clippy::cast_possible_wrap)]
        let capture = board[m.to] != b'.' || (t == b'p' && m.to as i64 == pos.ep);
        if t == b'p' {
            name = String::new();
            if capture {
                name.push(FILES[file_of(m.from)] as char);
                name.push('x');
            }
            name.push_str(&square_name(m.to));
            if let Some(p) = m.promo {
                name.push('=');
                name.push(p.to_ascii_uppercase() as char);
            }
        } else {
            let rivals: Vec<Move> = legal_moves(pos)
                .into_iter()
                .filter(|r| r.to == m.to && r.from != m.from && board[r.from] == piece)
                .collect();
            let mut dis = String::new();
            if !rivals.is_empty() {
                let same_file = rivals.iter().any(|r| file_of(r.from) == file_of(m.from));
                let same_rank = rivals.iter().any(|r| rank_of(r.from) == rank_of(m.from));
                if !same_file {
                    dis.push(FILES[file_of(m.from)] as char);
                } else if !same_rank {
                    dis = rank_of(m.from).to_string();
                } else {
                    dis = square_name(m.from);
                }
            }
            name = format!(
                "{}{dis}{}{}",
                t.to_ascii_uppercase() as char,
                if capture { "x" } else { "" },
                square_name(m.to)
            );
        }
    }
    let next = make_move(pos, m);
    if in_check(&next, next.turn) {
        name.push(if legal_moves(&next).is_empty() { '#' } else { '+' });
    }
    name
}

/// Neither side can mate.
#[must_use]
pub fn insufficient_material(board: &[u8]) -> bool {
    let mut pieces: Vec<(u8, usize)> = Vec::new();
    for (sq, &p) in board.iter().enumerate() {
        if p == b'.' || type_of(p) == b'k' {
            continue;
        }
        let t = type_of(p);
        if t == b'p' || t == b'r' || t == b'q' {
            return false;
        }
        pieces.push((t, sq));
    }
    if pieces.len() <= 1 {
        return true;
    }
    if pieces.iter().all(|(t, _)| *t == b'b') {
        let shade = |sq: usize| ((sq >> 3) + (sq & 7)) % 2;
        return pieces.iter().all(|(_, sq)| shade(*sq) == shade(pieces[0].1));
    }
    false
}

/// Key for threefold repetition.
#[must_use]
pub fn position_key(pos: &Position) -> String {
    let mut ep = "-".to_owned();
    #[allow(
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation,
        clippy::cast_possible_wrap
    )]
    if pos.ep >= 0
        && legal_moves(pos)
            .iter()
            .any(|m| m.to as i64 == pos.ep && type_of(pos.board.as_bytes()[m.from]) == b'p')
    {
        ep = square_name(pos.ep as usize);
    }
    format!(
        "{} {} {} {ep}",
        pos.board,
        pos.turn.key(),
        if pos.castling.is_empty() {
            "-"
        } else {
            &pos.castling
        }
    )
}

// ---- the computer --------------------------------------------------------------------------

/// Piece values.
#[must_use]
pub const fn piece_value(t: u8) -> i64 {
    match t {
        b'p' => 100,
        b'n' => 320,
        b'b' => 330,
        b'r' => 500,
        b'q' => 900,
        _ => 0,
    }
}

const CENTER: [i64; 8] = [0, 1, 2, 3, 3, 2, 1, 0];

fn square_bonus(t: u8, sq: usize, color: Color) -> i64 {
    #[allow(clippy::cast_possible_wrap)]
    let row = if color == Color::W {
        (sq >> 3) as i64
    } else {
        7 - (sq >> 3) as i64
    };
    let col = (sq & 7) as i64;
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let (cr, cc) = (CENTER[row as usize], CENTER[col as usize]);
    match t {
        b'p' => (6 - row) * 8 + (if (2..=5).contains(&col) { 6 } else { 0 }) * i64::from(row <= 4),
        b'n' => (cc + cr) * 6 - 10,
        b'b' => (cc + cr) * 3,
        b'q' => cc + cr,
        b'k' => {
            if row == 7 && (col <= 2 || col >= 6) {
                20
            } else if row == 7 {
                0
            } else {
                -15
            }
        }
        _ => 0,
    }
}

fn evaluate(pos: &Position) -> i64 {
    let mut score = 0;
    for (sq, &p) in pos.board.as_bytes().iter().enumerate() {
        let Some(c) = color_of(p) else { continue };
        let t = type_of(p);
        let v = piece_value(t) + square_bonus(t, sq, c);
        score += if c == pos.turn { v } else { -v };
    }
    score
}

const MATE: i64 = 100_000;

fn ordered(pos: &Position, moves: Vec<Move>) -> Vec<Move> {
    let b = pos.board.as_bytes();
    let gain = |m: &Move| {
        let victim = b[m.to];
        (if victim == b'.' {
            0
        } else {
            piece_value(type_of(victim)) * 10 - piece_value(type_of(b[m.from]))
        }) + if m.promo == Some(b'q') { 800 } else { 0 }
    };
    let mut scored: Vec<(i64, Move)> = moves.into_iter().map(|m| (gain(&m), m)).collect();
    scored.sort_by_key(|s| std::cmp::Reverse(s.0));
    scored.into_iter().map(|(_, m)| m).collect()
}

fn search(pos: &Position, mut depth: u32, mut alpha: i64, beta: i64, ply: i64) -> i64 {
    if depth == 0 {
        if ply > 5 || !in_check(pos, pos.turn) {
            return evaluate(pos);
        }
        depth = 1;
    }
    let moves = legal_moves(pos);
    if moves.is_empty() {
        return if in_check(pos, pos.turn) { -MATE + ply } else { 0 };
    }
    for m in ordered(pos, moves) {
        let score = -search(&make_move(pos, m), depth - 1, -beta, -alpha, ply + 1);
        if score >= beta {
            return beta;
        }
        if score > alpha {
            alpha = score;
        }
    }
    alpha
}

/// The computer's move (`botMove` at depth 2, searched in full), with a little randomness among
/// near-equal moves.
pub fn bot_move(pos: &Position, random: &mut dyn FnMut() -> f64) -> Option<Move> {
    let moves = ordered(pos, legal_moves(pos));
    if moves.is_empty() {
        return None;
    }
    let noise: Vec<f64> = moves.iter().map(|_| random() * 18.0).collect();
    let mut best = moves[0];
    for d in 0..=2 {
        let mut top = f64::NEG_INFINITY;
        let mut pick = moves[0];
        for (i, &m) in moves.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            let s = -(search(&make_move(pos, m), d, -MATE, MATE, 1) as f64) + noise[i];
            if s > top {
                top = s;
                pick = m;
            }
        }
        best = pick;
    }
    Some(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perft(pos: &Position, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let moves = legal_moves(pos);
        if depth == 1 {
            return moves.len() as u64;
        }
        moves
            .into_iter()
            .map(|m| perft(&make_move(pos, m), depth - 1))
            .sum()
    }

    #[test]
    fn perft_from_the_start() {
        assert_eq!(perft(&start(), 1), 20);
        assert_eq!(perft(&start(), 2), 400);
        assert_eq!(perft(&start(), 3), 8902);
    }

    #[test]
    fn names() {
        let p = start();
        let m = find_legal(&p, 52, 36, None).unwrap_or(Move {
            from: 0,
            to: 0,
            promo: None,
        });
        assert_eq!(san(&p, m), "e4");
        let m = find_legal(&p, 62, 45, None).unwrap_or(Move {
            from: 0,
            to: 0,
            promo: None,
        });
        assert_eq!(san(&p, m), "Nf3");
        assert!(position_key(&p).ends_with(" w KQkq -"));
    }
}
