/**
 * Floating reactions over the stage, and the optional reaction dock.
 *
 * Reactions arrive on `feed` (features/reactions/reactionFeed.js) and are animated here directly
 * with the Web Animations API (transform and opacity only, so the GPU does the work); nothing
 * goes through React state, so a burst never re-renders the app.
 *
 * Each emoji pops in with a bounce, rises with a gentle sway and wobble, and fades at the top.
 * Repeating the same emoji builds a combo (x3, x4 ...) that pulses, with a small burst of
 * mini emojis at 5, 10, 20, 30... The sender's name shows once per burst.
 */
import { useEffect, useRef, useState } from 'react';

export const LIVE_REACTIONS = [
  { id: 'thumbs', emoji: '👍', key: '1', label: 'Thumbs Up' },
  { id: 'heart', emoji: '❤️', key: '2', label: 'Love' },
  { id: 'fire', emoji: '🔥', key: '3', label: 'Fire' },
  { id: 'clap', emoji: '👏', key: '4', label: 'Clap' },
  { id: 'joy', emoji: '😂', key: '5', label: 'Joy' },
  { id: 'party', emoji: '🎉', key: '6', label: 'Party' }
];

const isPhone = () => {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
};
const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const rand = (a, b) => a + Math.random() * (b - a);
const isMilestone = (n) => n === 5 || (n >= 10 && n % 10 === 0);

