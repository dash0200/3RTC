/**
 * Connection to the signaling server: connects, keeps the socket alive, reconnects automatically,
 * and on reconnect resumes the room (host) or rejoins it (guest) and recovers broken P2P links.
 * Incoming messages go to the latest `handleSignalingMessage`.
 */
import { useEffect, useRef } from 'react';

export function useSignalingConnection(ctx) {
    const { addSystemMessage, currentRoomRef, handleSignalingMessage, isHostRef, peerIdRef, peersRef, pendingSignalsRef, setSignalStatus, showToast, signalUrl, wsRef } = ctx;

    const handleSignalingMessageRef = useRef();
    handleSignalingMessageRef.current = handleSignalingMessage;

    // Connect to Signaling Server
    useEffect(() => {
        let isCancelled = false;
        let reconnectTimeout = null;
        let pingInterval = null;

        const safeCloseSocket = (socket) => {
            if (!socket) return;
            try {
                if (socket.readyState === WebSocket.CONNECTING) {
                    // Defer closing until open to avoid Chrome console error:
                    // "WebSocket is closed before the connection is established"
                    socket.onopen = () => {
                        try { socket.close(1000, 'Replaced or unmounted'); } catch { }
                    };
                    socket.onerror = () => { };
                    socket.onclose = () => { };
                } else if (socket.readyState === WebSocket.OPEN) {
                    socket.close(1000, 'Replaced or unmounted');
                }
            } catch { }
        };

        if (wsRef.current) {
            safeCloseSocket(wsRef.current);
            wsRef.current = null;
        }

        const isLocalServer = signalUrl.includes('localhost') || signalUrl.includes('127.0.0.1');
        const serverLabel = isLocalServer ? 'Local' : 'Cloud';

        const connect = () => {
            if (isCancelled) return;
            let hasOpened = false;

            setSignalStatus({ connected: false, label: 'Connecting...' });

            let ws;
            try {
                ws = new WebSocket(signalUrl);
                wsRef.current = ws;
            } catch (err) {
                if (isCancelled) return;
                setSignalStatus({ connected: false, label: 'Connection Failed' });
                showToast(`Failed to connect to ${signalUrl}`);
                return;
            }

            ws.onopen = () => {
                hasOpened = true;
                if (isCancelled) {
                    safeCloseSocket(ws);
                    return;
                }

                setSignalStatus({ connected: true, label: `${serverLabel} Connected` });
                showToast(`Connected to ${serverLabel} signaling`);

                // If previously inside a room before connection drop, re-announce
                if (currentRoomRef.current) {
                    const activeRoom = currentRoomRef.current;
                    addSystemMessage(`🔄 Reconnected to signaling. Resuming room ${activeRoom}...`);
                    if (isHostRef.current) {
                        ws.send(JSON.stringify({
                            type: 'create-room',
                            roomId: activeRoom,
                            peerId: peerIdRef.current
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'join',
                            roomId: activeRoom,
                            peerId: peerIdRef.current,
                            rejoin: true
                        }));
                    }
                }

                // Flush any queued signals
                while (pendingSignalsRef.current.length > 0) {
                    const data = pendingSignalsRef.current.shift();
                    ws.send(JSON.stringify(data));
                }

                // P2P links that broke while signaling was down can be recovered now
                for (const entry of peersRef.current.values()) {
                    if (entry.pc && entry.pc.connectionState !== 'connected' && entry.pc.connectionState !== 'new' &&
                        entry.pc.connectionState !== 'connecting') {
                        entry.scheduleRecovery?.(1000);
                    }
                }

                // Start periodic ping to prevent reverse proxies (e.g. Caddy on GCP) from terminating idle connections
                clearInterval(pingInterval);
                pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'ping' }));
                        } catch { }
                    }
                }, 25000);
            };

            ws.onmessage = (event) => {
                if (isCancelled) return;
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'pong') return;
                    handleSignalingMessageRef.current?.(msg);
                } catch (err) { }
            };

            ws.onclose = (event) => {
                clearInterval(pingInterval);
                if (isCancelled) return;

                // If closed cleanly with code 1000 on intentional unmount, do not reconnect
                if (event.code === 1000) {
                    setSignalStatus({ connected: false, label: 'Disconnected' });
                    return;
                }

                setSignalStatus({ connected: false, label: 'Reconnecting...' });

                // Show friendly prompt if local dev server was selected but is not running
                if (isLocalServer && !hasOpened) {
                    showToast('Local server not reachable on port 8080. Start "node server.js" or switch to GCP Cloud Server.');
                }

                // Schedule auto-reconnect
                clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => {
                    if (!isCancelled) {
                        connect();
                    }
                }, 2500);
            };

            ws.onerror = () => {
                if (isCancelled) return;
                setSignalStatus({ connected: false, label: 'Signaling Error' });
            };
        };

        connect();

        return () => {
            isCancelled = true;
            clearTimeout(reconnectTimeout);
            clearInterval(pingInterval);
            if (wsRef.current) {
                safeCloseSocket(wsRef.current);
                wsRef.current = null;
            }
        };
    }, [signalUrl, showToast, addSystemMessage]);
}
