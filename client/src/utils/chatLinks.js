/**
 * Web links in chat messages: "see https://example.com/x, and www.foo.org" -> pieces of text and
 * links. Only http(s) (and www.) addresses become links, so nothing else can be made clickable.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING = /[.,!?;:'"’”*]+$/;

/** Trim punctuation that ends the sentence, not the link (a closing bracket only when unmatched). */
function trimLink(raw) {
    let url = raw.replace(TRAILING, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
            url = url.slice(0, -1).replace(TRAILING, '');
        }
    }
    return url;
}

/** [{ text } | { text, href }] pieces of `text`, in order. */
export function splitLinks(text) {
    const s = String(text ?? '');
    const parts = [];
    let last = 0;
    for (const m of s.matchAll(URL_RE)) {
        const url = trimLink(m[0]);
        if (url.length < 5 || /^www\.$/i.test(url)) continue;
        if (m.index > last) parts.push({ text: s.slice(last, m.index) });
        const href = /^www\./i.test(url) ? `https://${url}` : url;
        parts.push({ text: url, href });
        last = m.index + url.length;
    }
    if (last < s.length) parts.push({ text: s.slice(last) });
    return parts.length ? parts : [{ text: s }];
}
