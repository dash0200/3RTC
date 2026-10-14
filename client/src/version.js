/**
 * Which build of 3RTC this is (set at build time in vite.config.js; 'dev' when running locally).
 * number: YYMMDD.HHMM (India time) when it was built; it only goes up, so builds compare as numbers.
 */
const raw = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : null; // eslint-disable-line no-undef

export const BUILD = raw || { number: 'dev', sha: '', branch: '', time: '' };

export const BUILD_LABEL = BUILD.number === 'dev'
    ? 'Development build'
    : `Build ${BUILD.number}${BUILD.sha ? ` · ${BUILD.sha}` : ''}`;

/** -1 if build number a is older than b, 1 if newer, 0 if the same or either is unknown. */
export function compareBuilds(a, b) {
    const valid = (v) => typeof v === 'string' && /^\d{6}\.\d{4}$/.test(v);
    if (!valid(a) || !valid(b)) return 0;
    const x = Number(a);
    const y = Number(b);
    if (x === y) return 0;
    return x < y ? -1 : 1;
}
