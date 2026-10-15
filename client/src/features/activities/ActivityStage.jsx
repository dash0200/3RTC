/**
 * Shows the open activity: a title bar (name, who started it, Close) and the activity itself,
 * downloaded on first use. A crash inside an activity only replaces it with a message.
 *
 * Three ways to show it, chosen on each device (App keeps `view`, see activityHost.js):
 *   full   over the stage (videos keep playing underneath)
 *   window a small window over the video, dragged and resized (computers, while a video plays)
 *   bubble a round button; it pulses when the game needs you ("Your turn"), tap to open
 * The activity stays mounted in every view, so its timers and sounds keep working.
 */
import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChatPeek from './ChatPeek';
import { ActivityHostProvider } from './activityHost';

const WINDOW_KEY = '3rtc_activity_window';
const WINDOW_MIN = 300; // narrower and the board's tokens get too small to hit
const WINDOW_MAX = 520;
const EDGE = 8;

function readWindowBox() {
    try {
        const box = JSON.parse(localStorage.getItem(WINDOW_KEY) || 'null');
        if (box && Number.isFinite(box.width) && Number.isFinite(box.right) && Number.isFinite(box.bottom)) return box;
    } catch { /* nothing saved */ }
    return { width: 360, right: 16, bottom: 72 }; // bottom-right, above the video's control bar
}

/** The small window's size and place: dragged by its bar, resized from its top-left corner. */
function useFloatingBox(ref, active) {
    const [box, setBox] = useState(readWindowBox);
    const boxRef = useRef(box);
    boxRef.current = box;
    const clamp = useCallback((next) => {
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
    const startDrag = (e, mode) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (mode === 'move' && e.target.closest('button')) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY, ...boxRef.current };
        const move = (ev) => {
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
const fullscreenTarget = (el) => el?.closest('.stage-section') || el;
const canFullscreen = () => typeof document !== 'undefined' && !!document.fullscreenEnabled;

function useStageFullscreen(ref) {
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

const lazyCache = new Map();
const lazyFor = (definition) => {
    if (!lazyCache.has(definition.id)) lazyCache.set(definition.id, lazy(definition.load));
    return lazyCache.get(definition.id);
};

class ActivityErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { failed: false };
    }

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
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

export default function ActivityStage({ activity, definition, onClose, selfId, chat = null, view = 'full', onViewChange, isPhone = false, mediaActive = false }) {
    const ActivityComponent = useMemo(() => (definition ? lazyFor(definition) : null), [definition]);
    const rootRef = useRef(null);
    const [isFull, toggleFull] = useStageFullscreen(rootRef);
    const [status, setStatus] = useState({ attention: false, color: '', label: '' });
    const onStatus = useCallback((next) => setStatus((prev) => (
        prev.attention === next.attention && prev.color === next.color && prev.label === next.label ? prev : next)), []);
    const shown = view === 'window' && !isPhone ? 'window' : view === 'bubble' ? 'bubble' : 'full';
    const { box, startDrag } = useFloatingBox(rootRef, shown === 'window');
    const setView = (v) => onViewChange?.(v);
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
    const startedBy = activity.startedBy === selfId ? 'you' : (activity.startedByName || 'someone');
    const reopen = () => setView(!isPhone && mediaActive ? 'window' : 'full');
    const bubbleLabel = `${definition.name}${status.attention && status.label ? `: ${status.label}` : ''}. Open`;
    return (
        <>
        <div
            className={`stage-activity is-${shown} ${isFull ? 'is-fullscreen' : ''} ${chat?.splitView && shown === 'full' ? 'is-chat-split' : ''} ${status.attention ? 'needs-you' : ''}`}
            role="region"
            aria-label={definition.name}
            aria-hidden={shown === 'bubble' ? true : undefined}
            ref={rootRef}
            style={shown === 'window' ? { width: box.width, right: box.right, bottom: box.bottom, ...(status.color ? { '--bubble-ring': status.color } : {}) } : undefined}
        >
            {shown === 'window' && (
                <span className="activity-resize" onPointerDown={(e) => startDrag(e, 'resize')} title="Drag to resize" aria-hidden="true" />
            )}
            <div className="activity-bar" onPointerDown={shown === 'window' ? (e) => startDrag(e, 'move') : undefined}>
                <span className="activity-bar-icon" aria-hidden="true">{definition.icon}</span>
                <span className="activity-bar-name">{definition.name}</span>
                {shown === 'full' && <span className="activity-bar-meta">started by {startedBy}</span>}
                {shown === 'window' && <span className="activity-bar-meta">{status.attention && status.label ? status.label : 'drag to move'}</span>}
                {shown === 'full' && mediaActive && !isPhone && (
                    <button type="button" className="activity-bar-btn activity-window-btn" onClick={() => setView('window')} title="Play in a small window over the video">
                        ⧉ Small window
                    </button>
                )}
                {shown === 'window' && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-full-btn" onClick={() => setView('full')} title="Show the game full size" aria-label="Full size">⤢</button>
                )}
                {(shown === 'window' || (shown === 'full' && mediaActive)) && (
                    <button type="button" className="activity-bar-btn activity-icon-btn activity-min-btn" onClick={() => setView('bubble')} title="Minimise: you get a nudge when it's your turn" aria-label="Minimise">–</button>
                )}
                {chat?.onToggleSplitView && !isFull && shown === 'full' && (
                    <button type="button" className={`activity-bar-btn activity-chat-btn ${chat.splitView ? 'is-on' : ''}`} onClick={chat.onToggleSplitView}
                        aria-pressed={chat.splitView} title={chat.splitView ? 'Bigger board (hide chat messages)' : 'Show chat messages below the game'}>
                        💬 Chat{!chat.splitView && chat.unread > 0 && <span className="activity-chat-badge">{chat.unread > 9 ? '9+' : chat.unread}</span>}
                    </button>
                )}
                {canFullscreen() && shown === 'full' && (
                    <button type="button" className="activity-bar-btn activity-fullscreen-btn" onClick={toggleFull} title={isFull ? 'Exit full screen (Esc)' : 'Full screen'} aria-pressed={isFull}>
                        {isFull ? 'Exit full screen' : 'Full screen'}
                    </button>
                )}
                <button type="button" className={`activity-close-btn ${shown === 'window' ? 'activity-icon-btn' : ''}`} onClick={onClose} title="Close for everyone" aria-label="Close for everyone">
                    {shown === 'window' ? '✕' : 'Close'}
                </button>
            </div>
            <div className="activity-body">
                <ActivityErrorBoundary key={definition.id}>
                    <Suspense fallback={<div className="activity-message">Loading {definition.name}…</div>}>
                        <ActivityHostProvider onStatus={onStatus}>
                            <ActivityComponent activityId={definition.id} />
                        </ActivityHostProvider>
                    </Suspense>
                </ActivityErrorBoundary>
            </div>
            {showPeek && <ChatPeek messages={chat.messages} onOpenChat={isFull ? toggleFull : chat.onOpenChat} />}
        </div>
        {shown === 'bubble' && (
            <button
                type="button"
                className={`activity-bubble ${status.attention ? 'is-attention' : ''}`}
                style={status.color ? { '--bubble-ring': status.color } : undefined}
                onClick={reopen}
                aria-label={bubbleLabel}
                title={bubbleLabel}
            >
                <span className="activity-bubble-icon" aria-hidden="true">{definition.icon}</span>
                {status.attention && status.label && <span className="activity-bubble-tag" aria-hidden="true">{status.label}</span>}
            </button>
        )}
        </>
    );
}
