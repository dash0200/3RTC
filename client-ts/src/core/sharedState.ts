/**
 * Shared room state: one value that every person in the room sees the same, changed only through
 * actions that one peer (the "authority") checks and applies. Games, polls, scoreboards and the
 * current activity are all built on it, so none of them has to solve syncing again.
 *
 *   const store = getSharedStore(bus, room, 'chess', { initial, reducer });
 *   store.dispatch({ kind: 'move', from: 'e2', to: 'e4' });
 *   store.subscribe(() => render(store.getState()));
 *
 * How it works
 * - The authority is the host when present, otherwise the connected peer with the smallest id, so
 *   every app picks the same one without talking about it (room.getAuthorityId()).
 * - Anyone's dispatch goes to the authority. The authority runs `reducer(state, action, meta)`;
 *   if the result is a new object, it bumps the version and broadcasts the whole state. Returning
 *   the same state rejects the action (illegal move, not your turn...). `meta.by` is the peer the
 *   action really came from (taken from the connection, not from the message), so a player can't
 *   act for someone else. meta also has `isHost` (of that peer), `selfId` (the authority itself,
 *   so `meta.by === meta.selfId` means the authority sent it), `hostId` (null if the host is
 *   away), `present` (ids of everyone connected, the authority included) and `settings` (room
 *   settings such as { playbackLock }), all as the authority sees them.
 * - Versions only go up; a peer keeps the highest version it has seen.
 * - Late joiners: a new store asks the room for its state, and everyone with a state sends it to
 *   every peer whose channel opens (so a host who comes back gets the game it left). A reset is
 *   just another action, so it also syncs.
 * - meta.clientOf(peerId): the app's stable id (same after a reload or a rejoin, unlike the peer
 *   id), so a game can give a returning player their seat back.
 * - Leaving the room ('room-left' event) puts the store back to `initial`, version 0.
 * - Who has it: not everyone has every store (someone can skip a game or leave it: the store is
 *   released, see releaseSharedStores). Everyone connected counts as having it unless they said
 *   they don't ('room-state-gone': when a store is released, when someone without it connects,
 *   and in answer to a message for a store they don't have, see answerForMissingStores). The
 *   authority and meta.present are chosen among the people who have it ("members"); any message
 *   for the store from a peer counts them in again. Apps from before this never say "gone", so
 *   they always count (they load every game). getPresence() / subscribePresence() give
 *   { authorityId, members } for the UI (useSharedPresence).
 *
 * Wire messages (all on the main channel):
 *   { type: 'room-state', key, v, state }        full state
 *   { type: 'room-state-action', key, action }   to the authority
 *   { type: 'room-state-request', key }          "send me your state if you have one"
 *   { type: 'room-state-gone', key }             "I don't have this store"
 *
 * The reducer must be deterministic and must not mutate its input. State must be plain JSON.
 */

import type {
  PresenceInfo,
  Room,
  RoomBus,
  RoomStateActionMessage,
  RoomStateGoneMessage,
  RoomStateMessage,
  RoomStateRequestMessage,
  SharedStore,
  SharedStoreOptions
} from '../types';

export interface StoreLifecycle {
  key: string;
  reset: () => void;
  destroy: () => void;
  release: () => void;
}

export interface SharedStoreInstance<S, A> extends SharedStore<S, A>, StoreLifecycle {}

const stores = new WeakMap<RoomBus, Map<string, StoreLifecycle>>(); // bus -> Map<key, store>
const live = new WeakMap<RoomBus, Map<string, number>>(); // bus -> Map<key, number of live stores>

const countLive = (bus: RoomBus, key: string, delta: number) => {
  if (!live.has(bus)) live.set(bus, new Map());
  const map = live.get(bus)!;
  const n = (map.get(key) || 0) + delta;
  if (n > 0) map.set(key, n);
  else map.delete(key);
};

