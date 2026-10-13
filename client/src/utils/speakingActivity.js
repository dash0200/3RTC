/**
 * Live speaking activity (who is talking, and how loud) for the speaking rings and level meters.
 *
 * It changes many times a second while anyone talks, so it is kept OUT of React state at the top
 * of the app: the voice loop writes here, and only the small components that draw rings and
 * meters subscribe (useSpeakingActivity / useLiveVoiceUsers). The rest of the UI (chat, video
 * players, header) doesn't re-render when someone speaks.
 */
import { useMemo, useSyncExternalStore } from 'react';

const SILENT = Object.freeze({ isSpeaking: false, level: 0 });
const LOCAL_LEVEL_STEP = 4;  // ignore smaller level changes (same thresholds as before)
const PEER_LEVEL_STEP = 5;

let snapshot = { local: SILENT, peers: {} };
const listeners = new Set();

function publish(next) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export const speakingActivity = {
  get: () => snapshot,

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** True when there is nothing showing as active (lets the voice loop idle). */
  isIdle() {
    return !snapshot.local.isSpeaking && snapshot.local.level === 0 && Object.keys(snapshot.peers).length === 0;
  },

  /** New measurements: publishes only if something changed enough to be visible. */
  update(local, peers) {
    const prev = snapshot;
    const localChanged = prev.local.isSpeaking !== local.isSpeaking ||
      Math.abs(prev.local.level - local.level) > LOCAL_LEVEL_STEP;

    let peersChanged = false;
    const ids = Object.keys(peers);
    if (ids.length !== Object.keys(prev.peers).length) {
      peersChanged = true;
    } else {
      for (const id of ids) {
        const before = prev.peers[id];
        const now = peers[id];
        if (!before || before.isSpeaking !== now.isSpeaking || Math.abs(before.level - now.level) > PEER_LEVEL_STEP) {
          peersChanged = true;
          break;
        }
      }
    }
    if (!localChanged && !peersChanged) return;
    publish({
      local: localChanged ? local : prev.local,
      peers: peersChanged ? peers : prev.peers
    });
  },

  /** Local mic muted / closed: show it silent right away. */
  resetLocal() {
    if (snapshot.local !== SILENT) publish({ ...snapshot, local: SILENT });
  },

  removePeer(peerId) {
    if (!(peerId in snapshot.peers)) return;
    const peers = { ...snapshot.peers };
    delete peers[peerId];
    publish({ ...snapshot, peers });
  },

  clearPeers() {
    if (Object.keys(snapshot.peers).length) publish({ ...snapshot, peers: {} });
  }
};

/** { local: { isSpeaking, level }, peers: { [peerId]: { isSpeaking, level } } } */
export function useSpeakingActivity() {
  return useSyncExternalStore(speakingActivity.subscribe, speakingActivity.get);
}

/**
 * The room's peers and local user with live `isSpeaking` / `audioLevel` filled in.
 * Use in the components that draw speaking rings or level meters.
 */
export function useLiveVoiceUsers(connectedPeers, localUser) {
  const activity = useSpeakingActivity();
  return useMemo(() => ({
    peers: (connectedPeers || []).map((peer) => {
      const act = activity.peers[peer.peerId || peer.id] || SILENT;
      return { ...peer, isSpeaking: act.isSpeaking, audioLevel: act.level };
    }),
    localUser: localUser
      ? { ...localUser, isSpeaking: activity.local.isSpeaking, audioLevel: activity.local.level }
      : null
  }), [activity, connectedPeers, localUser]);
}
