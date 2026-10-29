/**
 * Zoom a game. Computer: the mouse wheel over the game zooms around the pointer (Ctrl+wheel and a
 * trackpad pinch too); zoomed in, the pointer is a hand: drag to move the game around (a click
 * without dragging still plays; the chess board and the whiteboard's canvas keep their own drag:
 * move those by dragging around them, or with the middle button). The wheel over a list or panel
 * inside the game that scrolls (Ctrl+wheel always zooms) scrolls it as before.
 *
 * Phone: pinch to zoom (the page itself can't be zoomed: the viewport is fixed so the
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

/** The current zoom of the game this is inside (1 when not zoomed) */
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

  // Off (the game is a bubble): back to 1×
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

    // ---- mouse: the wheel zooms around the pointer ----
    const zoomAt = (nz: number, x: number, y: number): void => {
      const r = body.getBoundingClientRect();
      const z0 = zRef.current;
      const px = (body.scrollLeft + x - r.left) / z0;
      const py = (body.scrollTop + y - r.top) / z0;
      const clamped = Math.min(MAX_ZOOM, Math.max(1, nz));
      if (clamped < 1.02) {
        reset();
        return;
      }
      apply(clamped);
      body.scrollLeft = px * clamped - (x - r.left);
      body.scrollTop = py * clamped - (y - r.top);
    };
    /** A list or panel inside the game the wheel should scroll instead (it can scroll that way) */
    const scrollsInside = (target: EventTarget | null, dy: number): boolean => {
      const content = contentRef.current;
      for (let n = target as HTMLElement | null; n && n !== content && n !== body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) {
          if (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true;
        }
      }
      return false;
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey && scrollsInside(e.target, e.deltaY)) return;
      if (!e.deltaY) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomAt(zRef.current * Math.exp(-px * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
    };

    // ---- mouse: zoomed in, drag to move the game ----
    const OWN_DRAG = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"], .wb-over, .chess svg';
    let drag: { id: number; x: number; y: number; left: number; top: number; moving: boolean } | null = null;
    let swallowClick = false;
    const onMouseDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse' || zRef.current <= 1) return;
      const middle = e.button === 1;
      if (!middle && (e.button !== 0 || (e.target as Element | null)?.closest?.(OWN_DRAG))) return;
      if (middle) e.preventDefault(); // no auto-scroll
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: body.scrollLeft, top: body.scrollTop, moving: middle };
      if (middle) {
        body.classList.add('is-panning');
        body.setPointerCapture?.(e.pointerId);
      }
    };
    const onMouseMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.hypot(dx, dy) < 5) return; // still a click
        drag.moving = true;
        body.classList.add('is-panning');
        body.setPointerCapture?.(e.pointerId);
      }
      body.scrollLeft = drag.left - dx;
      body.scrollTop = drag.top - dy;
      e.stopPropagation();
    };
    const onMouseUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moving) swallowClick = true; // that was a drag, not a click on the game
      drag = null;
      body.classList.remove('is-panning');
    };
    const onClick = (e: MouseEvent): void => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    const onAuxClick = (e: MouseEvent): void => {
      if (e.button === 1 && zRef.current > 1) e.preventDefault();
    };

    body.addEventListener('wheel', onWheel, { passive: false });
    body.addEventListener('pointerdown', onMouseDown, { capture: true });
    body.addEventListener('pointermove', onMouseMove, { capture: true });
    body.addEventListener('pointerup', onMouseUp, { capture: true });
    body.addEventListener('pointercancel', onMouseUp, { capture: true });
    body.addEventListener('click', onClick, { capture: true });
    body.addEventListener('auxclick', onAuxClick);
    body.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    body.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    body.addEventListener('touchend', onTouchEnd, { capture: true });
    body.addEventListener('touchcancel', onTouchEnd, { capture: true });
    body.addEventListener('pointerdown', onPointerDown, { capture: true });
    for (const t of ['pointermove', 'pointerup', 'pointercancel'] as const) body.addEventListener(t, onPointerOther, { capture: true });
    return () => {
      body.removeEventListener('wheel', onWheel);
      body.removeEventListener('pointerdown', onMouseDown, { capture: true });
      body.removeEventListener('pointermove', onMouseMove, { capture: true });
      body.removeEventListener('pointerup', onMouseUp, { capture: true });
      body.removeEventListener('pointercancel', onMouseUp, { capture: true });
      body.removeEventListener('click', onClick, { capture: true });
      body.removeEventListener('auxclick', onAuxClick);
      body.classList.remove('is-panning');
      body.removeEventListener('touchstart', onTouchStart, { capture: true });
      body.removeEventListener('touchmove', onTouchMove, { capture: true });
      body.removeEventListener('touchend', onTouchEnd, { capture: true });
      body.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      body.removeEventListener('pointerdown', onPointerDown, { capture: true });
      for (const t of ['pointermove', 'pointerup', 'pointercancel'] as const) body.removeEventListener(t, onPointerOther, { capture: true });
    };
  }, [enabled, body, apply, reset, contentRef]);

  // Zoomed in: the hand cursor over the game (CSS: .activity-body.can-pan)
  useEffect(() => {
    if (!body) return undefined;
    body.classList.toggle('can-pan', z > 1);
    return () => body.classList.remove('can-pan');
  }, [body, z]);

  return { z, reset };
}