export function createSharedStore<S, A>(
  bus: RoomBus,
  room: Room,
  key: string,
  { initial, reducer }: SharedStoreOptions<S, A>
): SharedStoreInstance<S, A> {
  let state = initial;
  let version = 0;
  let initialCatchUp = true;
  countLive(bus, key, 1);

  const catchUpTimer = setTimeout(() => {
    initialCatchUp = false;
  }, 3000);
  (catchUpTimer as unknown as { unref?: () => void })?.unref?.();

  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  // ---- who has this store (members), and so who decides for it ----
  const absent = new Set<string>(); // peers that told us they don't have it
  const presenceListeners = new Set<() => void>();
  let presence: PresenceInfo = { authorityId: null, members: [] };

  const memberPeers = () => bus.connectedPeerIds().filter((id) => !absent.has(id));

  const authorityId = (): string | null => {
    const selfId = room.getSelfId();
    return pickAuthority(
      selfId,
      room.getSelf().isHost,
      memberPeers().map((peerId) => ({ peerId, isHost: room.isPeerHost(peerId) }))
    );
  };

  const refreshPresence = () => {
    const selfId = room.getSelfId();
    const members = (selfId ? [selfId, ...memberPeers()] : [...memberPeers()]).sort();
    const next: PresenceInfo = { authorityId: authorityId(), members };
    if (
      next.authorityId === presence.authorityId &&
      next.members.join() === presence.members.join()
    ) {
      return;
    }
    presence = next;
    for (const listener of [...presenceListeners]) listener();
  };

  const addMember = (id: string | null | undefined) => {
    if (!id || !absent.delete(id)) return;
    refreshPresence();
  };

  const isAuthority = () => authorityId() === room.getSelfId();

  const set = (nextState: S, nextVersion: number) => {
    state = nextState;
    version = nextVersion;
    notify();
  };

  const apply = (action: A, by: string) => {
    let next: S;
    try {
      const selfId = room.getSelfId() || '';
      next = reducer(state, action, {
        by,
        isHost: room.isPeerHost(by),
        selfId,
        hostId: room.getSelf().isHost ? selfId : room.getHostPeerId(),
        present: [selfId, ...memberPeers()],
        clientOf: (id: string) => room.clientIdOf?.(id) || null,
        settings: room.getRoomSettings()
      });
    } catch {
      return; // a broken action never breaks the room
    }
    if (next === undefined || next === state) return;
    initialCatchUp = false;
    clearTimeout(catchUpTimer);
    set(next, version + 1);
    bus.broadcast('room-state', { key, v: version, state });
  };

  const offs = [
    bus.on<RoomStateMessage<S>>('room-state', (msg, fromPeerId) => {
      if (msg.key !== key) return;
      addMember(fromPeerId);
      if (typeof msg.v !== 'number' || msg.v <= version) return;

      const currentAuthority = authorityId();
      const amAuthority = currentAuthority === room.getSelfId();

      if (!amAuthority) {
        // Non-authority peers only accept states broadcast by the recognized authority
        if (fromPeerId !== currentAuthority) return;
      } else {
        // The authority only adopts state during initial catch-up when version is 0
        if (!initialCatchUp || version > 0) return;
      }

      set(msg.state, msg.v);
    }),

    bus.on<RoomStateActionMessage<A>>('room-state-action', (msg, fromPeerId) => {
      if (msg.key !== key) return;
      addMember(fromPeerId);
      if (!isAuthority()) return;
      apply(msg.action, fromPeerId);
    }),

    bus.on<RoomStateRequestMessage>('room-state-request', (msg, fromPeerId) => {
      if (msg.key !== key) return;
      addMember(fromPeerId);
      if (version === 0) return;
      bus.send(fromPeerId, 'room-state', { key, v: version, state });
    }),

    bus.on<RoomStateGoneMessage>('room-state-gone', (msg, fromPeerId) => {
      if (msg.key !== key || absent.has(fromPeerId)) return;
      absent.add(fromPeerId);
      refreshPresence();
    }),

    // Everyone who has a state sends it to a peer whose channel opens, not only the authority
    bus.onEvent<string>('peer-open', (peerId) => {
      if (version > 0) bus.send(peerId, 'room-state', { key, v: version, state });
      refreshPresence();
    }),

    bus.onEvent('channel-close', () => refreshPresence()),
    bus.onEvent('peer-close', () => refreshPresence()),

    bus.onEvent('room-left', () => {
      absent.clear();
      refreshPresence();
      initialCatchUp = true;
      set(initial, 0);
    })
  ];

  // A store created after people are already here: ask for what they have
  bus.broadcast('room-state-request', { key });
  refreshPresence();

  return {
    key,
    getState: () => state,
    getVersion: () => version,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action: A) {
      if (isAuthority()) {
        apply(action, room.getSelfId() || '');
      } else {
        const authority = authorityId();
        if (authority) bus.send(authority, 'room-state-action', { key, action });
      }
    },
    /** { authorityId, members }: who decides, and who has this store (sorted peer ids). */
    getPresence: () => presence,
    subscribePresence(listener: () => void) {
      presenceListeners.add(listener);
      return () => {
        presenceListeners.delete(listener);
      };
    },
    /** Back to the initial value locally (leaving the room). */
    reset() {
      initialCatchUp = true;
      set(initial, 0);
    },
    destroy() {
      clearTimeout(catchUpTimer);
      countLive(bus, key, -1);
      bus.broadcast('room-state-gone', { key });
      for (const off of offs) off();
      listeners.clear();
      presenceListeners.clear();
    },
    release() {
      this.destroy();
    }
  };
}

