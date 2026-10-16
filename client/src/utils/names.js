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
