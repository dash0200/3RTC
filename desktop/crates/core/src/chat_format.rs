//! Rich chat text, the web app's rules (`client-ts/src/utils/chatFormat.ts`): simple markdown,
//! links and @mentions, as pieces of text with their style. The app draws them as styled text, so
//! nothing in a message is ever interpreted as markup.
//!
//! - `code` (nothing inside is formatted)
//! - **bold**, *italic*, _italic_, ~~struck~~ (the marker must touch the text it wraps; `_` only
//!   between non-word characters, so `snake_case` stays plain)
//! - `https://…`, `www.…` links
//! - `@Name` mentions of someone in the room (longest name first, any case, not inside an address)

/// Someone who can be @mentioned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionTarget {
    /// Their peer id.
    pub peer_id: String,
    /// Their display name.
    pub name: String,
    /// It's us (shown highlighted).
    pub is_self: bool,
}

/// A run of text and how it looks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Piece {
    /// The text as shown (markers removed).
    pub text: String,
    /// **bold**
    pub bold: bool,
    /// *italic*
    pub italic: bool,
    /// ~~struck~~
    pub strike: bool,
    /// `code`
    pub code: bool,
    /// A link to this address.
    pub link: Option<String>,
    /// A mention of this peer id.
    pub mention: Option<String>,
    /// A mention of us.
    pub mentions_self: bool,
}

/// Most people one message can mention (`MAX_MENTIONS`).
pub const MAX_MENTIONS: usize = 10;
/// Longest reply quote, in characters (`REPLY_SNIPPET_CHARS`).
pub const REPLY_SNIPPET_CHARS: usize = 140;
const MAX_DEPTH: usize = 4;

#[derive(Clone, Copy, Default)]
struct Emphasis {
    bold: bool,
    italic: bool,
    strike: bool,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The formatted pieces of a chat message.
#[must_use]
pub fn format_chat(text: &str, targets: &[MentionTarget]) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some((start, end)) = find_code(rest) {
        plain_part(&rest[..start], targets, &mut out);
        out.push(Piece {
            text: rest[start + 1..end - 1].to_owned(),
            code: true,
            ..Piece::default()
        });
        rest = &rest[end..];
    }
    plain_part(rest, targets, &mut out);
    out
}

/// The first `` `code` `` span (byte range including the backticks): one line, not empty.
fn find_code(s: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(i) = s[from..].find('`').map(|i| i + from) {
        let after = &s[i + 1..];
        match after.find(['`', '\n']) {
            Some(j) if after.as_bytes()[j] == b'`' && j > 0 => return Some((i, i + 1 + j + 1)),
            Some(j) => from = i + 1 + j,
            None => return None,
        }
    }
    None
}

fn plain_part(s: &str, targets: &[MentionTarget], out: &mut Vec<Piece>) {
    for (piece, href) in split_links(s) {
        if let Some(href) = href {
            out.push(Piece {
                text: piece.to_owned(),
                link: Some(href),
                ..Piece::default()
            });
        } else {
            emphasis(piece, targets, Emphasis::default(), 0, out);
        }
    }
}

