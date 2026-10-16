/**
 * Display names from other people's apps: their app could send anything, so names are cleaned
 * before they are shown (no control or invisible characters, single spaces, at most 24 characters).
 * Returns '' when nothing is left (callers fall back to "Peer" or similar).
 */
export const NAME_MAX = 24;

export function cleanName(value) {
    if (typeof value !== 'string') return '';
    const text = value
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '') // control, format (zero-width, bidi), line breaks
        .replace(/\s+/g, ' ')
        .trim();
    return [...text].slice(0, NAME_MAX).join('').trim();
}

/** Names the app made up (User_819): shown as an empty box with a placeholder, not as a name. */
export function isAutoName(name) {
    return /^User_\d+$/.test(String(name || ''));
}

/** What to show in a "Your name" box: your own name, or nothing for a made-up one. */
export function nameFieldValue(name) {
    return isAutoName(name) ? '' : (name || '');
}
