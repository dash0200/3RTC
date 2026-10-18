import React, { useState, useEffect, useRef, useCallback } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';
import { getAvatarColor, sound } from '../../utils/sound';

/**
 * Calculates the bounding box of the active video content within a container,
 * accounting for object-fit: contain (pillarbox / letterbox).
 */
export function getContainedVideoBounds(videoEl, containerEl) {
    if (!videoEl || !containerEl) return null;
    const cw = containerEl.clientWidth;
    const ch = containerEl.clientHeight;
    const vw = videoEl.videoWidth || cw;
    const vh = videoEl.videoHeight || ch;
    if (!vw || !vh || !cw || !ch) return { left: 0, top: 0, width: cw, height: ch };

    const containerAspect = cw / ch;
    const videoAspect = vw / vh;

    let width, height, left, top;
    if (containerAspect > videoAspect) {
        // Pillarboxed (black bars left and right)
        height = ch;
        width = ch * videoAspect;
        top = 0;
        left = (cw - width) / 2;
    } else {
        // Letterboxed (black bars top and bottom)
        width = cw;
        height = cw / videoAspect;
        left = 0;
        top = (ch - height) / 2;
    }

    return { left, top, width, height };
}

/**
 * ScreenPointerOverlay: Collaborative Colored Cursor & Small Droplet Ping Overlay.
 * Displays each peer's cursor in their DP color with their name, and a small water-droplet ripple on click.
 */
