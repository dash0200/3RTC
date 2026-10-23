/**
 * Pinch to zoom a game on a phone (the page itself can't be zoomed: the viewport is fixed so the
 * app doesn't jump around). Two fingers zoom (1× to MAX_ZOOM) and pan; one finger stays the game's
 * (taps, dragging a chess piece, drawing), and once zoomed in it scrolls the bigger game where the
 * game doesn't use the touch itself (the whiteboard draws with one finger: pan it with two).
 *
 * The content is scaled with a transform inside the scrolling `.activity-body`, so the body's own
 * scrolling pans it. A second finger cancels what the first one started in the game (a pointercancel
 * to it), and the game sees no touches until every finger is up, so a pinch never moves a piece or
 * leaves a line.
 *
 *   const zoom = usePinchZoom(bodyEl, contentRef, enabled);   // zoom.z, zoom.reset()
 * (bodyEl: the element itself, from a callback ref: the frame can mount after the hook first runs)
 *   <ActivityZoomContext.Provider value={zoom.z}>…               // games that care (whiteboard)
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';

export const MAX_ZOOM = 3;

/** The current zoom of the game this is inside (1 when not zoomed or not on a phone) */
export const ActivityZoomContext = createContext(1);
export const useActivityZoom = (): number => useContext(ActivityZoomContext);

export function usePinchZoom(
  body: HTMLElement | null,
  contentRef: RefObject<HTMLElement | null>,
  enabled: boolean
): { z: number; reset: () => void } {
  const [z, setZ] = useState(1);
  const zRef = useRef(1);

  const apply = useCallback((nz: number) => {
    zRef.current = nz;
    const content = contentRef.current;
    if (content) content.style.transform = nz > 1 ? `scale(${nz})` : '';
    setZ(nz);
  }, [contentRef]);

  const reset = useCallback(() => {
    apply(1);
    if (body) body.scrollTo({ left: 0, top: 0 });
  }, [apply, body]);

  // Off (not a phone, game made small): back to 1×
  useEffect(() => {
    if (!enabled && zRef.current !== 1) reset();
  }, [enabled, reset]);

  useEffect(() => {
    if (!enabled || !body) return undefined;

    let pinch: { d0: number; z0: number; px: number; py: number } | null = null;
    // Touch pointers down now, and whether the game is cut off from them (a pinch is on)
    const down = new Map<number, EventTarget | null>();
    let blocked = false;

    const fingers = (t: TouchList) => {
      const a = t[0];
      const b = t[1];
      return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
    };

    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 2) return;
      const f = fingers(e.touches);
      const r = body.getBoundingClientRect();
      // The point of the (unscaled) game under the fingers: it stays under them
      pinch = { d0: f.d, z0: zRef.current, px: (body.scrollLeft + f.x - r.left) / zRef.current, py: (body.scrollTop + f.y - r.top) / zRef.current };
    };
    const onTouchMove = (e: TouchEvent): void => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const f = fingers(e.touches);
      const r = body.getBoundingClientRect();
      const nz = Math.min(MAX_ZOOM, Math.max(1, (pinch.z0 * f.d) / pinch.d0));
      if (Math.abs(nz - zRef.current) > 0.001) apply(nz);
      body.scrollLeft = pinch.px * nz - (f.x - r.left);
      body.scrollTop = pinch.py * nz - (f.y - r.top);
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length >= 2) return;
      pinch = null;
      if (zRef.current < 1.08 && zRef.current !== 1) reset(); // let go near 1×: snap back
    };

    // Keep the game out of a pinch (capture phase, before the game's own handlers)
    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return;
      // the first finger of a new touch: nothing else is down (a finger lifted outside the game
      // never told us it went up)
      if (e.isPrimary) {
        down.clear();
        blocked = false;
      }
      if (down.size >= 1 && !blocked) {
        blocked = true;
        // the first finger's action in the game: cancelled, not finished
        for (const [id, target] of down) {
          target?.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: false }));
        }
      }
      down.set(e.pointerId, e.target);
      if (blocked) e.stopPropagation();
    };
    const onPointerOther = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch' || !e.isTrusted) return;
      if (blocked) e.stopPropagation();
      if (e.type === 'pointerup' || e.type === 'pointercancel') {
        down.delete(e.pointerId);
        if (!down.size) blocked = false;
      }
    };

    body.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    body.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    body.addEventListener('touchend', onTouchEnd, { capture: true });
    body.addEventListener('touchcancel', onTouchEnd, { capture: true });
    body.addEventListener('pointerdown', onPointerDown, { capture: true });
    for (const t of ['pointermove', 'pointerup', 'pointercancel'] as const) body.addEventListener(t, onPointerOther, { capture: true });
    return () => {
      body.removeEventListener('touchstart', onTouchStart, { capture: true });
      body.removeEventListener('touchmove', onTouchMove, { capture: true });
      body.removeEventListener('touchend', onTouchEnd, { capture: true });
      body.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      body.removeEventListener('pointerdown', onPointerDown, { capture: true });
      for (const t of ['pointermove', 'pointerup', 'pointercancel'] as const) body.removeEventListener(t, onPointerOther, { capture: true });
    };
  }, [enabled, body, apply, reset]);

  return { z, reset };
}
