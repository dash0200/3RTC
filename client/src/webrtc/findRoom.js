/**
 * Rooms live on the signaling server they were made on, and the app can be on a different one
 * (it falls back from Oracle to GCP when a server can't be reached). Before telling someone a code
 * doesn't exist, ask the other servers: { type: 'find-room', roomId } -> { type: 'room-found', exists }.
 */

/** Which of `urls` has room `roomId` (all asked at once), or null if none says yes in time. */
export function findRoomOn(urls, roomId, timeoutMs = 5000) {
  if (!urls.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    const sockets = [];
    let pending = urls.length;
    let done = false;
    const finish = (url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const ws of sockets) {
        try {
          ws.close(1000, 'Room lookup done');
        } catch {
          // already closed
        }
      }
      resolve(url);
    };
    const oneDone = () => {
      pending -= 1;
      if (pending <= 0) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const url of urls) {
      let answered = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        oneDone();
        continue;
      }
      sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'find-room', roomId }));
      ws.onmessage = (event) => {
        let msg = null;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg?.type === 'room-found' && msg.roomId === roomId) {
          answered = true;
          if (msg.exists) finish(url);
          else oneDone();
        } else if (msg?.type === 'error') {
          answered = true;
          oneDone();
        }
      };
      ws.onclose = () => {
        if (!answered) {
          answered = true;
          oneDone();
        }
      };
    }
  });
}

/** Same server? (WebSocket.url adds a trailing slash) */
export const sameServer = (a, b) => Boolean(a && b) && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
