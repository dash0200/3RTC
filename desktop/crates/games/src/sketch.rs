//! Sketch (`sketch/rules.ts`): one person draws a word, everyone else guesses it.
//!
//! Shared state `act:sketch` (these rules, run by the deciding app). The board is a whiteboard of
//! its own per turn (`act:sketch:t<turn>`, with chunks `act:sketch:t<turn>:<epoch>:<n>`, the
//! [`crate::whiteboard`] rules): only the drawer draws on it.
//!
//! * `lobby`: people join; anyone starts with 2 or more.
//! * `picking`: the drawer picks one of 3 words ([`PICK_MS`]; the first one if time runs out).
//! * `drawing`: [`DRAW_MS`] to guess; a letter of the hint shows at half time and at three
//!   quarters; ends early once everyone has it.
//! * `reveal`: the word and the points, [`REVEAL_MS`], then the next drawer.
//! * `over`: after everyone has drawn [`ROUNDS`] times: the scores; "Play again" goes back to the
//!   lobby.
//!
//! Secrets: [`redact`] sends the word (and the 3 choices) only to the drawer until it's revealed.
//! Only the deciding app holds it; if that changes mid-turn, the new one doesn't know the word and
//! ends the turn without points (`tick` with no word).
//!
//! Time: the deciding app sends `tick` about twice a second (taken only from itself); deadlines are
//! on its clock.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ActivityDef, Meta, Reducer, js_slice, js_string};

/// Its menu entry.
pub const DEF: ActivityDef = ActivityDef {
    id: "sketch",
    name: "Sketch",
    icon: "✏️",
    description: "One draws, everyone guesses the word, 2–10 players",
    min_people: 2,
};

/// The game's key.
pub const KEY: &str = "act:sketch";
/// Time to pick a word.
pub const PICK_MS: i64 = 15_000;
/// Time to draw and guess.
pub const DRAW_MS: i64 = 80_000;
/// Time the word shows after a turn.
pub const REVEAL_MS: i64 = 5_000;
/// Times everyone draws.
pub const ROUNDS: i64 = 2;
/// Most players.
pub const MAX_PLAYERS: usize = 10;
/// Points the drawer gets for each right guess.
pub const DRAWER_POINTS: i64 = 25;
/// Lines kept in the feed.
const FEED_MAX: usize = 40;
/// Longest guess (UTF-16 units, as the web app counts).
pub const GUESS_MAX: usize = 40;

/// The board's key for a turn (its whiteboard index).
#[must_use]
pub fn board_key(turn: i64) -> String {
    format!("{KEY}:t{turn}")
}

/// One player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Player {
    /// Peer id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Points.
    pub score: i64,
}

/// A line in the guesses feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedLine {
    /// Who (peer id), empty for the game itself.
    pub by: String,
    /// Their name.
    pub name: String,
    /// What to show.
    pub text: String,
    /// `guess`, `correct`, `close` or `info`.
    pub kind: String,
}

/// The game (`SketchState`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// `lobby`, `picking`, `drawing`, `reveal`, `over`.
    pub phase: String,
    /// Players in drawing order.
    pub players: Vec<Player>,
    /// Turns played so far (also the board's key).
    pub turn: i64,
    /// Who draws now.
    pub drawer: Option<String>,
    /// The 3 words to pick from (drawer only).
    pub choices: Vec<String>,
    /// The word (drawer only, until the reveal).
    pub word: String,
    /// What guessers see: `__a_`.
    pub hint: String,
    /// Letters in the word (for everyone).
    pub length: i64,
    /// When this phase ends (the deciding app's clock).
    pub deadline: i64,
    /// When drawing (or picking) began.
    pub turn_started: i64,
    /// Who guessed it this turn, in order.
    pub guessed: Vec<String>,
    /// Points this turn, shown at the reveal.
    pub gained: BTreeMap<String, i64>,
    /// The last word, once revealed.
    pub revealed: String,
    /// Words played this game.
    pub used: Vec<String>,
    /// Guesses and news.
    pub feed: Vec<FeedLine>,
}

impl State {
    /// The start.
    #[must_use]
    pub fn initial() -> Self {
        Self {
            phase: "lobby".into(),
            players: Vec::new(),
            turn: 0,
            drawer: None,
            choices: Vec::new(),
            word: String::new(),
            hint: String::new(),
            length: 0,
            deadline: 0,
            turn_started: 0,
            guessed: Vec::new(),
            gained: BTreeMap::new(),
            revealed: String::new(),
            used: Vec::new(),
            feed: Vec::new(),
        }
    }

    /// From shared state.
    #[must_use]
    pub fn from_value(v: &Value) -> Option<Self> {
        serde_json::from_value(v.clone()).ok()
    }

