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

import type { BusEventName, RoomBus, SelfInfo } from '../types';

export type SendableChannel =
  | RTCDataChannel
  | {
      readyState?: string;
      send: {
        (data: string): void;
        (data: Blob): void;
        (data: ArrayBuffer): void;
        (data: ArrayBufferView<ArrayBuffer>): void;
      };
      bufferedAmount?: number;
    };

export interface PeerChannelEntry {
  dataChannel?: SendableChannel | null;
  bulkChannel?: SendableChannel | null;
  [key: string]: unknown;
}

export interface CreateRoomBusOptions {
  /** Live map of peerId -> peer entry ({ dataChannel, bulkChannel, ... }) */
  getPeers: () => Map<string, PeerChannelEntry>;
  /** Function returning own peer identity */
  getSelf: () => SelfInfo;
  /** Optional error boundary for unhandled listener errors */
  onHandlerError?: (error: unknown, context: string) => void;
}

export type MessageHandler<T = unknown> = (payload: T, fromPeerId: string) => void;
export type AnyMessageHandler = (payload: unknown, fromPeerId: string) => void;
export type BinaryHandler = (buffer: ArrayBuffer, fromPeerId: string) => boolean | void;
export type EventHandler<T = unknown> = (value: T) => void;
export type AnyEventHandler = (value: unknown) => void;

const isOpen = (channel: SendableChannel | null | undefined): boolean =>
  channel?.readyState === 'open';

export function createRoomBus({
  getPeers,
  getSelf,
  onHandlerError = () => {}
}: CreateRoomBusOptions): RoomBus & {
  channelOf: (peerId: string, opts?: { bulk?: boolean }) => SendableChannel | null;
  hasHandler: (type: string) => boolean;
} {
  const handlers = new Map<string, Set<AnyMessageHandler>>(); // type -> Set<handler>
  const binaryHandlers = new Set<BinaryHandler>(); // (arrayBuffer, fromPeerId) => boolean
  const eventHandlers = new Map<string, Set<AnyEventHandler>>(); // event name -> Set<handler>

  const channelOf = (
    peerId: string,
    { bulk = false }: { bulk?: boolean } = {}
  ): SendableChannel | null => {
    const entry = getPeers().get(peerId);
    if (!entry) return null;
    if (bulk && isOpen(entry.bulkChannel)) return entry.bulkChannel ?? null;
    return isOpen(entry.dataChannel) ? (entry.dataChannel ?? null) : null;
  };

  const stamp = (type: string, payload: Record<string, unknown> = {}) => {
    const self = getSelf();
    return { sender: self.username, timestamp: Date.now(), ...payload, type };
  };

  const sendRaw = (channel: SendableChannel, text: string): boolean => {
    try {
      channel.send(text);
      return true;
    } catch {
      return false;
    }
  };

  const bus = {
    /** Peer ids with an open main channel. */
    connectedPeerIds(): string[] {
      const ids: string[] = [];
      for (const [id, entry] of getPeers()) {
        if (isOpen(entry.dataChannel)) ids.push(id);
      }
      return ids;
    },

    /** The open channel to a peer (bulk channel when asked and open, else the main one). */
    channelOf,

    /** Send `{ type, ...payload }` to one peer. Returns true if it went out. */
    send(
      peerId: string,
      type: string,
      payload: Record<string, unknown> = {},
      { bulk = false }: { bulk?: boolean } = {}
    ): boolean {
      const channel = channelOf(peerId, { bulk });
      return channel ? sendRaw(channel, JSON.stringify(stamp(type, payload))) : false;
    },

    /** Send binary data to one peer's bulk channel (or main channel if open). */
    sendBinary(peerId: string, buffer: ArrayBufferView<ArrayBuffer> | ArrayBuffer): boolean {
      const channel = channelOf(peerId, { bulk: true });
      if (!channel) return false;
      try {
        if (ArrayBuffer.isView(buffer)) {
          channel.send(buffer);
        } else {
          channel.send(buffer);
        }
        return true;
      } catch {
        return false;
      }
    },

    /** Broadcast binary data to all peers with an open bulk channel. */
    broadcastBinary(buffer: ArrayBufferView<ArrayBuffer> | ArrayBuffer): number {
      let sent = 0;
      for (const peerId of getPeers().keys()) {
        const channel = channelOf(peerId, { bulk: true });
        if (channel) {
          try {
            if (ArrayBuffer.isView(buffer)) {
              channel.send(buffer);
            } else {
              channel.send(buffer);
            }
            sent += 1;
          } catch {
            // ignore failure on single peer
          }
        }
      }
      return sent;
    },

    /** Send `{ type, ...payload }` to everyone connected. Returns how many peers got it. */
    broadcast(
      type: string,
      payload: Record<string, unknown> = {},
      { bulk = false, except = null }: { bulk?: boolean; except?: string | null } = {}
    ): number {
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
    on<T = unknown>(type: string, handler: (payload: T, fromPeerId: string) => void): () => void {
      if (!handlers.has(type)) handlers.set(type, new Set());
      const genericHandler = handler as unknown as AnyMessageHandler;
      handlers.get(type)!.add(genericHandler);
      return () => {
        handlers.get(type)?.delete(genericHandler);
      };
    },

    /** Receive binary frames; return true from the handler when the frame was yours. */
    onBinary(handler: (buffer: ArrayBuffer, fromPeerId: string) => boolean | void): () => void {
      binaryHandlers.add(handler);
      return () => {
        binaryHandlers.delete(handler);
      };
    },

    /** Local app events (see the list at the top). Returns an unsubscribe function. */
    onEvent<T = unknown>(event: BusEventName, handler: (value: T) => void): () => void {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      const genericHandler = handler as unknown as AnyEventHandler;
      eventHandlers.get(event)!.add(genericHandler);
      return () => {
        eventHandlers.get(event)?.delete(genericHandler);
      };
    },

    emitEvent<T = unknown>(event: BusEventName, value?: T): void {
      for (const handler of [...(eventHandlers.get(event) || [])]) {
        try {
          handler(value);
        } catch (error) {
          onHandlerError(error, event);
        }
      }
    },

    hasHandler(type: string): boolean {
      return Boolean(handlers.get(type)?.size);
    },

    // ---- called by the connection layer --------------------------------------------------

    /** Deliver a parsed message from `fromPeerId` to its handlers. Returns true if any ran. */
    dispatch(message: Record<string, unknown>, fromPeerId: string): boolean {
      const type = message?.type;
      if (typeof type !== 'string') return false;
      const set = handlers.get(type);
      if (!set?.size) return false;
      for (const handler of [...set]) {
        try {
          handler(message, fromPeerId);
        } catch (error) {
          onHandlerError(error, type);
        }
      }
      return true;
    },

    dispatchBinary(arrayBuffer: ArrayBuffer, fromPeerId: string): boolean {
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
