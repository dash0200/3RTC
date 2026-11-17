/**
 * Connection to the signaling server: connects, keeps the socket alive, reconnects automatically,
 * and on reconnect resumes the room (host) or rejoins it (guest) and recovers broken P2P links.
 * Incoming messages go to the latest `handleSignalingMessage`.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { IncomingSignalingMessage, OutgoingSignalingMessage } from '../types';
import { createLiveness, SIGNAL_LIVENESS, type Liveness } from '../webrtc/liveness';

export interface SignalStatus {
  connected: boolean;
  label: string;
  activeUrl?: string;
}

export interface RoomTokens {
  roomId: string | null;
  seat: string | null;
  host: string | null;
}

export interface PeerMeshEntry {
  pc?: RTCPeerConnection | null;
  scheduleRecovery?: (delayMs: number) => void;
  [key: string]: unknown;
}

export interface SignalingConnectionContext {
  signalUrl: string;
  fallbackUrls?: string[];
  wsRef: MutableRefObject<WebSocket | null>;
  pendingSignalsRef: MutableRefObject<OutgoingSignalingMessage[]>;
  currentRoomRef: MutableRefObject<string | null>;
  roomTokensRef: MutableRefObject<RoomTokens>;
  peerIdRef: MutableRefObject<string | null>;
  isHostRef: MutableRefObject<boolean>;
  peersRef: MutableRefObject<Map<string, PeerMeshEntry>>;
  setSignalStatus: (status: SignalStatus) => void;
  showToast: (text: string) => void;
  addSystemMessage: (text: string) => void;
  handleSignalingMessage: (msg: IncomingSignalingMessage) => void;
}

/** Returns switchServer(url): move to that signaling server now (the one that has the room the user
 *  is joining) and stay on it for reconnects, until the server settings change. */