    fn value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// A player.
    #[must_use]
    pub fn player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }

    /// Turns in a game: everyone draws [`ROUNDS`] times.
    #[must_use]
    pub fn total_turns(&self) -> i64 {
        self.players.len() as i64 * ROUNDS
    }

    /// The turn whose board shows now (the one just played, during the reveal).
    #[must_use]
    pub fn board_turn(&self) -> i64 {
        if self.phase == "reveal" {
            (self.turn - 1).max(0)
        } else {
            self.turn
        }
    }

    fn feed_line(&mut self, line: FeedLine) {
        self.feed.push(line);
        if self.feed.len() > FEED_MAX {
            let extra = self.feed.len() - FEED_MAX;
            self.feed.drain(..extra);
        }
    }
}

// ---- words and guesses ----------------------------------------------------------------------

/// Words to draw: simple things anyone can sketch in a minute (`words.ts`).
#[rustfmt::skip]
pub const WORDS: &[&str] = &[
    "apple", "banana", "mango", "grapes", "pineapple", "watermelon", "carrot", "tomato",
    "onion", "potato", "corn", "mushroom", "pizza", "burger", "sandwich", "ice cream",
    "cake", "cookie", "donut", "popcorn", "noodles", "samosa", "dosa", "idli", "chai",
    "coffee", "teapot", "cup", "bottle", "spoon", "fork", "knife", "plate", "bowl", "cat",
    "dog", "cow", "horse", "elephant", "tiger", "lion", "monkey", "giraffe", "zebra",
    "rabbit", "mouse", "snake", "frog", "turtle", "fish", "shark", "whale", "dolphin",
    "octopus", "crab", "bird", "parrot", "peacock", "owl", "penguin", "duck", "chicken",
    "butterfly", "bee", "spider", "ant", "snail", "camel", "kangaroo", "sun", "moon", "star",
    "cloud", "rain", "rainbow", "snowman", "lightning", "tree", "flower", "rose", "leaf",
    "mountain", "volcano", "island", "beach", "river", "waterfall", "desert", "cactus",
    "house", "castle", "tent", "bridge", "tower", "lighthouse", "school", "hospital",
    "temple", "church", "windmill", "igloo", "pyramid", "car", "bus", "train", "bicycle",
    "motorcycle", "airplane", "helicopter", "rocket", "boat", "ship", "truck", "tractor",
    "auto rickshaw", "scooter", "submarine", "ball", "bat", "cricket", "football", "kite",
    "balloon", "guitar", "drum", "piano", "flute", "trumpet", "violin", "clock", "watch",
    "phone", "laptop", "television", "camera", "headphones", "remote", "keyboard",
    "computer", "robot", "lamp", "candle", "umbrella", "glasses", "hat", "crown", "shoe",
    "sock", "shirt", "dress", "backpack", "key", "lock", "door", "window", "chair", "table",
    "bed", "sofa", "ladder", "bucket", "broom", "scissors", "pencil", "book", "envelope",
    "gift", "heart", "smile", "ghost", "dragon", "unicorn", "mermaid", "pirate", "wizard",
    "ninja", "superhero", "alien", "astronaut", "king", "queen", "clown", "fire", "tornado",
    "snowflake", "anchor", "sword", "shield", "bow", "arrow", "treasure", "map", "compass",
    "magnet", "battery", "bulb", "toothbrush", "toilet", "bathtub", "shower", "mirror",
    "comb", "ring", "necklace", "wallet", "coin", "money", "goal", "swing", "slide",
    "seesaw", "tennis", "basketball", "bowling", "medal", "trophy", "selfie", "birthday",
    "wedding", "diwali", "holi", "fireworks",
];