/// Web links in text, as `splitLinks` (`client-ts/src/utils/chatLinks.ts`) finds them: pieces of
/// text, each with its link address if it is one.
#[must_use]
pub fn split_links(s: &str) -> Vec<(&str, Option<String>)> {
    let mut parts = Vec::new();
    let mut last = 0;
    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let lower: String = rest.chars().take(8).collect::<String>().to_ascii_lowercase();
        let starts =
            lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("www.");
        let at_word_start = s[..i].chars().next_back().is_none_or(|c| !is_word(c));
        if starts && at_word_start {
            let raw_end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`'))
                .unwrap_or(rest.len());
            let url = trim_link(&rest[..raw_end]);
            if url.len() >= 5 && !url.eq_ignore_ascii_case("www.") {
                if i > last {
                    parts.push((&s[last..i], None));
                }
                let href = if url.to_ascii_lowercase().starts_with("www.") {
                    format!("https://{url}")
                } else {
                    url.to_owned()
                };
                parts.push((url, Some(href)));
                last = i + url.len();
                i = last;
                continue;
            }
        }
        i += rest.chars().next().map_or(1, char::len_utf8);
    }
    if last < s.len() {
        parts.push((&s[last..], None));
    }
    parts
}

/// Punctuation that ends the sentence, not the link (a closing bracket only when unmatched).
fn trim_link(raw: &str) -> &str {
    let trailing = |c: char| {
        matches!(
            c,
            '.' | ',' | '!' | '?' | ';' | ':' | '\'' | '"' | '’' | '”' | '*'
        )
    };
    let mut url = raw.trim_end_matches(trailing);
    for (open, close) in [('(', ')'), ('[', ']'), ('{', '}')] {
        while url.ends_with(close) && url.matches(open).count() < url.matches(close).count() {
            url = url[..url.len() - 1].trim_end_matches(trailing);
        }
    }
    url
}

/// Where an emphasis starts and ends: (start, content start, content end, end), byte offsets.
type Span = (usize, usize, usize, usize);

fn find_delimited(s: &str, marker: &str) -> Option<Span> {
    let mut from = 0;
    while let Some(start) = s[from..].find(marker).map(|i| i + from) {
        let inner = start + marker.len();
        let valid_open = s[inner..].chars().next().is_some_and(|c| !c.is_whitespace());
        if valid_open {
            let mut search = inner;
            while let Some(close) = s[search..].find(marker).map(|i| i + search) {
                if close > inner && s[..close].chars().next_back().is_some_and(|c| !c.is_whitespace()) {
                    return Some((start, inner, close, close + marker.len()));
                }
                search = close + 1;
            }
        }
        from = start + 1;
    }
    None
}

fn find_star_italic(s: &str) -> Option<Span> {
    let ok = |c: Option<char>| c.is_some_and(|c| !c.is_whitespace() && c != '*');
    for (start, c) in s.char_indices() {
        if c != '*' || !ok(s[start + 1..].chars().next()) {
            continue;
        }
        for (off, c2) in s[start + 1..].char_indices() {
            let close = start + 1 + off;
            if c2 == '*' && close > start + 1 && ok(s[..close].chars().next_back()) {
                return Some((start, start + 1, close, close + 1));
            }
        }
    }
    None
}

fn find_underscore_italic(s: &str) -> Option<Span> {
    let ok = |c: Option<char>| c.is_some_and(|c| !c.is_whitespace() && c != '_');
    for (start, c) in s.char_indices() {
        if c != '_'
            || s[..start].chars().next_back().is_some_and(is_word)
            || !ok(s[start + 1..].chars().next())
        {
            continue;
        }
        for (off, c2) in s[start + 1..].char_indices() {
            let close = start + 1 + off;
            if c2 == '_'
                && close > start + 1
                && ok(s[..close].chars().next_back())
                && !s[close + 1..].chars().next().is_some_and(is_word)
            {
                return Some((start, start + 1, close, close + 1));
            }
        }
    }
    None
}

fn emphasis(s: &str, targets: &[MentionTarget], style: Emphasis, depth: usize, out: &mut Vec<Piece>) {
    if s.is_empty() {
        return;
    }
    if depth < MAX_DEPTH {
        // The earliest marker wins; on a tie, bold, then struck, then italic (as the web app)
        let candidates = [
            (find_delimited(s, "**"), 0),
            (find_delimited(s, "~~"), 1),
            (find_star_italic(s), 2),
            (find_underscore_italic(s), 2),
        ];
        let best = candidates
            .iter()
            .filter_map(|(span, kind)| span.map(|sp| (sp, *kind)))
            .min_by_key(|((start, ..), _)| *start);
        if let Some(((start, inner, close, end), kind)) = best {
            mentions(&s[..start], targets, style, out);
            let mut inner_style = style;
            match kind {
                0 => inner_style.bold = true,
                1 => inner_style.strike = true,
                _ => inner_style.italic = true,
            }
            emphasis(&s[inner..close], targets, inner_style, depth + 1, out);
            emphasis(&s[end..], targets, style, depth, out);
            return;
        }
    }
    mentions(s, targets, style, out);
}

/// Splits @Name mentions out of plain text.
fn mentions(s: &str, targets: &[MentionTarget], style: Emphasis, out: &mut Vec<Piece>) {
    let piece = |text: &str| Piece {
        text: text.to_owned(),
        bold: style.bold,
        italic: style.italic,
        strike: style.strike,
        ..Piece::default()
    };
    let mut sorted: Vec<&MentionTarget> = targets.iter().filter(|t| !t.name.trim().is_empty()).collect();
    sorted.sort_by_key(|t| std::cmp::Reverse(t.name.trim().chars().count()));
    let mut last = 0;
    let mut i = 0;
    while let Some(at) = s[i..].find('@').map(|j| j + i) {
        i = at + 1;
        if s[..at].chars().next_back().is_some_and(is_word) {
            continue;
        }
        let after = &s[at + 1..];
        let hit = sorted.iter().find_map(|t| {
            let name = t.name.trim();
            let len = name.chars().count();
            let end = after.char_indices().nth(len).map_or(after.len(), |(b, _)| b);
            if after.chars().count() < len || after[..end].to_lowercase() != name.to_lowercase() {
                return None;
            }
            if after[end..].chars().next().is_some_and(is_word) {
                return None;
            }
            Some((*t, end))
        });
        if let Some((t, end)) = hit {
            if at > last {
                out.push(piece(&s[last..at]));
            }
            out.push(Piece {
                mention: Some(t.peer_id.clone()),
                mentions_self: t.is_self,
                ..piece(&s[at..at + 1 + end])
            });
            last = at + 1 + end;
            i = last;
        }
    }
    if last < s.len() {
        out.push(piece(&s[last..]));
    }
}

/// The peers a message mentions (by @Name), once each, at most [`MAX_MENTIONS`].
#[must_use]
pub fn mentioned_peer_ids(text: &str, targets: &[MentionTarget]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for p in format_chat(text, targets) {
        if let Some(id) = p.mention
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids.truncate(MAX_MENTIONS);
    ids
}

/// Plain text of a message for a reply quote or a notice: markers dropped, one line, cut to `max`
/// characters (with "…").
#[must_use]
pub fn plain_snippet(text: &str, max: usize) -> String {
    let flat: String = format_chat(text, &[]).into_iter().map(|p| p.text).collect();
    let one = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > max {
        let mut cut: String = one.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    } else {
        one
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people() -> Vec<MentionTarget> {
        let t = |id: &str, name: &str, is_self| MentionTarget {
            peer_id: id.into(),
            name: name.into(),
            is_self,
        };
        vec![
            t("p-sai", "Sai", false),
            t("p-saik", "Sai Kumar", false),
            t("p-me", "Darshan", true),
        ]
    }

    /// The same compact form as the web tests: b(x), i(x), s(x), <code>, [link], {peer}
    fn show(pieces: &[Piece]) -> String {
        pieces
            .iter()
            .map(|p| {
                let mut s = if p.code {
                    format!("<{}>", p.text)
                } else if let Some(href) = &p.link {
                    format!("[{href}]")
                } else if let Some(id) = &p.mention {
                    format!("{{{id}{}}}", if p.mentions_self { "!" } else { "" })
                } else {
                    p.text.clone()
                };
                for (on, tag) in [(p.italic, "i"), (p.strike, "s"), (p.bold, "b")] {
                    if on {
                        s = format!("{tag}({s})");
                    }
                }
                s
            })
            .collect()
    }

    fn f(text: &str) -> String {
        show(&format_chat(text, &people()))
    }

    #[test]
    fn plain_text_stays_plain() {
        assert_eq!(f("hello there"), "hello there");
        assert_eq!(f(""), "");
    }

    #[test]
    fn bold_italic_struck() {
        assert_eq!(f("a **big** deal"), "a b(big) deal");
        assert_eq!(f("*soft* and _also_"), "i(soft) and i(also)");
        assert_eq!(f("~~old~~ new"), "s(old) new");
        assert_eq!(f("**bold _and italic_**"), "b(bold )b(i(and italic))");
    }

    #[test]
    fn maths_snake_case_and_lone_markers_stay_plain() {
        assert_eq!(f("2 * 3 * 4"), "2 * 3 * 4");
        assert_eq!(f("my_var_name"), "my_var_name");
        assert_eq!(f("** nope **"), "** nope **");
        assert_eq!(f("a*"), "a*");
    }

    #[test]
    fn code_is_not_formatted_inside() {
        assert_eq!(f("run `npm **test**` now"), "run <npm **test**> now");
        assert_eq!(f("a ` b"), "a ` b");
    }

    #[test]
    fn links_keep_working() {
        assert_eq!(f("see https://x.com/a_b_c ok"), "see [https://x.com/a_b_c] ok");
        assert_eq!(f("**www.foo.org**"), "**[https://www.foo.org]**");
        assert_eq!(f("(see https://x.com/a)."), "(see [https://x.com/a]).");
        assert_eq!(
            f("word.www.x.org"),
            "word.[https://www.x.org]",
            "as the web app: a dot ends a word"
        );
    }

    #[test]
    fn mentions_longest_name_any_case_not_in_addresses() {
        assert_eq!(f("hey @Sai Kumar and @sai!"), "hey {p-saik} and {p-sai}!");
        assert_eq!(f("mail sai@Sai.com"), "mail sai@Sai.com");
        assert_eq!(f("@Darshan look"), "{p-me!} look");
        assert_eq!(f("**@Sai** hi"), "b({p-sai}) hi");
        assert_eq!(f("@Saiyan"), "@Saiyan");
    }

    #[test]
    fn collects_mentions_once() {
        let mut ids = mentioned_peer_ids("@Sai @sai and @Sai Kumar", &people());
        ids.sort();
        assert_eq!(ids, vec!["p-sai".to_owned(), "p-saik".to_owned()]);
        assert!(mentioned_peer_ids("no one", &people()).is_empty());
    }

    #[test]
    fn snippets_are_plain_one_line_and_short() {
        assert_eq!(plain_snippet("**hi**\n  _there_ `x`", 140), "hi there x");
        assert_eq!(plain_snippet(&"a".repeat(200), 10), format!("{}…", "a".repeat(9)));
    }

    #[test]
    fn deep_nesting_and_odd_text_never_panic() {
        let deep = format!("{}x{}", "**".repeat(30), "**".repeat(30));
        let _ = format_chat(&deep, &people());
        for s in [
            "`",
            "``",
            "*",
            "_",
            "~~",
            "@",
            "@@@",
            "é*é*",
            "**é**",
            "日本語 *強調* @Sai",
            "www.",
            "http://",
        ] {
            let _ = format_chat(s, &people());
        }
    }
}
