/**
 * Shows the open activity: a title bar (name, who started it, Close) and the activity itself,
 * downloaded on first use. A crash inside an activity only replaces it with a message.
 *
 * Three ways to show it, chosen on each device (App keeps `view`, see activityHost.js):
 *   full   over the stage (videos keep playing underneath)
 *   window a small window over the video, dragged and resized (computers, while a video plays)
 *   bubble a round button; it pulses when the game needs you ("Your turn"), tap to open
 * The activity stays mounted in every view, so its timers and sounds keep working.
 * Phone, game open over a video: swipe it down to put it away (like the YouTube app).
 *
 * Not loaded on this device (`loaded` false: someone else started it, or we left it): only its
 * bubble, tagged "Join <game>"; tapping it loads the game (useActivityLoad.js). "Leave" on the bar
 * unloads it again; "End" closes it for everyone.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ChatPeek, { type ChatPeekMessage } from './ChatPeek';
import ActivityBubble from './ActivityBubble';
import { ActivityHostProvider, type ActivityStatus, type ActivityViewKind } from './activityHost';

const WINDOW_KEY = '3rtc_activity_window';
const WINDOW_MIN = 300; // narrower and the board's tokens get too small to hit
const WINDOW_MAX = 520;
const EDGE = 8;

interface WindowBox {
    width: number;
    right: number;
    bottom: number;
}

function readWindowBox(): WindowBox {
    try {
        const box = JSON.parse(localStorage.getItem(WINDOW_KEY) || 'null');
        if (box && Number.isFinite(box.width) && Number.isFinite(box.right) && Number.isFinite(box.bottom)) return box;
    } catch { /* nothing saved */ }
    return { width: 360, right: 16, bottom: 72 }; // bottom-right, above the video's control bar
}

/**
 * Swipe the game down to put it away (phones, over a video), like the YouTube app. Works anywhere
 * on the game: a drag that starts going down while the game is scrolled to the top is the swipe;
 * taps, sideways drags and scrolling the game still work. The game follows the finger; let go far
 * or fast enough and `onDone` runs, else it springs back.
 */
function useSwipeDown(ref: React.RefObject<HTMLElement | null>, active: boolean, onDone: () => void) {
    const doneRef = useRef(onDone);
    doneRef.current = onDone;
    useEffect(() => {
        const el = ref.current;
        if (!active || !el) return undefined;
        let g: { x0: number; y0: number; t0: number; dy: number; state: 'maybe' | 'swipe' | 'no' } | null = null;
        const reset = (animate: boolean) => {
            el.style.transition = animate ? 'transform 0.18s ease, opacity 0.18s ease' : '';
            el.style.transform = '';
            el.style.opacity = '';
        };
        const start = (e: TouchEvent) => {
            if (e.touches.length !== 1) { g = null; return; }
            const t = e.touches[0];
            // Only from the top of the game: further down, a pull scrolls the game back up
            let atTop = true;
            for (let n: HTMLElement | null = e.target as HTMLElement; n && n !== el; n = n.parentElement) {
                if (n.scrollTop > 0) atTop = false;
            }
            g = { x0: t.clientX, y0: t.clientY, t0: performance.now(), dy: 0, state: atTop ? 'maybe' : 'no' };
        };
        const move = (e: TouchEvent) => {
            if (!g || g.state === 'no') return;
            const t = e.touches[0];
            const dx = t.clientX - g.x0;
            const dy = t.clientY - g.y0;
            if (g.state === 'maybe') {
                // Claim a downward start at once: Chrome commits to scrolling (or pull-to-refresh)
                // on the first move, after which the swipe couldn't stop it
                if (dy > 0 && dy >= Math.abs(dx) && e.cancelable) e.preventDefault();
                if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
                g.state = dy > 0 && dy > Math.abs(dx) * 1.2 ? 'swipe' : 'no';
                if (g.state === 'no') return;
                g.y0 = t.clientY; // follow from here, so the game doesn't jump
                g.t0 = performance.now();
                el.style.transition = 'none';
            }
            if (e.cancelable) e.preventDefault(); // no page scroll or pull-to-refresh while swiping
            g.dy = Math.max(0, t.clientY - g.y0);
            el.style.transform = g.dy ? `translateY(${g.dy}px)` : '';
            el.style.opacity = String(Math.max(0.35, 1 - g.dy / 500));
        };
        const end = (e: TouchEvent) => {
            if (!g) return;
            const swiped = g.state === 'swipe';
            const speed = g.dy / Math.max(1, performance.now() - g.t0);
            const away = swiped && e.type === 'touchend' && (g.dy > 90 || (g.dy > 30 && speed > 0.5));
            g = null;
            if (!swiped) return;
            reset(!away);
            if (away) doneRef.current?.();
        };
        el.addEventListener('touchstart', start, { passive: true });
        el.addEventListener('touchmove', move, { passive: false });
        el.addEventListener('touchend', end);
        el.addEventListener('touchcancel', end);
        return () => {
            el.removeEventListener('touchstart', start);
            el.removeEventListener('touchmove', move);
            el.removeEventListener('touchend', end);
            el.removeEventListener('touchcancel', end);
            reset(false);
        };
    }, [ref, active]);
}

