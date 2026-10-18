import React from 'react';

/** Line icons used by the redesigned screens (same set as the Figma file). */
const paths = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  micOff: <path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2M15 10V6a3 3 0 0 0-6 0M5 11a7 7 0 0 0 11 5M19 11a7 7 0 0 1-.6 2.8M12 18v3" />,
  headphones: <><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><rect x="3" y="14" width="5" height="7" rx="2" /><rect x="16" y="14" width="5" height="7" rx="2" /></>,
  headphonesOff: <><path d="M3 3l18 18M5.6 5.6A9 9 0 0 0 3 12v2M21 14v-2a9 9 0 0 0-12.4-8.3" /><rect x="3" y="14" width="5" height="7" rx="2" /><path d="M16 16v3a2 2 0 0 0 2 2h1" /></>,
  smile: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></>,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  games: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  link: <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  signal: <path d="M4 18v-2M9 18v-6M14 18V9M19 18V5" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></>,
  folder: <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  share: <path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />,
  queue: <path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6" />,
  videoAdd: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M12 9v6M9 12h6" /></>,
  speaker: <path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />,
  speakerOff: <path d="M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  userPlus: <><circle cx="9" cy="8" r="4" /><path d="M2 21c0-4 3-7 7-7s7 3 7 7M19 8v6M16 11h6" /></>,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h3v-3" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />,
  skipForward: <><path d="M5 4l10 8-10 8V4z" fill="currentColor" /><rect x="17" y="4" width="2.5" height="16" rx="1" fill="currentColor" /></>,
  screenShare: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M12 13V7M9 10l3-3 3 3" /></>,
  screenShareOff: <><path d="M2 3l20 20M9 3h11a2 2 0 0 1 2 2v10a2 2 0 0 1-1.2 1.8M2 7v8a2 2 0 0 0 2 2h10M8 21h8M12 17v4" /></>,
  laserPointer: <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
};

const filled = {
  more: <><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></>,
  play: <path d="M7 4.5v15l12.5-7.5z" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>
};

export function Icon({ name, size = 20, strokeWidth = 2, className = '' }) {
  if (filled[name]) {
    return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{filled[name]}</svg>;
  }
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
