/**
 * Which build of 3RTC this is (set at build time in vite.config.js; 'dev' when running locally).
 * number: YYMMDD.HHMM (India time) when it was built; it only goes up, so builds compare as numbers.
 */
import type { AppBuildInfo } from './vite-env';

const raw: AppBuildInfo | null =
  typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : null;

export const BUILD: AppBuildInfo =
  raw || { number: 'dev', sha: '', branch: '', time: '' };

export const BUILD_LABEL: string =
  BUILD.number === 'dev'
    ? 'Development build'
    : `Build ${BUILD.number}${BUILD.sha ? ` · ${BUILD.sha}` : ''}`;

/** -1 if build number a is older than b, 1 if newer, 0 if the same or either is unknown. */
export function compareBuilds(a?: string | null, b?: string | null): -1 | 0 | 1 {
  const valid = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{6}\.\d{4}$/.test(v);
  if (!valid(a) || !valid(b)) return 0;
  const x = Number(a);
  const y = Number(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