/** Animate the stream of reactions inside `layer` (a positioned element). Returns a cleanup. */
function runReactionLayer(layer, feed) {
  const live = [];                 // { el, anim } in start order
  const combos = new Map();        // peerKey -> { el, countEl, timer, emoji }
  const maxLive = isPhone() ? 14 : 30;
  const calm = reducedMotion();

  const visible = () => {
    // In fullscreen only the layer inside the fullscreen element can be seen
    const fs = document.fullscreenElement;
    return !fs || fs.contains(layer);
  };

  const retire = (entry) => {
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    entry.anim.onfinish = null;
    entry.anim.cancel();
    entry.el.remove();
  };

  const spawn = (item) => {
    if (!visible() || typeof layer.animate !== 'function') return;
    const height = layer.clientHeight || 400;
    const el = document.createElement('div');
    el.className = 'floating-reaction-item';
    el.style.left = `${item.lane}%`;
    const emoji = document.createElement('span');
    emoji.className = 'reaction-emoji';
    emoji.textContent = item.emoji;
    el.appendChild(emoji);
    if (item.combo === 1) {
      const tag = document.createElement('span');
      tag.className = 'reaction-sender-tag';
      tag.textContent = item.isSelf ? 'You' : item.sender;
      el.appendChild(tag);
    }
    layer.appendChild(el);

    const big = isMilestone(item.combo) ? 1.55 : 1;
    const s = rand(0.95, 1.2) * big;
    const sway = rand(10, 22) * (Math.random() < 0.5 ? -1 : 1);
    const rot = rand(6, 16) * (Math.random() < 0.5 ? -1 : 1);
    const rise = height * rand(0.78, 0.95);
    const frames = calm
      ? [{ opacity: 0, transform: 'translate3d(0,-30px,0)' }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: 'translate3d(0,-60px,0)' }]
      : [
        { offset: 0, opacity: 0, transform: 'translate3d(-50%,0,0) scale(0.2) rotate(0deg)', easing: 'cubic-bezier(.2,1.6,.4,1)' },
        { offset: 0.09, opacity: 1, transform: `translate3d(-50%,-${rise * 0.05}px,0) scale(${s * 1.3}) rotate(${rot * 0.3}deg)`, easing: 'ease-out' },
        { offset: 0.17, opacity: 1, transform: `translate3d(calc(-50% + ${sway * 0.3}px),-${rise * 0.12}px,0) scale(${s}) rotate(${rot * 0.5}deg)`, easing: 'ease-in-out' },
        { offset: 0.42, opacity: 1, transform: `translate3d(calc(-50% - ${sway}px),-${rise * 0.4}px,0) scale(${s}) rotate(${-rot}deg)`, easing: 'ease-in-out' },
        { offset: 0.68, opacity: 0.95, transform: `translate3d(calc(-50% + ${sway * 0.8}px),-${rise * 0.66}px,0) scale(${s * 0.97}) rotate(${rot * 0.7}deg)`, easing: 'ease-in-out' },
        { offset: 0.86, opacity: 0.75, transform: `translate3d(calc(-50% - ${sway * 0.4}px),-${rise * 0.85}px,0) scale(${s * 0.88}) rotate(${-rot * 0.4}deg)`, easing: 'ease-in' },
        { offset: 1, opacity: 0, transform: `translate3d(-50%,-${rise}px,0) scale(${s * 0.6}) rotate(0deg)` }
      ];
    const anim = el.animate(frames, { duration: calm ? 1400 : rand(2700, 3300), fill: 'forwards' });
    const entry = { el, anim };
    live.push(entry);
    anim.onfinish = () => retire(entry);
    // Too many on screen: drop the oldest right now. (Removed here, synchronously: the
    // animation's own finish event only fires later, so waiting for it would loop forever.)
    while (live.length > maxLive) retire(live[0]);

    if (!calm && isMilestone(item.combo)) burst(item);
  };

  // A ring of small copies flying out from the bottom of the lane
  const burst = (item) => {
    const n = isPhone() ? 5 : 8;
    for (let k = 0; k < n; k++) {
      const p = document.createElement('span');
      p.className = 'floating-reaction-spark';
      p.textContent = item.emoji;
      p.style.left = `${item.lane}%`;
      layer.appendChild(p);
      const a = (Math.PI * 2 * k) / n + rand(-0.3, 0.3);
      const d = rand(40, 75);
      p.animate([
        { opacity: 1, transform: 'translate3d(-50%,0,0) scale(0.4)' },
        { opacity: 0, transform: `translate3d(calc(-50% + ${Math.cos(a) * d}px),${-Math.abs(Math.sin(a)) * d - 30}px,0) scale(0.9) rotate(${rand(-60, 60)}deg)` }
      ], { duration: 650, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' }).onfinish = () => p.remove();
    }
  };

  // The combo counter: one per person, updated in place, pulses on each hit
  const showCombo = (item) => {
    if (item.combo < 3 || !visible()) return;
    let c = combos.get(item.peerKey);
    if (!c || c.emoji !== item.emoji) {
      if (c) c.el.remove();
      const el = document.createElement('div');
      el.className = 'floating-reaction-combo';
      el.innerHTML = '<span class="combo-emoji"></span><span class="combo-count"></span>';
      el.querySelector('.combo-emoji').textContent = item.emoji;
      layer.appendChild(el);
      c = { el, countEl: el.querySelector('.combo-count'), emoji: item.emoji, timer: null };
      combos.set(item.peerKey, c);
    }
    c.el.style.left = `${Math.max(18, Math.min(82, item.lane))}%`;
    c.countEl.textContent = `×${item.combo}`;
    if (!calm) {
      const grow = Math.min(1 + item.combo * 0.015, 1.35);
      c.el.animate([
        { transform: `translate3d(-50%,0,0) scale(${grow * 1.25})` },
        { transform: `translate3d(-50%,0,0) scale(${grow})` }
      ], { duration: 220, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'forwards' });
    }
    clearTimeout(c.timer);
    c.el.classList.remove('is-fading');
    c.timer = setTimeout(() => {
      c.el.classList.add('is-fading');
      c.timer = setTimeout(() => {
        c.el.remove();
        if (combos.get(item.peerKey) === c) combos.delete(item.peerKey);
      }, 400);
    }, 1300);
  };

  const off = feed.subscribe((item) => {
    spawn(item);
    showCombo(item);
  });
  return () => {
    off();
    for (const entry of [...live]) retire(entry);
    for (const c of combos.values()) clearTimeout(c.timer);
    layer.replaceChildren();
  };
}

export default function FloatingReactions({
  feed,
  onSendReaction,
  showDock = true,
  hasMedia = false
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!feed || !layerRef.current) return undefined;
    return runReactionLayer(layerRef.current, feed);
  }, [feed]);

  return (
    <>
      <div className="floating-reactions-overlay" aria-hidden="true" ref={layerRef} />

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
