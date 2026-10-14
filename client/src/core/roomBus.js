/**
 * Room bus: the one way features talk to the other people in the room.
 *
 * Every peer connection has a main data channel (small JSON messages: chat, sync, games) and a
 * bulk channel (files, video). Features never touch those channels directly; they use the bus:
 *
 *   bus.broadcast('reaction', { emoji })          // to everyone connected
 *   bus.send(peerId, 'yt-sync-state', { ... })    // to one peer
 *   const off = bus.on('reaction', (msg, fromPeerId) => { ... })   // receive; off() to stop
 *   bus.onEvent('peer-open', (peerId) => { ... }) // someone's channel opened (send them state)
 *
 * Events (local to this app, not sent anywhere):
 *   'peer-open'  (peerId)  a peer's main channel opened
 *   'peer-close' (peerId)  a peer is gone (left, or the connection was dropped)
 *   'channel-close' (peerId) a peer's main channel closed (it may still recover)
 *   'room-left'  ()        we left the room: features reset their state
 *   'media-changed' ()     the video everyone watches changed or closed
 * Any feature may emit its own events the same way (bus.emitEvent('name', value)).
 *
 * Messages stay plain JSON objects `{ type, ...fields }`; the bus adds `sender` (display name) and
 * `timestamp` when the caller didn't, so the wire format matches older app versions in the same
 * room. Types the receiving app doesn't know are ignored, which is what lets new features ship
 * without breaking people who haven't updated yet (see docs/PROTOCOL.md).
 *
 * This file has no React and no WebRTC objects of its own, so it can be unit tested.
 */

const isOpen = (channel) => channel?.readyState === 'open';

/**
 * @param {object} opts
 * @param {() => Map<string, object>} opts.getPeers  live map peerId -> peer entry ({ dataChannel, bulkChannel, ... })
 * @param {() => { peerId: string, username: string, isHost: boolean }} opts.getSelf
 * @param {(error: unknown, type: string) => void} [opts.onHandlerError]
 */
export function createRoomBus({ getPeers, getSelf, onHandlerError = () => { } }) {
    const handlers = new Map();      // type -> Set<handler>
    const binaryHandlers = new Set(); // (arrayBuffer, fromPeerId) => boolean (true = handled)
    const eventHandlers = new Map(); // event name -> Set<handler>

    const channelOf = (peerId, { bulk = false } = {}) => {
        const entry = getPeers().get(peerId);
        if (!entry) return null;
        if (bulk && isOpen(entry.bulkChannel)) return entry.bulkChannel;
        return isOpen(entry.dataChannel) ? entry.dataChannel : null;
    };

    const stamp = (type, payload) => {
        const self = getSelf();
        return { sender: self.username, timestamp: Date.now(), ...payload, type };
    };

    const sendRaw = (channel, text) => {
        try {
            channel.send(text);
            return true;
        } catch {
            return false;
        }
    };

    const bus = {
        /** Peer ids with an open main channel. */
        connectedPeerIds() {
            const ids = [];
            for (const [id, entry] of getPeers()) {
                if (isOpen(entry.dataChannel)) ids.push(id);
            }
            return ids;
        },

        /** The open channel to a peer (bulk channel when asked and open, else the main one). */
        channelOf,

        /** Send `{ type, ...payload }` to one peer. Returns true if it went out. */
        send(peerId, type, payload = {}, { bulk = false } = {}) {
            const channel = channelOf(peerId, { bulk });
            return channel ? sendRaw(channel, JSON.stringify(stamp(type, payload))) : false;
        },

        /** Send `{ type, ...payload }` to everyone connected. Returns how many peers got it. */
        broadcast(type, payload = {}, { bulk = false, except = null } = {}) {
            const text = JSON.stringify(stamp(type, payload));
            let sent = 0;
            for (const peerId of getPeers().keys()) {
                if (peerId === except) continue;
                const channel = channelOf(peerId, { bulk });
                if (channel && sendRaw(channel, text)) sent += 1;
            }
            return sent;
        },

        /** Receive messages of `type`. Returns an unsubscribe function. */
        on(type, handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
            return () => handlers.get(type)?.delete(handler);
        },

        /** Receive binary frames; return true from the handler when the frame was yours. */
        onBinary(handler) {
            binaryHandlers.add(handler);
            return () => binaryHandlers.delete(handler);
        },

        /** Local app events (see the list at the top). Returns an unsubscribe function. */
        onEvent(event, handler) {
            if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
            eventHandlers.get(event).add(handler);
            return () => eventHandlers.get(event)?.delete(handler);
        },

        emitEvent(event, value) {
            for (const handler of [...(eventHandlers.get(event) || [])]) {
                try {
                    handler(value);
                } catch (error) {
                    onHandlerError(error, event);
                }
            }
        },

        hasHandler(type) {
            return Boolean(handlers.get(type)?.size);
        },

        // ---- called by the connection layer --------------------------------------------------

        /** Deliver a parsed message from `fromPeerId` to its handlers. Returns true if any ran. */
        dispatch(message, fromPeerId) {
            const set = handlers.get(message?.type);
            if (!set?.size) return false;
            for (const handler of [...set]) {
                try {
                    handler(message, fromPeerId);
                } catch (error) {
                    onHandlerError(error, message.type);
                }
            }
            return true;
        },

        dispatchBinary(arrayBuffer, fromPeerId) {
            for (const handler of [...binaryHandlers]) {
                try {
                    if (handler(arrayBuffer, fromPeerId)) return true;
                } catch (error) {
                    onHandlerError(error, 'binary');
                }
            }
            return false;
        }
    };
    return bus;
}