/// Latin letters with accents (and full-width letters, ligatures, superscripts) as plain ones:
/// the part of JS `normalize('NFKD')` plus dropping accents that a guess can meet.
#[rustfmt::skip]
const FOLD: &[(char, &str)] = &[
    ('\u{a0}', " "), ('\u{a8}', " "), ('\u{aa}', "a"), ('\u{af}', " "), ('\u{b2}', "2"), ('\u{b3}', "3"),
    ('\u{b4}', " "), ('\u{b8}', " "), ('\u{b9}', "1"), ('\u{ba}', "o"), ('\u{e0}', "a"), ('\u{e1}', "a"),
    ('\u{e2}', "a"), ('\u{e3}', "a"), ('\u{e4}', "a"), ('\u{e5}', "a"), ('\u{e7}', "c"), ('\u{e8}', "e"),
    ('\u{e9}', "e"), ('\u{ea}', "e"), ('\u{eb}', "e"), ('\u{ec}', "i"), ('\u{ed}', "i"), ('\u{ee}', "i"),
    ('\u{ef}', "i"), ('\u{f1}', "n"), ('\u{f2}', "o"), ('\u{f3}', "o"), ('\u{f4}', "o"), ('\u{f5}', "o"),
    ('\u{f6}', "o"), ('\u{f9}', "u"), ('\u{fa}', "u"), ('\u{fb}', "u"), ('\u{fc}', "u"), ('\u{fd}', "y"),
    ('\u{ff}', "y"), ('\u{101}', "a"), ('\u{103}', "a"), ('\u{105}', "a"), ('\u{107}', "c"), ('\u{109}', "c"),
    ('\u{10b}', "c"), ('\u{10d}', "c"), ('\u{10f}', "d"), ('\u{113}', "e"), ('\u{115}', "e"), ('\u{117}', "e"),
    ('\u{119}', "e"), ('\u{11b}', "e"), ('\u{11d}', "g"), ('\u{11f}', "g"), ('\u{121}', "g"), ('\u{123}', "g"),
    ('\u{125}', "h"), ('\u{129}', "i"), ('\u{12b}', "i"), ('\u{12d}', "i"), ('\u{12f}', "i"), ('\u{133}', "ij"),
    ('\u{135}', "j"), ('\u{137}', "k"), ('\u{13a}', "l"), ('\u{13c}', "l"), ('\u{13e}', "l"), ('\u{144}', "n"),
    ('\u{146}', "n"), ('\u{148}', "n"), ('\u{14d}', "o"), ('\u{14f}', "o"), ('\u{151}', "o"), ('\u{155}', "r"),
    ('\u{157}', "r"), ('\u{159}', "r"), ('\u{15b}', "s"), ('\u{15d}', "s"), ('\u{15f}', "s"), ('\u{161}', "s"),
    ('\u{163}', "t"), ('\u{165}', "t"), ('\u{169}', "u"), ('\u{16b}', "u"), ('\u{16d}', "u"), ('\u{16f}', "u"),
    ('\u{171}', "u"), ('\u{173}', "u"), ('\u{175}', "w"), ('\u{177}', "y"), ('\u{17a}', "z"), ('\u{17c}', "z"),
    ('\u{17e}', "z"), ('\u{17f}', "s"), ('\u{1a1}', "o"), ('\u{1b0}', "u"), ('\u{1c6}', "dz"), ('\u{1c9}', "lj"),
    ('\u{1cc}', "nj"), ('\u{1ce}', "a"), ('\u{1d0}', "i"), ('\u{1d2}', "o"), ('\u{1d4}', "u"), ('\u{1d6}', "u"),
    ('\u{1d8}', "u"), ('\u{1da}', "u"), ('\u{1dc}', "u"), ('\u{1df}', "a"), ('\u{1e1}', "a"), ('\u{1e7}', "g"),
    ('\u{1e9}', "k"), ('\u{1eb}', "o"), ('\u{1ed}', "o"), ('\u{1f0}', "j"), ('\u{1f3}', "dz"), ('\u{1f5}', "g"),
    ('\u{1f9}', "n"), ('\u{1fb}', "a"), ('\u{201}', "a"), ('\u{203}', "a"), ('\u{205}', "e"), ('\u{207}', "e"),
    ('\u{209}', "i"), ('\u{20b}', "i"), ('\u{20d}', "o"), ('\u{20f}', "o"), ('\u{211}', "r"), ('\u{213}', "r"),
    ('\u{215}', "u"), ('\u{217}', "u"), ('\u{219}', "s"), ('\u{21b}', "t"), ('\u{21f}', "h"), ('\u{227}', "a"),
    ('\u{229}', "e"), ('\u{22b}', "o"), ('\u{22d}', "o"), ('\u{22f}', "o"), ('\u{231}', "o"), ('\u{233}', "y"),
    ('\u{1e01}', "a"), ('\u{1e03}', "b"), ('\u{1e05}', "b"), ('\u{1e07}', "b"), ('\u{1e09}', "c"), ('\u{1e0b}', "d"),
    ('\u{1e0d}', "d"), ('\u{1e0f}', "d"), ('\u{1e11}', "d"), ('\u{1e13}', "d"), ('\u{1e15}', "e"), ('\u{1e17}', "e"),
    ('\u{1e19}', "e"), ('\u{1e1b}', "e"), ('\u{1e1d}', "e"), ('\u{1e1f}', "f"), ('\u{1e21}', "g"), ('\u{1e23}', "h"),
    ('\u{1e25}', "h"), ('\u{1e27}', "h"), ('\u{1e29}', "h"), ('\u{1e2b}', "h"), ('\u{1e2d}', "i"), ('\u{1e2f}', "i"),
    ('\u{1e31}', "k"), ('\u{1e33}', "k"), ('\u{1e35}', "k"), ('\u{1e37}', "l"), ('\u{1e39}', "l"), ('\u{1e3b}', "l"),
    ('\u{1e3d}', "l"), ('\u{1e3f}', "m"), ('\u{1e41}', "m"), ('\u{1e43}', "m"), ('\u{1e45}', "n"), ('\u{1e47}', "n"),
    ('\u{1e49}', "n"), ('\u{1e4b}', "n"), ('\u{1e4d}', "o"), ('\u{1e4f}', "o"), ('\u{1e51}', "o"), ('\u{1e53}', "o"),
    ('\u{1e55}', "p"), ('\u{1e57}', "p"), ('\u{1e59}', "r"), ('\u{1e5b}', "r"), ('\u{1e5d}', "r"), ('\u{1e5f}', "r"),
    ('\u{1e61}', "s"), ('\u{1e63}', "s"), ('\u{1e65}', "s"), ('\u{1e67}', "s"), ('\u{1e69}', "s"), ('\u{1e6b}', "t"),
    ('\u{1e6d}', "t"), ('\u{1e6f}', "t"), ('\u{1e71}', "t"), ('\u{1e73}', "u"), ('\u{1e75}', "u"), ('\u{1e77}', "u"),
    ('\u{1e79}', "u"), ('\u{1e7b}', "u"), ('\u{1e7d}', "v"), ('\u{1e7f}', "v"), ('\u{1e81}', "w"), ('\u{1e83}', "w"),
    ('\u{1e85}', "w"), ('\u{1e87}', "w"), ('\u{1e89}', "w"), ('\u{1e8b}', "x"), ('\u{1e8d}', "x"), ('\u{1e8f}', "y"),
    ('\u{1e91}', "z"), ('\u{1e93}', "z"), ('\u{1e95}', "z"), ('\u{1e96}', "h"), ('\u{1e97}', "t"), ('\u{1e98}', "w"),
    ('\u{1e99}', "y"), ('\u{1e9b}', "s"), ('\u{1ea1}', "a"), ('\u{1ea3}', "a"), ('\u{1ea5}', "a"), ('\u{1ea7}', "a"),
    ('\u{1ea9}', "a"), ('\u{1eab}', "a"), ('\u{1ead}', "a"), ('\u{1eaf}', "a"), ('\u{1eb1}', "a"), ('\u{1eb3}', "a"),
    ('\u{1eb5}', "a"), ('\u{1eb7}', "a"), ('\u{1eb9}', "e"), ('\u{1ebb}', "e"), ('\u{1ebd}', "e"), ('\u{1ebf}', "e"),
    ('\u{1ec1}', "e"), ('\u{1ec3}', "e"), ('\u{1ec5}', "e"), ('\u{1ec7}', "e"), ('\u{1ec9}', "i"), ('\u{1ecb}', "i"),
    ('\u{1ecd}', "o"), ('\u{1ecf}', "o"), ('\u{1ed1}', "o"), ('\u{1ed3}', "o"), ('\u{1ed5}', "o"), ('\u{1ed7}', "o"),
    ('\u{1ed9}', "o"), ('\u{1edb}', "o"), ('\u{1edd}', "o"), ('\u{1edf}', "o"), ('\u{1ee1}', "o"), ('\u{1ee3}', "o"),
    ('\u{1ee5}', "u"), ('\u{1ee7}', "u"), ('\u{1ee9}', "u"), ('\u{1eeb}', "u"), ('\u{1eed}', "u"), ('\u{1eef}', "u"),
    ('\u{1ef1}', "u"), ('\u{1ef3}', "y"), ('\u{1ef5}', "y"), ('\u{1ef7}', "y"), ('\u{1ef9}', "y"), ('\u{2070}', "0"),
    ('\u{2071}', "i"), ('\u{2074}', "4"), ('\u{2075}', "5"), ('\u{2076}', "6"), ('\u{2077}', "7"), ('\u{2078}', "8"),
    ('\u{2079}', "9"), ('\u{207a}', "+"), ('\u{207c}', "="), ('\u{207d}', "("), ('\u{207e}', ")"), ('\u{207f}', "n"),
    ('\u{2080}', "0"), ('\u{2081}', "1"), ('\u{2082}', "2"), ('\u{2083}', "3"), ('\u{2084}', "4"), ('\u{2085}', "5"),
    ('\u{2086}', "6"), ('\u{2087}', "7"), ('\u{2088}', "8"), ('\u{2089}', "9"), ('\u{208a}', "+"), ('\u{208c}', "="),
    ('\u{208d}', "("), ('\u{208e}', ")"), ('\u{2090}', "a"), ('\u{2091}', "e"), ('\u{2092}', "o"), ('\u{2093}', "x"),
    ('\u{2095}', "h"), ('\u{2096}', "k"), ('\u{2097}', "l"), ('\u{2098}', "m"), ('\u{2099}', "n"), ('\u{209a}', "p"),
    ('\u{209b}', "s"), ('\u{209c}', "t"), ('\u{fb00}', "ff"), ('\u{fb01}', "fi"), ('\u{fb02}', "fl"), ('\u{fb03}', "ffi"),
    ('\u{fb04}', "ffl"), ('\u{fb05}', "st"), ('\u{fb06}', "st"), ('\u{ff01}', "!"), ('\u{ff02}', "\""), ('\u{ff03}', "#"),
    ('\u{ff04}', "$"), ('\u{ff05}', "%"), ('\u{ff06}', "&"), ('\u{ff07}', "'"), ('\u{ff08}', "("), ('\u{ff09}', ")"),
    ('\u{ff0a}', "*"), ('\u{ff0b}', "+"), ('\u{ff0c}', ","), ('\u{ff0d}', "-"), ('\u{ff0e}', "."), ('\u{ff0f}', "/"),
    ('\u{ff10}', "0"), ('\u{ff11}', "1"), ('\u{ff12}', "2"), ('\u{ff13}', "3"), ('\u{ff14}', "4"), ('\u{ff15}', "5"),
    ('\u{ff16}', "6"), ('\u{ff17}', "7"), ('\u{ff18}', "8"), ('\u{ff19}', "9"), ('\u{ff1a}', ":"), ('\u{ff1b}', ";"),
    ('\u{ff1c}', "<"), ('\u{ff1d}', "="), ('\u{ff1e}', ">"), ('\u{ff1f}', "?"), ('\u{ff20}', "@"), ('\u{ff3b}', "["),
    ('\u{ff3c}', "\\"), ('\u{ff3d}', "]"), ('\u{ff3e}', "^"), ('\u{ff3f}', "_"), ('\u{ff40}', "`"), ('\u{ff41}', "a"),
    ('\u{ff42}', "b"), ('\u{ff43}', "c"), ('\u{ff44}', "d"), ('\u{ff45}', "e"), ('\u{ff46}', "f"), ('\u{ff47}', "g"),
    ('\u{ff48}', "h"), ('\u{ff49}', "i"), ('\u{ff4a}', "j"), ('\u{ff4b}', "k"), ('\u{ff4c}', "l"), ('\u{ff4d}', "m"),
    ('\u{ff4e}', "n"), ('\u{ff4f}', "o"), ('\u{ff50}', "p"), ('\u{ff51}', "q"), ('\u{ff52}', "r"), ('\u{ff53}', "s"),
    ('\u{ff54}', "t"), ('\u{ff55}', "u"), ('\u{ff56}', "v"), ('\u{ff57}', "w"), ('\u{ff58}', "x"), ('\u{ff59}', "y"),
    ('\u{ff5a}', "z"), ('\u{ff5b}', "{"), ('\u{ff5c}', "|"), ('\u{ff5d}', "}"), ('\u{ff5e}', "~"),
];

