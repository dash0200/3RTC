import React, { useEffect, useRef, useState } from 'react';
import { GLOBAL_REGION, regionName, setQuickPicksRegion, useQuickPicksRegion } from '../utils/quickPicks';

// Flag emoji show as plain letters on Windows, so countries get a small code badge instead
const Badge = ({ code }) => (code === GLOBAL_REGION
  ? <span className="qp-region-badge is-globe" aria-hidden="true">🌍</span>
  : <span className="qp-region-badge" aria-hidden="true">{code}</span>);

/** "🌍 Worldwide ▾": whose YouTube trending the quick picks show. A chip like the others, with a small menu. */
export default function TrendingRegionSelect({ className = '' }) {
  const { region, regions } = useQuickPicksRegion();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!region || !regions.length) return null; // the server doesn't offer a choice
  const options = [GLOBAL_REGION, ...regions];
  const current = options.includes(region) ? region : GLOBAL_REGION;
  const choose = (code) => {
    setOpen(false);
    if (code !== current) setQuickPicksRegion(code);
  };

  return (
    <div className={`qp-region ${className}`} ref={wrapRef}>
      <button
        type="button"
        className={`qp-chip qp-region-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Whose YouTube trending to show"
        data-region={current}
      >
        <Badge code={current} />
        {regionName(current)}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <div className="qp-region-menu" role="menu" aria-label="Trending in">
          <div className="qp-region-title">Trending in</div>
          {options.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === current}
              className={`qp-region-option ${code === current ? 'is-on' : ''}`}
              data-region={code}
              onClick={() => choose(code)}
            >
              <Badge code={code} />
              {regionName(code)}
              {code === current && <span className="qp-region-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
