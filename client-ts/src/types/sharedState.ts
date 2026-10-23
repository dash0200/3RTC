/**
 * Shared state types for synchronized multi-peer activities and games.
 * Direct reference: core/sharedState.js
 */

export interface ActionMeta {
  /** The peer ID the action originated from (authoritative, verified from channel) */
  by: string;
  /** Whether the sender is the room host */
  isHost: boolean;
  /** The authority peer's own ID */
  selfId: string;
  /** Current host peer ID or null if host is away */
  hostId: string | null;
  /** List of connected peer IDs who participate in this store */
  present: string[];
  /** Room settings (e.g. playbackLock) */
  settings: {
    playbackLock?: boolean;
    [key: string]: unknown;
  };
  /** Lookup stable client ID for peer */
  clientOf: (peerId: string) => string | null;
}

export type Reducer<S, A> = (state: S, action: A, meta: ActionMeta) => S;

export interface SharedStoreOptions<S, A> {
  initial: S;
  reducer: Reducer<S, A>;
  /**
   * Hide parts of the state from some peers (cards in other players' hands): every copy of the
   * state sent to `peerId` is `redact(state, peerId)`. Optional; without it everyone gets it all.
   */
  redact?: (state: S, peerId: string) => S;
}

export interface PresenceInfo {
  authorityId: string | null;
  members: string[];
}

export interface SharedStore<S, A> {
  getState: () => S;
  getVersion: () => number;
  dispatch: (action: A) => void;
  subscribe: (listener: () => void) => () => void;
  getPresence: () => PresenceInfo;
  subscribePresence: (listener: () => void) => () => void;
  release: () => void;
}