/// JS `\s` (and what `trim()` drops).
fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

/// JS `trim()`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// How a guess is compared: lower case, letters and digits only, spaces squeezed.
#[must_use]
pub fn normalize(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for c in text.to_lowercase().chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        match FOLD.binary_search_by_key(&c, |&(k, _)| k) {
            Ok(i) => folded.push_str(FOLD[i].1),
            Err(_) => folded.push(c),
        }
    }
    let mut out = String::with_capacity(folded.len());
    let mut gap = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// Edit distance, stopping early once it's over `max`.
#[must_use]
pub fn distance(a: &str, b: &str, max: usize) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return max + 1;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut row = vec![i; b.len() + 1];
        let mut best = i;
        for j in 1..=b.len() {
            let swap = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            row[j] = (prev[j] + 1).min(row[j - 1] + 1).min(swap);
            best = best.min(row[j]);
        }
        if best > max {
            return max + 1;
        }
        prev = row;
    }
    prev[b.len()]
}

/// The hint: letters as `_`, spaces kept, and the letters at `shown` positions.
#[must_use]
pub fn hint_for(word: &str, shown: &[usize]) -> String {
    word.chars()
        .enumerate()
        .map(|(i, c)| {
            if c == ' ' {
                ' '
            } else if shown.contains(&i) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Letter positions shown at this point of the turn: one at half time, two at three quarters.
#[must_use]
pub fn shown_letters(word: &str, elapsed_share: f64, seed: i64) -> Vec<usize> {
    let letters: Vec<usize> = word
        .chars()
        .enumerate()
        .filter(|&(_, c)| c != ' ')
        .map(|(i, _)| i)
        .collect();
    let want = if elapsed_share >= 0.75 {
        2
    } else if elapsed_share >= 0.5 {
        1
    } else {
        0
    };
    let count = want.min(letters.len().saturating_sub(1));
    let mut out = Vec::new();
    for k in 0..count {
        let at = (seed * 7 + k as i64 * 13).rem_euclid(letters.len() as i64);
        let pick = letters[usize::try_from(at).unwrap_or(0)];
        if !out.contains(&pick) {
            out.push(pick);
        }
    }
    out
}

/// Three different words, not used in this game yet if possible.
fn pick_choices(meta: &mut Meta<'_>, avoid: &[String]) -> Vec<String> {
    let pool: Vec<&str> = WORDS
        .iter()
        .copied()
        .filter(|w| !avoid.iter().any(|a| a == w))
        .collect();
    let from: Vec<&str> = if pool.len() >= 3 { pool } else { WORDS.to_vec() };
    let mut out: Vec<String> = Vec::new();
    while out.len() < 3 {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let at = ((meta.random)() * from.len() as f64).floor() as usize % from.len();
        let w = from[at];
        if !out.iter().any(|o| o == w) {
            out.push(w.to_owned());
        }
    }
    out
}

/// Points for guessing: more the sooner it is, 50 to 100.
#[must_use]
pub fn guess_points(remaining_share: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let extra = (50.0 * remaining_share.clamp(0.0, 1.0)).round() as i64;
    50 + extra
}

// ---- the rules ------------------------------------------------------------------------------

/// JS `String(x ?? '')`.
fn text_of(v: &Value) -> String {
    if v.is_null() { String::new() } else { js_string(v) }
}

fn clean_name(name: &Value) -> String {
    let raw = text_of(name);
    let mut squeezed = String::with_capacity(raw.len());
    let mut gap = false;
    for c in raw.chars() {
        if js_space(c) {
            if !gap {
                squeezed.push(' ');
            }
            gap = true;
        } else {
            gap = false;
            squeezed.push(c);
        }
    }
    let s = js_slice(js_trim(&squeezed), 24);
    if s.is_empty() { "Someone".to_owned() } else { s }
}

/// JS `array[i]` for an index from a message (`0`, `"1"`, …): the position, if there is one.
fn js_index(v: &Value, len: usize) -> Option<usize> {
    let key = js_string(v);
    let n: usize = key.parse().ok()?;
    (n.to_string() == key && n < len).then_some(n)
}

fn info(text: String) -> FeedLine {
    FeedLine {
        by: String::new(),
        name: String::new(),
        text,
        kind: "info".into(),
    }
}

/// Players still here (connected and in the game).
fn here<'s>(s: &'s State, meta: &Meta<'_>) -> Vec<&'s Player> {
    s.players
        .iter()
        .filter(|p| meta.present.contains(&p.id))
        .collect()
}

/// The next drawer after the current one, skipping people who left.
fn next_drawer(s: &State, meta: &Meta<'_>) -> Option<String> {
    let ids: Vec<&str> = here(s, meta).iter().map(|p| p.id.as_str()).collect();
    if ids.is_empty() {
        return None;
    }
    let order: Vec<&str> = s.players.iter().map(|p| p.id.as_str()).collect();
    let len = order.len() as i64;
    let at = s
        .drawer
        .as_deref()
        .and_then(|d| order.iter().position(|o| *o == d))
        .map_or(-1, |i| i as i64);
    for step in 1..=len {
        let id = order[usize::try_from((at + step + len) % len).unwrap_or(0)];
        if ids.contains(&id) {
            return Some(id.to_owned());
        }
    }
    None
}

fn start_turn(s: &State, meta: &mut Meta<'_>, now: i64) -> State {
    let mut o = s.clone();
    if s.turn >= s.total_turns() || here(s, meta).len() < 2 {
        o.phase = "over".into();
        o.drawer = None;
        o.choices = Vec::new();
        o.word = String::new();
        o.hint = String::new();
        o.length = 0;
        o.deadline = 0;
        return o;
    }
    let Some(drawer) = next_drawer(s, meta) else {
        o.phase = "over".into();
        return o;
    };
    o.phase = "picking".into();
    o.drawer = Some(drawer);
    o.choices = pick_choices(meta, &s.used);
    o.word = String::new();
    o.hint = String::new();
    o.length = 0;
    o.guessed = Vec::new();
    o.gained = BTreeMap::new();
    o.deadline = now + PICK_MS;
    o.turn_started = now;
    o
}

fn begin_drawing(s: &State, word: &str, now: i64) -> State {
    let mut o = s.clone();
    let name = s
        .drawer
        .as_deref()
        .and_then(|d| s.player(d))
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Someone".into());
    o.phase = "drawing".into();
    o.word = word.to_owned();
    o.choices = Vec::new();
    o.hint = hint_for(word, &[]);
    o.length = word.encode_utf16().filter(|&u| u != u16::from(b' ')).count() as i64;
    o.deadline = now + DRAW_MS;
    o.turn_started = now;
    o.feed_line(info(format!("{name} is drawing")));
    o
}

fn end_turn(s: &State, reason: &str, now: i64) -> State {
    let mut o = s.clone();
    let word = s.word.clone();
    o.phase = "reveal".into();
    o.revealed.clone_from(&word);
    o.word = String::new();
    o.choices = Vec::new();
    o.hint = if word.is_empty() {
        String::new()
    } else {
        let all: Vec<usize> = (0..word.chars().count()).collect();
        hint_for(&word, &all)
    };
    o.turn = s.turn + 1;
    if !word.is_empty() {
        o.used.push(word.clone());
        if o.used.len() > 200 {
            let extra = o.used.len() - 200;
            o.used.drain(..extra);
        }
    }
    o.deadline = now + REVEAL_MS;
    o.turn_started = 0;
    o.feed_line(info(if word.is_empty() {
        reason.to_owned()
    } else {
        format!("{reason} The word was “{word}”.")
    }));
    o
}

/// The deciding app's own action.
fn from_authority(meta: &Meta<'_>) -> bool {
    !meta.self_id.is_empty() && meta.by == meta.self_id
}

fn drawer_here(s: &State, meta: &Meta<'_>) -> bool {
    s.drawer
        .as_deref()
        .is_some_and(|d| meta.present.iter().any(|p| p == d))
}

/// The next state, or `None` when the web app returns the same one (rejected or nothing new).
#[allow(clippy::too_many_lines)]
fn step(s: &State, a: &Value, meta: &mut Meta<'_>) -> Option<State> {
    #[allow(clippy::cast_possible_truncation)]
    let now = meta.now_ms.floor() as i64;
    let me = s.player(meta.by).cloned();
    let is_drawer = s.drawer.as_deref() == Some(meta.by);
    match a.get("kind").and_then(Value::as_str) {
        Some("join") => {
            if me.is_some() || s.players.len() >= MAX_PLAYERS {
                return None;
            }
            let mut o = s.clone();
            o.players.push(Player {
                id: meta.by.to_owned(),
                name: clean_name(&a["name"]),
                score: 0,
            });
            Some(o)
        }
        Some("leave") => {
            let me = me?;
            let mut o = s.clone();
            o.players.retain(|p| p.id != meta.by);
            if is_drawer && (s.phase == "picking" || s.phase == "drawing") {
                o.drawer = None;
                return Some(end_turn(&o, &format!("{} left.", me.name), now));
            }
            Some(o)
        }
        Some("start") => {
            if s.phase != "lobby" || me.is_none() || here(s, meta).len() < 2 {
                return None;
            }
            let mut fresh = s.clone();
            fresh.turn = 0;
            fresh.drawer = None;
            for p in &mut fresh.players {
                p.score = 0;
            }
            fresh.feed = Vec::new();
            fresh.revealed = String::new();
            fresh.used = Vec::new();
            Some(start_turn(&fresh, meta, now))
        }
        Some("pick") => {
            if s.phase != "picking" || !is_drawer {
                return None;
            }
            let i = js_index(&a["index"], s.choices.len())?;
            Some(begin_drawing(s, &s.choices[i], now))
        }
        Some("skip") => {
            if (s.phase != "picking" && s.phase != "drawing") || !is_drawer {
                return None;
            }
            let name = me.map(|p| p.name).filter(|n| !n.is_empty());
            let name = name.unwrap_or_else(|| "The drawer".into());
            Some(end_turn(s, &format!("{name} skipped."), now))
        }
        Some("guess") => {
            let me = me?;
            if s.phase != "drawing" || is_drawer || s.guessed.iter().any(|g| g == meta.by) {
                return None;
            }
            let text = js_trim(&js_slice(&text_of(&a["text"]), GUESS_MAX)).to_owned();
            if text.is_empty() || s.word.is_empty() {
                return None;
            }
            let guess = normalize(&text);
            let target = normalize(&s.word);
            let mut o = s.clone();
            if guess == target {
                #[allow(clippy::cast_precision_loss)]
                let points = guess_points((s.deadline - now) as f64 / DRAW_MS as f64);
                for p in &mut o.players {
                    if p.id == meta.by {
                        p.score += points;
                    } else if s.drawer.as_deref() == Some(p.id.as_str()) {
                        p.score += DRAWER_POINTS;
                    }
                }
                *o.gained.entry(meta.by.to_owned()).or_insert(0) += points;
                if let Some(d) = &s.drawer {
                    *o.gained.entry(d.clone()).or_insert(0) += DRAWER_POINTS;
                }
                o.guessed.push(meta.by.to_owned());
                o.feed_line(FeedLine {
                    by: meta.by.to_owned(),
                    name: me.name.clone(),
                    text: format!("{} guessed it!", me.name),
                    kind: "correct".into(),
                });
                let everyone = here(&o, meta)
                    .iter()
                    .filter(|p| s.drawer.as_deref() != Some(p.id.as_str()))
                    .all(|p| o.guessed.contains(&p.id));
                return Some(if everyone {
                    end_turn(&o, "Everyone got it!", now)
                } else {
                    o
                });
            }
            let close = target.len() >= 4 && distance(&guess, &target, 1) <= 1;
            o.feed_line(if close {
                FeedLine {
                    by: meta.by.to_owned(),
                    name: me.name.clone(),
                    text: format!("{} is close!", me.name),
                    kind: "close".into(),
                }
            } else {
                FeedLine {
                    by: meta.by.to_owned(),
                    name: me.name,
                    text,
                    kind: "guess".into(),
                }
            });
            Some(o)
        }
        Some("again") => {
            if s.phase != "over" || me.is_none() {
                return None;
            }
            let mut o = State::initial();
            o.players = s
                .players
                .iter()
                .map(|p| Player {
                    score: 0,
                    ..p.clone()
                })
                .collect();
            Some(o)
        }
        Some("tick") => {
            if !from_authority(meta) {
                return None;
            }
            match s.phase.as_str() {
                "picking" => {
                    if !drawer_here(s, meta) {
                        return Some(end_turn(s, "The drawer left.", now));
                    }
                    if s.choices.is_empty() {
                        return Some(end_turn(s, "That turn was lost.", now));
                    }
                    (now >= s.deadline).then(|| begin_drawing(s, &s.choices[0], now))
                }
                "drawing" => {
                    if s.word.is_empty() {
                        return Some(end_turn(
                            s,
                            "That turn was lost (someone else is keeping score now).",
                            now,
                        ));
                    }
                    if !drawer_here(s, meta) {
                        return Some(end_turn(s, "The drawer left.", now));
                    }
                    if now >= s.deadline {
                        return Some(end_turn(s, "Time’s up!", now));
                    }
                    #[allow(clippy::cast_precision_loss)]
                    let share = 1.0 - (s.deadline - now) as f64 / DRAW_MS as f64;
                    let seed = s.turn + s.word.encode_utf16().count() as i64;
                    let hint = hint_for(&s.word, &shown_letters(&s.word, share, seed));
                    (hint != s.hint).then(|| State { hint, ..s.clone() })
                }
                "reveal" => (now >= s.deadline).then(|| start_turn(s, meta, now)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// What a peer is sent: the word and the choices only to the drawer, until the reveal.
#[must_use]
pub fn redact(s: &State, peer: &str) -> State {
    if s.drawer.as_deref() == Some(peer) || (s.word.is_empty() && s.choices.is_empty()) {
        return s.clone();
    }
    State {
        word: String::new(),
        choices: Vec::new(),
        ..s.clone()
    }
}

/// The rules of `act:sketch`.
pub struct Sketch;

impl Reducer for Sketch {
    fn initial(&self) -> Value {
        State::initial().value()
    }

    fn reduce(&self, state: &Value, action: &Value, meta: &mut Meta<'_>) -> Option<Value> {
        let s = State::from_value(state)?;
        step(&s, action, meta).map(|n| n.value())
    }

    fn redacts(&self) -> bool {
        true
    }

    fn redact(&self, state: &Value, peer: &str) -> Option<Value> {
        State::from_value(state).map(|s| redact(&s, peer).value())
    }
}

/// Actions, for the UI.
pub mod act {
    use serde_json::{Value, json};

    /// Join the game.
    #[must_use]
    pub fn join(name: &str) -> Value {
        json!({ "kind": "join", "name": name })
    }
    /// Leave the game.
    #[must_use]
    pub fn leave() -> Value {
        json!({ "kind": "leave" })
    }
    /// Start (2 or more).
    #[must_use]
    pub fn start() -> Value {
        json!({ "kind": "start" })
    }
    /// The drawer picks a word.
    #[must_use]
    pub fn pick(index: usize) -> Value {
        json!({ "kind": "pick", "index": index })
    }
    /// A guess.
    #[must_use]
    pub fn guess(text: &str) -> Value {
        json!({ "kind": "guess", "text": text })
    }
    /// The drawer gives up the turn.
    #[must_use]
    pub fn skip() -> Value {
        json!({ "kind": "skip" })
    }
    /// Back to the lobby after a game.
    #[must_use]
    pub fn again() -> Value {
        json!({ "kind": "again" })
    }
    /// The deciding app's clock.
    #[must_use]
    pub fn tick() -> Value {
        json!({ "kind": "tick" })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn guesses_compare_like_the_web_app() {
        assert_eq!(normalize("  Ice-Cream!! "), "ice cream");
        assert_eq!(normalize("Pízza"), "pizza");
        assert_eq!(normalize("ＣＡＴ"), "cat");
        assert_eq!(distance("pizza", "piza", 1), 1);
        assert_eq!(distance("pizza", "pasta", 1), 2);
        assert_eq!(hint_for("ice cream", &[0]), "i__ _____");
        assert_eq!(guess_points(1.0), 100);
        assert_eq!(guess_points(-3.0), 50);
        assert_eq!(WORDS.len(), 222);
    }

    #[test]
    fn hints_never_show_the_whole_word() {
        assert!(shown_letters("cat", 0.4, 3).is_empty());
        assert_eq!(shown_letters("cat", 0.6, 6).len(), 1);
        assert_eq!(shown_letters("ox", 0.9, 4).len(), 1);
    }
}
