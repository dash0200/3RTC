import React from 'react';

/** The 3RTC mark + wordmark. */
export function Logo({ size = 30 }) {
  return (
    <span className="rd-logo" style={{ '--logo': `${size}px` }}>
      <span className="rd-logo-mark" aria-hidden="true">
        <svg viewBox="0 0 14 14" width={Math.round(size * 0.42)} height={Math.round(size * 0.42)}><path d="M3 1.5v11l9.5-5.5z" fill="#fff" /></svg>
      </span>
      <span className="rd-logo-word">3RTC</span>
    </span>
  );
}