export function useSignalingConnection(ctx: SignalingConnectionContext): (url: string) => void {
  const {
    addSystemMessage,
    currentRoomRef,
    fallbackUrls = [],
    handleSignalingMessage,
    isHostRef,
    peerIdRef,
    peersRef,
    pendingSignalsRef,
    roomTokensRef,
    setSignalStatus,
    showToast,
    signalUrl,
    wsRef
  } = ctx;

  const fallbackKey = fallbackUrls.join(' ');
  const handleSignalingMessageRef = useRef<(msg: IncomingSignalingMessage) => void>(handleSignalingMessage);
  const switchServerRef = useRef<((url: string) => void) | null>(null);
  // The server that has our room, when it isn't the one we'd pick (see switchServer); kept across
  // re-runs of the effect below, dropped when the chosen server (settings) changes
  const roomServerRef = useRef<{ url: string; base: string } | null>(null);

  useEffect(() => {
    handleSignalingMessageRef.current = handleSignalingMessage;
  });

  useEffect(() => {
    let isCancelled = false;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    // Whether the open socket still answers (webrtc/liveness.ts)
    let liveness: Liveness | null = null;
    if (roomServerRef.current && roomServerRef.current.base !== signalUrl) roomServerRef.current = null;

    const safeCloseSocket = (socket: WebSocket | null) => {
      if (!socket) return;
      try {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => {
            try {
              socket.close(1000, 'Replaced or unmounted');
            } catch {
              // ignore
            }
          };
          socket.onerror = () => {};
          socket.onclose = () => {};
        } else if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, 'Replaced or unmounted');
        }
      } catch {
        // ignore
      }
    };

    if (wsRef.current) {
      safeCloseSocket(wsRef.current);
      wsRef.current = null;
    }

    const urls = [signalUrl, ...fallbackKey.split(' ').filter((u) => u && u !== signalUrl)];
    let urlIndex = 0;
    const isLocalServer = signalUrl.includes('localhost') || signalUrl.includes('127.0.0.1');

    const getServerLabel = (url?: string) => {
      if (!url) return 'Cloud';
      if (url.includes('orc.3rtc.me')) return 'Oracle Cloud';
      if (url.includes('gcp.3rtc.me')) return 'Google Cloud';
      if (url.includes('localhost') || url.includes('127.0.0.1')) return 'Local';
      return 'Cloud';
    };

    const connect = () => {
      if (isCancelled) return;
      let hasOpened = false;

      setSignalStatus({ connected: false, label: 'Connecting...' });

      const activeUrl = roomServerRef.current?.url || urls[urlIndex] || signalUrl;
      const activeLabel = getServerLabel(activeUrl);

      let ws: WebSocket;
      try {
        ws = new WebSocket(activeUrl);
        wsRef.current = ws;
      } catch {
        if (isCancelled) return;
        setSignalStatus({ connected: false, label: 'Connection Failed' });
        showToast('Failed to connect to the server');
        return;
      }

      ws.onopen = () => {
        hasOpened = true;
        if (isCancelled) {
          safeCloseSocket(ws);
          return;
        }

        setSignalStatus({ connected: true, label: `${activeLabel} Connected`, activeUrl });
        // No toast: the connection pill already shows it, and a toast here would push out messages that matter
        addSystemMessage(`Connected to ${activeLabel} signaling`);
        if (urlIndex > 0) {
          addSystemMessage(`🔄 Connected to backup signaling server (${activeLabel}).`);
        }

        if (currentRoomRef.current) {
          const activeRoom = currentRoomRef.current;
          addSystemMessage(`🔄 Reconnected to signaling. Resuming room ${activeRoom}...`);
          const tokens =
            roomTokensRef?.current?.roomId === String(activeRoom) ? roomTokensRef.current : { host: null, seat: null };
          if (isHostRef.current) {
            ws.send(
              JSON.stringify({
                type: 'create-room',
                roomId: activeRoom,
                peerId: peerIdRef.current,
                ...(tokens.host ? { hostToken: tokens.host } : {}),
                ...(tokens.seat ? { seatToken: tokens.seat } : {})
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'join',
                roomId: activeRoom,
                peerId: peerIdRef.current,
                rejoin: true,
                ...(tokens.seat ? { seatToken: tokens.seat } : {})
              })
            );
          }
        }

        while (pendingSignalsRef.current.length > 0) {
          const data = pendingSignalsRef.current.shift();
          if (data) ws.send(JSON.stringify(data));
        }

        for (const entry of peersRef.current.values()) {
          if (
            entry.pc &&
            entry.pc.connectionState !== 'connected' &&
            entry.pc.connectionState !== 'new' &&
            entry.pc.connectionState !== 'connecting'
          ) {
            entry.scheduleRecovery?.(1000);
          }
        }

        liveness?.stop();
        liveness = createLiveness({
          sendPing: () => {
            try {
              ws.send(JSON.stringify({ type: 'ping' }));
              return true;
            } catch {
              return false;
            }
          },
          isHidden: () => document.visibilityState === 'hidden',
          onDead: () => {
            if (wsRef.current === ws) reconnectNow();
          }
        });
        clearInterval(pingInterval!);
        // The keep-alive ping, which must be answered: a socket that went dead without closing
        // (after a network change) is noticed within seconds instead of minutes
        pingInterval = setInterval(() => liveness?.probe(true), SIGNAL_LIVENESS.pingEveryMs);
      };

      ws.onmessage = (event) => {
        if (isCancelled) return;
        liveness?.heard();
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') return;
          handleSignalingMessageRef.current?.(msg);
        } catch {
          // ignore invalid json
        }
      };

      ws.onclose = (event) => {
        if (pingInterval) clearInterval(pingInterval);
        liveness?.stop();
        liveness = null;
        if (isCancelled) return;

        if (event.code === 1000) {
          setSignalStatus({ connected: false, label: 'Disconnected' });
          return;
        }

        setSignalStatus({ connected: false, label: 'Reconnecting...' });

        if (isLocalServer && !hasOpened) {
          showToast(
            'Local server not reachable on port 8080. Start "node server.js" or switch to Oracle/GCP Cloud Server.'
          );
        }

        if (!hasOpened && roomServerRef.current) {
          roomServerRef.current = null; // the room's server can't be reached now: back to the usual order
        } else if (!hasOpened && urls.length > 1) {
          urlIndex = (urlIndex + 1) % urls.length;
        }

        if (reconnectTimeout) clearTimeout(reconnectTimeout);
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

    // The current socket is dead though it looks open: drop it quietly and connect again now (the
    // room is resumed on open, and broken direct connections recovered, as after any reconnect)
    const reconnectNow = () => {
      if (isCancelled) return;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (pingInterval) clearInterval(pingInterval);
      liveness?.stop();
      liveness = null;
      const old = wsRef.current;
      if (old) {
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        try {
          old.close(4000, 'No answer');
        } catch {
          // already closed
        }
        wsRef.current = null;
      }
      setSignalStatus({ connected: false, label: 'Reconnecting...' });
      connect();
    };

    // After a network change or coming back to the tab: check the socket now, or, while waiting to
    // reconnect, don't wait out the delay (the network is back)
    const probe = () => {
      if (isCancelled) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        liveness?.probe();
      } else if (reconnectTimeout && (!ws || ws.readyState === WebSocket.CLOSED)) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
        connect();
      }
    };

    const onNetworkChange = () => probe();
    const onVisible = () => {
      if (document.visibilityState === 'visible') probe();
    };
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener('online', onNetworkChange);
    document.addEventListener('visibilitychange', onVisible);
    connection?.addEventListener?.('change', onNetworkChange);

    switchServerRef.current = (url: string) => {
      if (isCancelled) return;
      roomServerRef.current = { url, base: signalUrl };
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (pingInterval) clearInterval(pingInterval);
      liveness?.stop();
      liveness = null;
      const old = wsRef.current;
      if (old) {
        // Quietly: its close must not set the status or schedule a reconnect
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        try {
          old.close(1000, 'Switching server');
        } catch {
          // already closed
        }
        wsRef.current = null;
      }
      connect();
    };

    connect();

    return () => {
      isCancelled = true;
      switchServerRef.current = null;
      window.removeEventListener('online', onNetworkChange);
      document.removeEventListener('visibilitychange', onVisible);
      connection?.removeEventListener?.('change', onNetworkChange);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (pingInterval) clearInterval(pingInterval);
      liveness?.stop();
      if (wsRef.current) {
        safeCloseSocket(wsRef.current);
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalUrl, fallbackKey, showToast, addSystemMessage]);

  return useCallback((url: string) => switchServerRef.current?.(url), []);
}
