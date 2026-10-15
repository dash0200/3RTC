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
 *
 * Wire messages (all on the main channel):
 *   { type: 'room-state', key, v, state }        full state
 *   { type: 'room-state-action', key, action }   to the authority
 *   { type: 'room-state-request', key }          "send me your state if you have one"
 *
 * The reducer must be deterministic and must not mutate its input. State must be plain JSON.
 */

const stores = new WeakMap(); // bus -> Map<key, store>

export function createSharedStore(bus, room, key, { initial, reducer }) {
    let state = initial;
    let version = 0;
    const listeners = new Set();
    const notify = () => {
        for (const listener of [...listeners]) listener();
    };

    const isAuthority = () => room.getAuthorityId() === room.getSelfId();

    const set = (nextState, nextVersion) => {
        state = nextState;
        version = nextVersion;
        notify();
    };

    const apply = (action, by) => {
        let next;
        try {
            const selfId = room.getSelfId();
            next = reducer(state, action, {
                by,
                isHost: room.isPeerHost(by),
                selfId,
                hostId: room.getSelf().isHost ? selfId : room.getHostPeerId(),
                present: [selfId, ...bus.connectedPeerIds()],
                clientOf: (id) => room.clientIdOf?.(id) || null,
                settings: room.getRoomSettings()
            });
        } catch {
            return; // a broken action never breaks the room
        }
        if (next === undefined || next === state) return;
        set(next, version + 1);
        bus.broadcast('room-state', { key, v: version, state });
    };

    const offs = [
        bus.on('room-state', (msg) => {
            if (msg.key !== key || typeof msg.v !== 'number' || msg.v <= version) return;
            set(msg.state, msg.v);
        }),
        bus.on('room-state-action', (msg, fromPeerId) => {
            if (msg.key !== key || !isAuthority()) return;
            apply(msg.action, fromPeerId);
        }),
        bus.on('room-state-request', (msg, fromPeerId) => {
            if (msg.key !== key || version === 0) return;
            bus.send(fromPeerId, 'room-state', { key, v: version, state });
        }),
        // Everyone who has a state sends it to a peer whose channel opens, not only the authority:
        // a host coming back (after leaving or reloading) is the authority again at once but has
        // nothing, so it must get the room's state from the others. The highest version wins.
        bus.onEvent('peer-open', (peerId) => {
            if (version > 0) bus.send(peerId, 'room-state', { key, v: version, state });
        }),
        bus.onEvent('room-left', () => set(initial, 0))
    ];

    // A store created after people are already here (lazy feature): ask for what they have
    bus.broadcast('room-state-request', { key });

    return {
        key,
        getState: () => state,
        getVersion: () => version,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispatch(action) {
            if (isAuthority()) {
                apply(action, room.getSelfId());
            } else {
                const authority = room.getAuthorityId();
                if (authority) bus.send(authority, 'room-state-action', { key, action });
            }
        },
        /** Back to the initial value locally (leaving the room). */
        reset() {
            set(initial, 0);
        },
        destroy() {
            for (const off of offs) off();
            listeners.clear();
        }
    };
}

/** One store per (bus, key) for the life of the app (it resets itself when we leave a room). */
export function getSharedStore(bus, room, key, options) {
    if (!stores.has(bus)) stores.set(bus, new Map());
    const map = stores.get(bus);
    if (!map.has(key)) map.set(key, createSharedStore(bus, room, key, options));
    return map.get(key);
}

/**
 * Who decides: the host if they're here, else the smallest peer id among us and our connected
 * peers. `peers` is [{ peerId, isHost }] for connected peers.
 */
export function pickAuthority(selfId, selfIsHost, peers) {
    if (selfIsHost) return selfId;
    const host = peers.find((p) => p.isHost);
    if (host) return host.peerId;
    return [selfId, ...peers.map((p) => p.peerId)].sort()[0] || null;
}
