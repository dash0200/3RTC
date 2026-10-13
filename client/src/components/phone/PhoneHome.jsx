import React, { useEffect, useRef, useState } from 'react';

const CODE_LENGTH = 5;

/** Phone home: your name, create a room, or join with a 5-digit code. */
export default function PhoneHome({ username, initialPin = '', onCreate, onJoin, onOpenServerSettings }) {
  const [name, setName] = useState(username || '');
  const [digits, setDigits] = useState(() => {
    const pin = String(initialPin || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
    return Array.from({ length: CODE_LENGTH }, (_, i) => pin[i] || '');
  });
  const boxRefs = useRef([]);

  // A room code from a shared link (?room=12345) fills the boxes
  useEffect(() => {
    const pin = String(initialPin || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (pin.length === CODE_LENGTH) setDigits(pin.split(''));
  }, [initialPin]);

  const code = digits.join('');
  const displayName = name.trim() || username || 'Guest';

  const setDigit = (index, value) => {
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      // Pasted or autofilled code
      const next = clean.slice(0, CODE_LENGTH).split('');
      setDigits(Array.from({ length: CODE_LENGTH }, (_, i) => next[i] || ''));
      boxRefs.current[Math.min(next.length, CODE_LENGTH) - 1]?.focus();
      return;
    }
    setDigits((prev) => prev.map((d, i) => (i === index ? clean : d)));
    if (clean && index < CODE_LENGTH - 1) boxRefs.current[index + 1]?.focus();
  };

  const onKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      boxRefs.current[index - 1]?.focus();
    } else if (e.key === 'Enter' && code.length === CODE_LENGTH) {
      onJoin?.(code, displayName);
    }
  };

  return (
    <div className="phone-home">
      <div className="phone-home-main">
        <div className="phone-home-hero">
          <span className="phone-home-mark" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
            </svg>
          </span>
          <h1>Watch together</h1>
          <p>Video, voice and chat straight between your devices. Up to 3 people.</p>
        </div>

        <div className="phone-field">
          <label htmlFor="phone-name" className="phone-label">YOUR NAME</label>
          <input
            id="phone-name"
            className="phone-input"
            type="text"
            maxLength={20}
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <button type="button" className="phone-btn phone-btn-primary phone-btn-lg" onClick={() => onCreate?.(displayName)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Create a room
        </button>

        <div className="phone-divider"><span>or join with a code</span></div>

        <fieldset className="phone-code">
          <legend className="phone-visually-hidden">5-digit room code</legend>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { boxRefs.current[i] = el; }}
              className="phone-code-box"
              type="text"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={i === 0 ? CODE_LENGTH : 1}
              aria-label={`Digit ${i + 1}`}
              value={d}
              onChange={(e) => setDigit(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onFocus={(e) => e.target.select()}
            />
          ))}
        </fieldset>
        <button
          type="button"
          className="phone-btn phone-btn-ghost phone-btn-lg"
          disabled={code.length !== CODE_LENGTH}
          onClick={() => onJoin?.(code, displayName)}
        >
          Join room
        </button>
      </div>

      <footer className="phone-home-foot">
        <p>Video, voice and chat stay peer-to-peer.</p>
        <button type="button" className="phone-link-btn" onClick={onOpenServerSettings}>Server settings</button>
        <nav className="site-links phone-site-links" aria-label="About 3RTC">
          <a href="/about">About</a>
          <a href="/youtube-watch-party">YouTube watch party</a>
          <a href="/watch-videos-together">Your own videos</a>
          <a href="/privacy">Privacy</a>
        </nav>
      </footer>
    </div>
  );
}
