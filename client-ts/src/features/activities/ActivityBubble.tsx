/**
 * The activity as a round button (see ActivityStage): tap to open, drag to move it anywhere on the
 * screen (off the video, over the chat). Let go and it snaps to the nearest side edge, like chat
 * heads; the spot is remembered on this device. It pulses with a tag ("Your turn") when the game
 * needs you; the tag sits on the side away from the edge.
 *
 * It's drawn in the page (or in whatever is full screen, so it still shows over a full-screen
 * video), fixed to the screen. Until it's moved it sits at the stage's edge: `anchorRef` is an
 * element covering the stage.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BUBBLE_EDGE as EDGE, bubbleXY, snapSpot, type BubbleSpot, type Coordinates } from './activityHost';

const KEY = '3rtc_activity_bubble';
const SLOP = 6;    // px of movement before a press becomes a drag

const loadSpot = (): BubbleSpot | null => {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) || 'null');
        return v && (v.side === 'left' || v.side === 'right') && v.y >= 0 && v.y <= 1 ? v : null;
    } catch {
        return null;
    }
};

const saveSpot = (spot: BubbleSpot) => {
    try { localStorage.setItem(KEY, JSON.stringify(spot)); } catch { /* not kept */ }
};

/** The element the bubble is drawn in: the page, or what is full screen now. */
function useLayer(): Element | null {
    const get = () => (typeof document === 'undefined' ? null : (document.fullscreenElement || (document as any).webkitFullscreenElement || document.body));
    const [layer, setLayer] = useState<Element | null>(get);
    useEffect(() => {
        const update = () => setLayer(get());
        document.addEventListener('fullscreenchange', update);
        document.addEventListener('webkitfullscreenchange', update);
        return () => {
            document.removeEventListener('fullscreenchange', update);
            document.removeEventListener('webkitfullscreenchange', update);
        };
    }, []);
    return layer;
}

export interface ActivityBubbleProps {
    icon: ReactNode;
    label: string;
    tag?: ReactNode;
    attention?: boolean;
    color?: string;
    isPhone?: boolean;
    anchorRef: React.RefObject<HTMLElement | null>;
    onOpen: () => void;
    invite?: boolean;
}

/** `invite`: the game isn't loaded here; the bubble asks you to join (its tag always shows). */
export default function ActivityBubble({
    icon,
    label,
    tag,
    attention,
    color,
    isPhone,
    anchorRef,
    onOpen,
    invite = false
}: ActivityBubbleProps) {
    const layer = useLayer();
    const btnRef = useRef<HTMLButtonElement | null>(null);
    const [spot, setSpot] = useState<BubbleSpot | null>(loadSpot);       // null: not moved yet (at the stage's edge)
    const [drag, setDrag] = useState<Coordinates | null>(null);           // { x, y } while dragging
    const [snapping, setSnapping] = useState<boolean>(false);  // gliding to the edge after a drag
    const [, setTick] = useState<number>(0);                  // re-place on resize
    const moved = useRef<boolean>(false);

    // Place again once the page has its bubble layout (the stage changes size), and on resizes
    useLayoutEffect(() => {
        const bump = () => setTick((t) => t + 1);
        bump();
        window.addEventListener('resize', bump);
        const ro = typeof ResizeObserver !== 'undefined' && anchorRef.current ? new ResizeObserver(bump) : null;
        if (ro && anchorRef.current) ro.observe(anchorRef.current);
        return () => {
            window.removeEventListener('resize', bump);
            ro?.disconnect();
        };
    }, [anchorRef]);

    const size = () => btnRef.current?.offsetWidth || (isPhone ? 50 : 58);

    // Where it is now (screen px)
    const place = (): Coordinates & { side: 'left' | 'right' } => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (drag) return { ...drag, side: drag.x + size() / 2 < w / 2 ? 'left' : 'right' };
        if (spot) return { ...bubbleXY(spot, size(), w, h), side: spot.side };
        // Not moved: the right edge of the stage, halfway down on a phone (the video's own bar is at
        // the top and its controls at the bottom), near the bottom on a computer
        const r = anchorRef.current?.getBoundingClientRect();
        if (!r || !r.width) return { ...bubbleXY({ side: 'right', y: 0.5 }, size(), w, h), side: 'right' };
        const s = size();
        return {
            x: Math.min(w - s - EDGE, r.right - s - (isPhone ? 10 : 16)),
            y: isPhone ? r.top + (r.height - s) / 2 : r.bottom - s - 72,
            side: 'right'
        };
    };

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return;
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        const x0 = e.clientX;
        const y0 = e.clientY;
        moved.current = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* fine */ }
        const move = (ev: PointerEvent) => {
            if (!moved.current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
            moved.current = true;
            const s = el.offsetWidth;
            setDrag({
                x: Math.min(window.innerWidth - s - EDGE, Math.max(EDGE, ev.clientX - dx)),
                y: Math.min(window.innerHeight - s - EDGE, Math.max(EDGE, ev.clientY - dy))
            });
        };
        const up = (ev: PointerEvent) => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            if (!moved.current) return;
            const s = el.offsetWidth;
            const next = snapSpot(Math.min(window.innerWidth - s, Math.max(0, ev.clientX - dx)), ev.clientY - dy, s, window.innerWidth, window.innerHeight);
            saveSpot(next);
            setSnapping(true); // only this move is animated: it appears in place, without a slide
            setSpot(next);
            setDrag(null);
            setTimeout(() => setSnapping(false), 260);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
    }, []);

    const onClick = () => {
        if (moved.current) { // the end of a drag, not a tap
            moved.current = false;
            return;
        }
        onOpen();
    };

    if (!layer) return null;
    const p = place();
    return createPortal(
        <button
            ref={btnRef}
            type="button"
            className={`activity-bubble is-${p.side} ${invite ? 'is-invite' : ''} ${attention ? 'is-attention' : ''} ${drag ? 'is-dragging' : ''} ${snapping ? 'is-snapping' : ''}`}
            style={{ left: p.x, top: p.y, ...(color ? ({ '--bubble-ring': color } as React.CSSProperties) : {}) }}
            onPointerDown={onPointerDown}
            onClick={onClick}
            aria-label={`${label}. Drag to move it`}
            title={`${label} (drag to move)`}
        >
            <span className="activity-bubble-icon" aria-hidden="true">{icon}</span>
            {tag && <span className="activity-bubble-tag" aria-hidden="true">{tag}</span>}
        </button>,
        layer
    );
}