function useFloatingBox(ref: React.RefObject<HTMLElement | null>, active: boolean) {
    const [box, setBox] = useState<WindowBox>(readWindowBox);
    const boxRef = useRef<WindowBox>(box);
    boxRef.current = box;
    const clamp = useCallback((next: WindowBox): WindowBox => {
        const parent = ref.current?.parentElement;
        const el = ref.current;
        if (!parent || !el) return next;
        const pw = parent.clientWidth;
        const ph = parent.clientHeight;
        const width = Math.max(Math.min(WINDOW_MIN, pw - 2 * EDGE), Math.min(next.width, WINDOW_MAX, pw - 2 * EDGE));
        const height = el.offsetHeight;
        return {
            width,
            right: Math.max(EDGE, Math.min(next.right, pw - width - EDGE)),
            bottom: Math.max(EDGE, Math.min(next.bottom, ph - Math.min(height, ph - 2 * EDGE) - EDGE))
        };
    }, [ref]);

    // Keep it inside the stage when the stage changes size
    useEffect(() => {
        if (!active) return undefined;
        const fit = () => setBox((b) => clamp(b));
        fit();
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [active, clamp]);

    const startDrag = (e: React.PointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
        if (e.button !== undefined && e.button !== 0) return;
        if (mode === 'move' && (e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, ...boxRef.current };
        const move = (ev: PointerEvent) => {
            const dx = ev.clientX - start.x;
            const dy = ev.clientY - start.y;
            setBox(clamp(mode === 'move'
                ? { ...start, right: start.right - dx, bottom: start.bottom - dy }
                : { ...start, width: start.width - dx }));
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            try { localStorage.setItem(WINDOW_KEY, JSON.stringify(boxRef.current)); } catch { /* storage blocked */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return { box, startDrag };
}

// Full screen takes the whole stage (so floating reactions still show over the game)
const fullscreenTarget = (el: HTMLElement | null) => el?.closest('.stage-section') || el;
const canFullscreen = () => typeof document !== 'undefined' && !!document.fullscreenEnabled;

function useStageFullscreen(ref: React.RefObject<HTMLElement | null>): [boolean, () => void] {
    const [isFull, setIsFull] = useState(false);
    useEffect(() => {
        const update = () => {
            const fs = document.fullscreenElement;
            setIsFull(!!fs && !!ref.current && fs.contains(ref.current));
        };
        document.addEventListener('fullscreenchange', update);
        return () => {
            document.removeEventListener('fullscreenchange', update);
            // Leaving full screen when the activity closes
            const fs = document.fullscreenElement;
            if (fs && ref.current && fs.contains(ref.current)) document.exitFullscreen?.().catch(() => { });
        };
    }, [ref]);
    const toggle = () => {
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => { });
        else fullscreenTarget(ref.current)?.requestFullscreen?.().catch(() => { });
    };
    return [isFull, toggle];
}

const lazyCache = new Map<string, LazyExoticComponent<ComponentType<{ activityId: string }>>>();
const lazyFor = (definition: ActivityDefinition) => {
    if (!lazyCache.has(definition.id)) lazyCache.set(definition.id, lazy(definition.load));
    return lazyCache.get(definition.id);
};

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    failed: boolean;
}

class ActivityErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { failed: true };
    }

    override render() {
        if (this.state.failed) {
            return (
                <div className="activity-message" role="alert">
                    <p>This activity stopped working on this device.</p>
                    <button type="button" className="btn btn-secondary" onClick={() => this.setState({ failed: false })}>Try again</button>
                </div>
            );
        }
        return this.props.children;
    }
}

export interface ActivityData {
    id?: string;
    type?: string;
    startedBy?: string;
    startedByName?: string;
}

export interface ActivityDefinition {
    id: string;
    name: string;
    icon: ReactNode;
    load: () => Promise<{ default: ComponentType<{ activityId: string }> }>;
}

export interface ActivityChatProps {
    messages: ChatPeekMessage[];
    isListVisible?: boolean;
    unread: number;
    onOpenChat: () => void;
    splitView?: boolean;
    onToggleSplitView?: () => void;
}

export interface ActivityStageProps {
    activity: ActivityData | null;
    definition?: ActivityDefinition | null;
    onClose: () => void;
    selfId?: string;
    chat?: ActivityChatProps | null;
    view?: ActivityViewKind;
    onViewChange?: (view: ActivityViewKind) => void;
    isPhone?: boolean;
    mediaActive?: boolean;
    loaded?: boolean;
    onJoin?: () => void;
    onLeave?: () => void;
    onStatusChange?: (status: ActivityStatus) => void;
}

export default function ActivityStage({
    activity,
    definition,
    onClose,
    selfId,
    chat = null,
    view = 'full',
    onViewChange,
    isPhone = false,
    mediaActive = false,
    loaded = true,
    onJoin,
    onLeave,
    onStatusChange
}: ActivityStageProps) {
    const ActivityComponent = useMemo(() => (definition ? lazyFor(definition) : null), [definition]);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [isFull, toggleFull] = useStageFullscreen(rootRef);
    // "Bigger": the game covers the whole app window (not the screen, like Full screen does)
    const [bigger, setBigger] = useState(false);
    const [status, setStatus] = useState<ActivityStatus>({ attention: false, color: '', label: '' });
    // Passed up right away (not from inside a state update): when the game closes, its last
    // "nothing needs you" still reaches the app even though this component is going away
    const lastStatus = useRef<ActivityStatus>({ attention: false, color: '', label: '' });
    const onStatus = useCallback((next: ActivityStatus) => {
        const prev = lastStatus.current;
        if (prev.attention === next.attention && prev.color === next.color && prev.label === next.label) return;
        lastStatus.current = next;
        setStatus(next);
        onStatusChange?.(next);
    }, [onStatusChange]);
    // Gone (ended, or closed here): nothing to call attention to
    useEffect(() => () => onStatusChange?.({ attention: false, color: '', label: '' }), [onStatusChange]);

    const shown = view === 'sidebar' && !isPhone ? 'sidebar' : view === 'window' && !isPhone ? 'window' : view === 'bubble' ? 'bubble' : 'full';
    const isBigger = bigger && shown === 'full' && !isFull && !isPhone;

    // Full size with a mouse: like the video player, the bar floats over the game and tucks
    // away, so the game gets the whole stage. It comes back when the pointer nears the top
    // (or the keyboard reaches it), and shows for a few seconds when the game opens full size.
    const canHover = useMemo(() => {
        try {
            return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        } catch {
            return false;
        }
    }, []);
    const overlayBar = shown === 'full' && !isPhone && canHover;
    // shown again whenever the view changes (tagged with the view it belongs to)
    const [bar, setBar] = useState({ view: shown, shown: true });
    const barShown = bar.view === shown ? bar.shown : true;
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showBarFor = useCallback((ms: number) => {
        setBar({ view: shown, shown: true });
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setBar({ view: shown, shown: false }), ms);
    }, [shown]);
    useEffect(() => {
        if (!overlayBar) return undefined;
        hideTimer.current = setTimeout(() => setBar({ view: shown, shown: false }), 3000);
        return () => {
            if (hideTimer.current) clearTimeout(hideTimer.current);
        };
    }, [overlayBar, shown]);
    const onStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!overlayBar || e.pointerType !== 'mouse') return;
        const top = rootRef.current?.getBoundingClientRect().top ?? 0;
        if (e.clientY - top < 72) showBarFor(1500);
    };
    useEffect(() => {
        if (!isBigger) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setBigger(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isBigger]);
    const { box, startDrag } = useFloatingBox(rootRef, shown === 'window');
    const setView = (v: ActivityViewKind) => onViewChange?.(v);

    // Where the bubble opens back to: the view it was minimised from (sidebar, window, or full)
    const openedAs = useRef<ActivityViewKind>('sidebar');
    if (shown !== 'bubble') openedAs.current = shown as ActivityViewKind;

    const [portalEl, setPortalEl] = useState<HTMLElement | null>(() => (typeof document !== 'undefined' ? document.getElementById('activity-sidebar-portal') : null));
    useEffect(() => {
        if (shown === 'sidebar' || (shown === 'bubble' && openedAs.current === 'sidebar')) {
            const el = document.getElementById('activity-sidebar-portal');
            if (el && el !== portalEl) setPortalEl(el);
        }
    }, [shown, portalEl]);

    const targetEl = portalEl || (typeof document !== 'undefined' ? document.getElementById('activity-sidebar-portal') : null);
    const shouldPortal = (shown === 'sidebar' || (shown === 'bubble' && openedAs.current === 'sidebar')) && Boolean(targetEl);

    const minimise = () => {
        if (isFull) toggleFull();
        setView('bubble');
    };

    // The game can be minimised at any time (a video playing or not): swipe it down on a phone
    const canSwipeAway = isPhone && shown === 'full';
    useSwipeDown(rootRef, canSwipeAway, minimise);

    // chat: { messages, isListVisible, unread, onOpenChat, splitView, onToggleSplitView } (from App)
    const showPeek = chat && shown === 'full' && (isFull || !chat.isListVisible);

    if (!activity) return null;
    if (!definition) {
        // Started from a newer version of the app
        return (
            <div className="stage-activity" role="region" aria-label="Activity">
                <div className="activity-message" role="note">
                    <p>{activity.startedByName || 'Someone'} opened an activity this version of 3RTC doesn't have yet.</p>
                    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Update app</button>
                    <button type="button" className="btn btn-secondary" onClick={onClose}>Close it</button>
                </div>
            </div>
        );
    }
    if (!loaded) {
        // Not loaded here: nothing of the game runs; its bubble invites us in
        return (
            <>
                <div className="stage-activity-anchor" ref={rootRef} aria-hidden="true" />
                <ActivityBubble
                    icon={definition.icon}
                    label={`${definition.name} is on (${activity.startedByName || 'someone'} started it). Join`}
                    tag={`Join ${definition.name}`}
                    invite
                    isPhone={isPhone}
                    anchorRef={rootRef}
                    onOpen={() => onJoin?.()}
                />
            </>
        );
    }

    const leave = () => {
        if (isFull) toggleFull();
        onLeave?.();
    };
    const startedBy = activity.startedBy === selfId ? 'you' : (activity.startedByName || 'someone');
    const reopen = () => setView(!isPhone && (openedAs.current === 'sidebar' || openedAs.current === 'window' || mediaActive) ? (openedAs.current === 'window' ? 'window' : 'sidebar') : 'full');
    const bubbleLabel = `${definition.name}${status.attention && status.label ? `: ${status.label}` : ''}. Open`;

    const content = (
        <div
            onPointerMove={onStagePointerMove}
            className={`stage-activity is-${shown} ${isFull ? 'is-fullscreen' : ''} ${isBigger ? 'is-bigger' : ''} ${overlayBar ? 'has-overlay-bar' : ''} ${overlayBar && !barShown ? 'bar-tucked' : ''} ${chat?.splitView && shown === 'full' ? 'is-chat-split' : ''} ${status.attention ? 'needs-you' : ''}`}
            role="region"
            aria-label={definition.name}
            aria-hidden={shown === 'bubble' ? true : undefined}
            ref={rootRef}
            style={shown === 'window' ? { width: box.width, right: box.right, bottom: box.bottom, ...(status.color ? ({ '--bubble-ring': status.color } as React.CSSProperties) : {}) } : undefined}
        >
            {overlayBar && <span className="activity-bar-handle" aria-hidden="true" />}
            {shown === 'window' && (
                <span className="activity-resize" onPointerDown={(e) => startDrag(e, 'resize')} title="Drag to resize" aria-hidden="true" />
            )}
            <div className={`activity-bar ${canSwipeAway ? 'can-swipe' : ''}`} onPointerDown={shown === 'window' ? (e) => startDrag(e, 'move') : undefined}>
                {canSwipeAway && <span className="activity-grab" aria-hidden="true" />}
                <span className="activity-bar-icon" aria-hidden="true">{definition.icon}</span>
                <span className="activity-bar-name">{definition.name}</span>
                {shown === 'full' && <span className="activity-bar-meta">started by {startedBy}</span>}
                {shown === 'sidebar' && <span className="activity-bar-meta">{status.attention && status.label ? status.label : `started by ${startedBy}`}</span>}
                {shown === 'window' && <span className="activity-bar-meta">{status.attention && status.label ? status.label : 'drag to move'}</span>}

                {/* Dock to Sidebar from Full stage */}
                {shown === 'full' && !isPhone && (
                    <button type="button" className="activity-bar-btn activity-sidebar-btn" onClick={() => setView('sidebar')} title="Dock the game into the sidebar next to the video">
                        ⫸ Sidebar
                    </button>
                )}
                {/* Small floating window from Full stage */}
                {shown === 'full' && !isPhone && (
                    <button type="button" className="activity-bar-btn activity-window-btn" onClick={() => setView('window')} title={mediaActive ? 'Play in a small window over the video' : 'Play in a small window'}>
                        ⧉ Window
                    </button>
                )}

                {/* Controls when docked in Sidebar */}
                {shown === 'sidebar' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-full-btn" onClick={() => setView('full')} title="Expand game full size over stage" aria-label="Full size">⤢</button>
                )}
                {shown === 'sidebar' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-window-btn" onClick={() => setView('window')} title="Detach into a small floating window" aria-label="Small window">⧉</button>
                )}
                {shown === 'sidebar' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-min-btn" onClick={() => setView('bubble')} title="Minimise: you get a nudge when it's your turn" aria-label="Minimise">–</button>
                )}

                {/* Controls when floating in Small Window */}
                {shown === 'window' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-sidebar-btn" onClick={() => setView('sidebar')} title="Dock game into sidebar beside the video" aria-label="Dock to sidebar">⫸</button>
                )}
                {shown === 'window' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-full-btn" onClick={() => setView('full')} title="Show the game full size" aria-label="Full size">⤢</button>
                )}
                {shown === 'window' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-min-btn" onClick={() => setView('bubble')} title="Minimise: you get a nudge when it's your turn" aria-label="Minimise">–</button>
                )}

                {shown === 'full' && (
                    // Minimise to the bubble (it nudges you on your turn). Over a video it says where you go
                    <button type="button" className="activity-bar-btn activity-video-btn" onClick={minimise}
                        title={mediaActive ? 'Watch the video: the game becomes a bubble that nudges you on your turn' : 'Minimise: the game becomes a bubble that nudges you on your turn'}>
                        {mediaActive ? '▶ Video' : '▾ Minimise'}
                    </button>
                )}
                {chat?.onToggleSplitView && !isFull && shown === 'full' && (
                    <button type="button" className={`activity-bar-btn activity-chat-btn ${chat.splitView ? 'is-on' : ''}`} onClick={chat.onToggleSplitView}
                        aria-pressed={chat.splitView} title={chat.splitView ? 'Bigger board (hide chat messages)' : 'Show chat messages below the game'}>
                        💬<span className="activity-btn-text"> Chat</span>{!chat.splitView && chat.unread > 0 && <span className="activity-chat-badge">{chat.unread > 9 ? '9+' : chat.unread}</span>}
                    </button>
                )}
                {shown === 'full' && !isPhone && !isFull && (
                    <button type="button" className={`activity-bar-btn activity-bigger-btn ${isBigger ? 'is-on' : ''}`} onClick={() => setBigger((b) => !b)}
                        title={isBigger ? 'Back to the normal size (Esc)' : 'Make the game fill the whole window'} aria-pressed={isBigger}>
                        {isBigger ? '⤡ Smaller' : '⤢ Bigger'}
                    </button>
                )}
                {canFullscreen() && shown === 'full' && !isPhone && (
                    <button type="button" className="activity-bar-btn activity-fullscreen-btn" onClick={toggleFull} title={isFull ? 'Exit full screen (Esc)' : 'Full screen'} aria-pressed={isFull}>
                        {isFull ? 'Exit full screen' : 'Full screen'}
                    </button>
                )}

                {/* Leave: just me (the game unloads here and goes on for the others). End: everyone. */}
                <button type="button" className={`activity-bar-btn activity-leave-btn ${shown === 'window' || shown === 'sidebar' ? 'activity-icon-btn' : ''}`} onClick={leave}
                    title={`Leave ${definition.name}: it closes on this device only and keeps going for the others`} aria-label={`Leave ${definition.name} (just you)`}>
                    {shown === 'window' || shown === 'sidebar' ? '✕' : 'Leave'}
                </button>
                {(shown === 'full' || shown === 'sidebar') && (
                    <button type="button" className="activity-close-btn" onClick={onClose} title="End it for everyone" aria-label="End for everyone">
                        End
                    </button>
                )}
            </div>
            <div className="activity-body">
                <ActivityErrorBoundary key={definition.id}>
                    <Suspense fallback={<div className="activity-message">Loading {definition.name}…</div>}>
                        <ActivityHostProvider onStatus={onStatus}>
                            {ActivityComponent ? <ActivityComponent activityId={definition.id} /> : null}
                        </ActivityHostProvider>
                    </Suspense>
                </ActivityErrorBoundary>
            </div>
            {showPeek && <ChatPeek messages={chat.messages} onOpenChat={isFull ? toggleFull : chat.onOpenChat} />}
        </div>
    );

    return (
        <>
            {shouldPortal && targetEl ? (
                <>
                    <div className="stage-activity-anchor" ref={rootRef} aria-hidden="true" />
                    {createPortal(content, targetEl)}
                </>
            ) : (
                content
            )}
            {shown === 'bubble' && (
                <ActivityBubble
                    icon={definition.icon}
                    label={bubbleLabel}
                    tag={status.attention ? status.label : ''}
                    attention={status.attention}
                    color={status.color}
                    isPhone={isPhone}
                    anchorRef={rootRef}
                    onOpen={reopen}
                />
            )}
        </>
    );
}
