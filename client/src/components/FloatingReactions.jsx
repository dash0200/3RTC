import React, { useState, useEffect, useCallback } from 'react';

export const LIVE_REACTIONS = [
  { id: 'thumbs', emoji: '👍', key: '1', label: 'Thumbs Up' },
  { id: 'heart', emoji: '❤️', key: '2', label: 'Love' },
  { id: 'fire', emoji: '🔥', key: '3', label: 'Fire' },
  { id: 'clap', emoji: '👏', key: '4', label: 'Clap' },
  { id: 'joy', emoji: '😂', key: '5', label: 'Joy' },
  { id: 'party', emoji: '🎉', key: '6', label: 'Party' }
];

export default function FloatingReactions({
  reactions = [],
  onSendReaction,
  showDock = true,
  disabled = false,
  hasMedia = false
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Global hotkeys 1-6 for instant reactions when user is not typing
  const handleKeyDown = useCallback(
    (e) => {
      if (disabled || typeof onSendReaction !== 'function') return;

      const activeEl = document.activeElement;
      const tagName = activeEl?.tagName?.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        activeEl?.isContentEditable ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      ) {
        return;
      }

      const match = LIVE_REACTIONS.find((r) => r.key === e.key);
      if (match) {
        e.preventDefault();
        onSendReaction(match.emoji);
      }
    },
    [disabled, onSendReaction]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return (
    <>
      {/* Floating Particles Stage Overlay */}
      <div className="floating-reactions-overlay" aria-hidden="true">
        {reactions.map((item) => (
          <div
            key={item.id}
            className={`floating-reaction-item drift-${item.driftVariant || 1}`}
            style={{
              '--lane': `${item.lane ?? 50}%`,
              '--scale': item.scale ?? 1.2,
              '--rot': `${item.rot ?? 0}deg`
            }}
          >
            <span className="reaction-emoji">{item.emoji}</span>
            {item.sender && (
              <span className="reaction-sender-tag">
                {item.isSelf ? 'You' : item.sender}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Floating Quick Reaction Dock */}
      {showDock && typeof onSendReaction === 'function' && (
        <div
          className={`floating-reaction-dock ${hasMedia ? 'has-media' : ''} ${isCollapsed ? 'is-collapsed' : ''}`}
          role="toolbar"
          aria-label="Live Reactions (Hotkeys 1 through 6)"
        >
          {isCollapsed ? (
            <button
              type="button"
              className="reaction-dock-collapsed-btn"
              onClick={() => setIsCollapsed(false)}
              title="Show live reactions dock (Hotkeys 1-6 still work)"
            >
              <span>⚡</span>
              <span className="collapsed-badge">React (1-6)</span>
            </button>
          ) : (
            <div className="reaction-dock-pill">
              <span className="reaction-dock-hint" title="Press 1-6 on your keyboard anytime to react">
                ⚡ React
              </span>
              <div className="reaction-dock-buttons">
                {LIVE_REACTIONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="reaction-dock-btn"
                    onClick={() => onSendReaction(r.emoji)}
                    title={`React ${r.emoji} (${r.label} - Press ${r.key})`}
                    aria-label={`${r.label} reaction`}
                  >
                    <span className="dock-emoji">{r.emoji}</span>
                    <span className="dock-hotkey">{r.key}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="reaction-dock-collapse-btn"
                onClick={() => setIsCollapsed(true)}
                title="Minimize reaction dock (Hotkeys 1-6 still work)"
                aria-label="Minimize reactions"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