export default function ScreenPointerOverlay({
    videoRef,
    containerRef,
    bus,
    localUser,
    isLaserActive = false
}) {
    const [bounds, setBounds] = useState(null);
    const [remotePointers, setRemotePointers] = useState({}); // peerId -> { x, y, username, color, active, lastSeen }
    const [localPointer, setLocalPointer] = useState(null);
    const [pings, setPings] = useState([]); // array of { id, x, y, username, color }

    const lastSendTimeRef = useRef(0);
    const boundsRef = useRef(null);
    boundsRef.current = bounds;

    // Keep active video bounds updated
    const updateBounds = useCallback(() => {
        if (videoRef.current && containerRef.current) {
            const b = getContainedVideoBounds(videoRef.current, containerRef.current);
            setBounds(b);
        }
    }, [videoRef, containerRef]);

    useEffect(() => {
        updateBounds();
        window.addEventListener('resize', updateBounds);
        const ro = new ResizeObserver(updateBounds);
        if (containerRef.current) ro.observe(containerRef.current);
        if (videoRef.current) ro.observe(videoRef.current);
        return () => {
            window.removeEventListener('resize', updateBounds);
            ro.disconnect();
        };
    }, [updateBounds, containerRef, videoRef]);

    // Cleanup stale pointers (fades out after 2.5 seconds of idle)
    useEffect(() => {
        const timer = setInterval(() => {
            const now = Date.now();
            setRemotePointers((prev) => {
                let changed = false;
                const next = {};
                for (const [id, p] of Object.entries(prev)) {
                    if (now - p.lastSeen < 2500) {
                        next[id] = p;
                    } else {
                        changed = true;
                    }
                }
                return changed ? next : prev;
            });
        }, 800);
        return () => clearInterval(timer);
    }, []);

    // Listen for incoming remote pointer movements
    usePeerMessageOn(bus, 'screen-pointer', (data, fromPeerId) => {
        if (!data) return;
        const peerId = data.peerId || fromPeerId;
        if (peerId === localUser?.peerId) return;

        if (data.active === false) {
            setRemotePointers((prev) => {
                if (!prev[peerId]) return prev;
                const next = { ...prev };
                delete next[peerId];
                return next;
            });
            return;
        }

        setRemotePointers((prev) => ({
            ...prev,
            [peerId]: {
                x: data.x,
                y: data.y,
                username: data.username || 'Peer',
                color: getAvatarColor(data.username || 'Peer'),
                active: true,
                lastSeen: Date.now()
            }
        }));
    });

    // Trigger subtle droplet ping on screen
    const triggerPing = useCallback((pingData) => {
        try {
            sound.playPop();
        } catch {}
        setPings((prev) => [...prev.slice(-8), pingData]);
        setTimeout(() => {
            setPings((prev) => prev.filter((p) => p.id !== pingData.id));
        }, 800);
    }, []);

    // Listen for incoming remote click pings
    usePeerMessageOn(bus, 'screen-ping', (data) => {
        if (!data) return;
        triggerPing({
            ...data,
            color: data.color || getAvatarColor(data.username || 'Peer')
        });
    });

    // Handle local pointer move
    const handlePointerMove = (e) => {
        if (!isLaserActive) return;

        const currentBounds = boundsRef.current;
        if (!currentBounds || !containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const relX = e.clientX - rect.left - currentBounds.left;
        const relY = e.clientY - rect.top - currentBounds.top;

        if (relX < 0 || relX > currentBounds.width || relY < 0 || relY > currentBounds.height) {
            return;
        }

        const normX = relX / currentBounds.width;
        const normY = relY / currentBounds.height;
        const selfName = localUser?.username || 'You';

        // Update local cursor immediately for zero-latency tracking
        setLocalPointer({
            x: normX,
            y: normY,
            username: selfName,
            color: getAvatarColor(selfName)
        });

        // Throttle broadcast to ~30fps for bandwidth efficiency
        const now = Date.now();
        if (now - lastSendTimeRef.current >= 33) {
            lastSendTimeRef.current = now;
            bus?.broadcast('screen-pointer', {
                x: normX,
                y: normY,
                peerId: localUser?.peerId,
                username: selfName,
                active: true
            });
        }
    };

    // Handle local pointer leave
    const handlePointerLeave = () => {
        if (!isLaserActive) return;
        setLocalPointer(null);
        bus?.broadcast('screen-pointer', {
            peerId: localUser?.peerId,
            active: false
        });
    };

    // Handle click ping
    const handleClick = (e) => {
        if (!isLaserActive) return;
        const currentBounds = boundsRef.current;
        if (!currentBounds || !containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const relX = e.clientX - rect.left - currentBounds.left;
        const relY = e.clientY - rect.top - currentBounds.top;

        if (relX < 0 || relX > currentBounds.width || relY < 0 || relY > currentBounds.height) {
            return;
        }

        const normX = relX / currentBounds.width;
        const normY = relY / currentBounds.height;
        const pingId = `ping_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const selfName = localUser?.username || 'You';

        const pingData = {
            id: pingId,
            x: normX,
            y: normY,
            peerId: localUser?.peerId,
            username: selfName,
            color: getAvatarColor(selfName)
        };

        triggerPing(pingData);

        bus?.broadcast('screen-ping', pingData);
    };

    const hasBounds = bounds && bounds.width > 0 && bounds.height > 0;

    return (
        <div
            className={`screen-pointer-layer ${isLaserActive ? 'laser-active' : ''}`}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleClick}
        >
            {hasBounds && (
                <>
                    {/* Render local colored cursor */}
                    {isLaserActive && localPointer && (
                        <div
                            className="screen-pointer-marker is-self"
                            style={{
                                transform: `translate3d(${bounds.left + localPointer.x * bounds.width}px, ${bounds.top + localPointer.y * bounds.height}px, 0)`,
                                '--pointer-color': localPointer.color
                            }}
                        >
                            <svg
                                className="screen-cursor-arrow-svg"
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill={localPointer.color}
                                stroke="#ffffff"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                            </svg>
                            <div className="screen-pointer-tag">
                                <span className="screen-pointer-name">You</span>
                            </div>
                        </div>
                    )}

                    {/* Render all remote peer colored cursors */}
                    {Object.entries(remotePointers).map(([peerId, p]) => (
                        <div
                            key={peerId}
                            className="screen-pointer-marker"
                            style={{
                                transform: `translate3d(${bounds.left + p.x * bounds.width}px, ${bounds.top + p.y * bounds.height}px, 0)`,
                                '--pointer-color': p.color
                            }}
                        >
                            <svg
                                className="screen-cursor-arrow-svg"
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill={p.color}
                                stroke="#ffffff"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                            </svg>
                            <div className="screen-pointer-tag">
                                <span className="screen-pointer-name">{p.username}</span>
                            </div>
                        </div>
                    ))}

                    {/* Render small water droplet ripple pings */}
                    {pings.map((ping) => (
                        <div
                            key={ping.id}
                            className="screen-ping-droplet"
                            style={{
                                left: `${bounds.left + ping.x * bounds.width}px`,
                                top: `${bounds.top + ping.y * bounds.height}px`,
                                '--ping-color': ping.color
                            }}
                        >
                            <span className="droplet-ring ring-1" />
                            <span className="droplet-ring ring-2" />
                            <span className="droplet-core" />
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}
