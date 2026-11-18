import React from 'react';

export interface LogoProps {
  size?: number;
}

/** The 3RTC mark + wordmark. */
export function Logo({ size = 30 }: LogoProps) {
  return (
    <span className="rd-logo" style={{ '--logo': `${size}px` } as React.CSSProperties}>
      <span className="rd-logo-mark" aria-hidden="true">
        <svg
          viewBox="0 0 14 14"
          width={Math.round(size * 0.42)}
          height={Math.round(size * 0.42)}
        >
          <path d="M11 1.5v11L1.5 7z" fill="#fff" />
        </svg>
      </span>
      <span className="rd-logo-word">3RTC</span>
    </span>
  );
}

export default Logo;