/** One store per (bus, key) for the life of the app (it resets itself when we leave a room). */
export function getSharedStore<S, A>(
  bus: RoomBus,
  room: Room,
  key: string,
  options: SharedStoreOptions<S, A>
): SharedStoreInstance<S, A> {
  if (!stores.has(bus)) stores.set(bus, new Map());
  const map = stores.get(bus)!;
  if (!map.has(key)) {
    map.set(key, createSharedStore<S, A>(bus, room, key, options));
  }
  return map.get(key) as unknown as SharedStoreInstance<S, A>;
}

/**
 * Drop stores we don't need any more (someone left a game): tells the others we don't have them,
 * so they stop counting us, and frees the state. Using the key again makes a fresh store that gets
 * the room's current state. `match(key)` picks the stores.
 */
export function releaseSharedStores(bus: RoomBus, match: (key: string) => boolean): void {
  const map = stores.get(bus);
  if (!map) return;
  for (const [key, store] of [...map]) {
    if (!match(key)) continue;
    store.destroy();
    map.delete(key);
  }
}

export const hasSharedStore = (bus: RoomBus, key: string): boolean =>
  Boolean(live.get(bus)?.get(key));

/**
 * For stores this app doesn't have (a game it skipped or left) whose keys match `match(key)`:
 * answer requests and actions for them with "gone", so the others stop counting us (and stop
 * sending us their moves). Returns a function to stop.
 */
export function answerForMissingStores(
  bus: RoomBus,
  match: (key: string) => boolean
): () => void {
  const answer = (msg: { key?: unknown }, fromPeerId: string) => {
    const key = msg?.key;
    if (typeof key !== 'string' || !match(key) || hasSharedStore(bus, key)) return;
    bus.send(fromPeerId, 'room-state-gone', { key });
  };
  const offs = [
    bus.on('room-state-request', answer),
    bus.on('room-state-action', answer),
    bus.on('room-state', answer)
  ];
  return () => offs.forEach((off) => off());
}

/**
 * Who decides: the host if they're here, else the smallest peer id among us and our connected
 * peers. `peers` is [{ peerId, isHost }] for connected peers.
 */
export function pickAuthority(
  selfId: string | null,
  selfIsHost: boolean,
  peers: Array<{ peerId: string; isHost: boolean }>
): string | null {
  if (selfIsHost) return selfId;
  const host = peers.find((p) => p.isHost);
  if (host) return host.peerId;
  const allIds = selfId ? [selfId, ...peers.map((p) => p.peerId)] : peers.map((p) => p.peerId);
  return allIds.sort()[0] || null;
}
