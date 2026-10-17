/**
 * Chat: text messages, P2P images (sent over each peer's bulk channel) and the unread count.
 *
 * Wire messages: 'chat' { id, sender, isHost, text }, 'p2p-image-start' { ... } followed by
 * binary 'IMG1' frames (utils/p2pImageShare.js).
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { sound } from '../../utils/sound';
import { P2PImageSender, p2pImageReceiver } from '../../utils/p2pImageShare';
import { usePeerMessageOn } from '../../core/RoomContext';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_MESSAGES = 300; // older ones are dropped (and their image memory freed)
const MAX_CHAT_TEXT = 2000; // (the box allows 200; more from a peer is cut)

// Append and keep the list bounded
const appendCapped = (prev, item) => {
    const next = prev.concat([item]);
    if (next.length <= MAX_MESSAGES) return next;
    const dropped = next.splice(0, next.length - MAX_MESSAGES);
    for (const m of dropped) {
        if (m.image?.url?.startsWith('blob:')) {
            try { URL.revokeObjectURL(m.image.url); } catch { /* already gone */ }
        }
    }
    return next;
};
const IMAGE_MAGIC = 0x494D4731; // 'IMG1'

const setTransferPercent = (transferId, percent) => (prev) => prev.map((m) =>
    m.transferId === transferId && m.imageTransfer ? { ...m, imageTransfer: { ...m.imageTransfer, percent } } : m);

export function useChat({ room, isChatOpen }) {
    const { bus } = room;
    const [messages, setMessages] = useState([]);
    const [unreadChatCount, setUnreadChatCount] = useState(0);
    const prevLengthRef = useRef(0);

    useEffect(() => {
        if (isChatOpen) {
            setUnreadChatCount(0);
        } else {
            const diff = messages.length - prevLengthRef.current;
            if (diff > 0) setUnreadChatCount((prev) => prev + diff);
        }
        prevLengthRef.current = messages.length;
    }, [messages.length, isChatOpen]);

    // Clear messages, revoke blob URLs, and reset unread counts when leaving a room
    useEffect(() => bus.onEvent('room-left', () => {
        setMessages((prev) => {
            for (const m of prev) {
                if (m.image?.url?.startsWith('blob:')) {
                    try { URL.revokeObjectURL(m.image.url); } catch { /* already gone */ }
                }
            }
            return [];
        });
        setUnreadChatCount(0);
        prevLengthRef.current = 0;
        lastReactionRef.current.clear();
        p2pImageReceiver.reset();
    }), [bus]);

    // Periodically clean up stale/abandoned image transfers (L-03)
    useEffect(() => {
        const timer = setInterval(() => {
            p2pImageReceiver.cleanStale(120000);
        }, 60000);
        return () => clearInterval(timer);
    }, []);

    // Older apps also post every reaction-button tap as a chat message (the reaction first, then
    // the same emoji as text): skip those so the chat isn't flooded while people update
    const lastReactionRef = useRef(new Map()); // peerId -> { emoji, at }
    usePeerMessageOn(bus, 'reaction', (data, from) => {
        if (typeof data?.emoji === 'string') lastReactionRef.current.set(from, { emoji: data.emoji, at: Date.now() });
    });

    usePeerMessageOn(bus, 'chat', (data, from) => {
        const reaction = lastReactionRef.current.get(from);
        if (reaction && typeof data.text === 'string' && data.text.trim() === reaction.emoji && Date.now() - reaction.at < 2500) return;
        // Only what a chat message has; who sent it comes from the connection, not the message
        if (typeof data.text !== 'string' || !data.text.trim()) return;
        setMessages((prev) => appendCapped(prev, {
            type: 'chat',
            id: typeof data.id === 'string' ? data.id.slice(0, 64) : crypto.randomUUID(),
            sender: room.peerName(from) || data.sender || 'Peer',
            isHost: room.isPeerHost(from),
            text: data.text.slice(0, MAX_CHAT_TEXT),
            timestamp: Number.isFinite(data.timestamp) ? Math.min(data.timestamp, Date.now() + 60000) : Date.now(),
            isSelf: false
        }));
        sound.playPop();
    });

    usePeerMessageOn(bus, 'p2p-image-start', (data, from) => {
        if (typeof data.transferId !== 'string' || data.transferId.length > 64) return;
        p2pImageReceiver.handleStart(data);
        const fileName = typeof data.fileName === 'string' ? data.fileName.slice(0, 120) : 'image';
        const fileSize = Number.isFinite(data.fileSize) ? data.fileSize : 0;
        setMessages((prev) => appendCapped(prev, {
            type: 'chat',
            id: typeof data.id === 'string' ? data.id.slice(0, 64) : crypto.randomUUID(),
            transferId: data.transferId,
            sender: room.peerName(from) || data.sender || 'Peer',
            isHost: room.isPeerHost(from),
            text: typeof data.caption === 'string' ? data.caption.slice(0, MAX_CHAT_TEXT) : '',
            imageTransfer: { transferId: data.transferId, isTransferring: true, percent: 0, fileName, fileSize },
            isSelf: false,
            timestamp: Number.isFinite(data.timestamp) ? Math.min(data.timestamp, Date.now() + 60000) : Date.now()
        }));
        sound.playChime();
    });

    useEffect(() => bus.onBinary((arrayBuffer) => {
        if (arrayBuffer.byteLength < 4 || new DataView(arrayBuffer).getUint32(0, false) !== IMAGE_MAGIC) return false;
        p2pImageReceiver.handleChunk(arrayBuffer, {
            onProgress: (transferId, percent) => setMessages(setTransferPercent(transferId, percent)),
            onComplete: (transferId, result) => {
                setMessages((prev) => prev.map((m) => (m.transferId === transferId ? {
                    ...m,
                    imageTransfer: null,
                    image: { url: result.objectUrl, name: result.fileName, size: result.fileSize, mimeType: result.mimeType, blob: result.blob }
                } : m)));
                sound.playPop();
            }
        });
        return true;
    }), [bus]);

    const sendMessage = useCallback((text) => {
        const { username, isHost } = room.getSelf();
        const msg = { type: 'chat', id: crypto.randomUUID(), sender: username, isHost, text, timestamp: Date.now() };
        if (bus.broadcast('chat', msg) > 0) {
            setMessages((prev) => appendCapped(prev, { ...msg, isSelf: true }));
            sound.playPop();
        } else {
            room.notify('Waiting for peer to connect before sending');
        }
    }, [bus, room]);

    const sendImage = useCallback((file, caption = '') => {
        if (!file) return;
        if (file.size > MAX_IMAGE_BYTES) {
            room.notify('Image exceeds 15 MB limit. Please select a smaller file.');
            return;
        }
        // Images go over each peer's bulk channel so chat and sync never wait behind them
        const channels = bus.connectedPeerIds().map((id) => bus.channelOf(id, { bulk: true })).filter(Boolean);
        if (channels.length === 0) {
            room.notify('Waiting for peer to connect before sending image');
            return;
        }
        const { username, isHost } = room.getSelf();
        const messageId = crypto.randomUUID();
        const transferId = crypto.randomUUID();
        const fileName = file.name || 'screenshot.png';
        setMessages((prev) => appendCapped(prev, {
            type: 'chat',
            id: messageId,
            transferId,
            sender: username,
            isHost,
            text: caption,
            image: { url: URL.createObjectURL(file), name: fileName, size: file.size, mimeType: file.type || 'image/png', blob: file },
            imageTransfer: { transferId, isTransferring: true, percent: 0, fileName, fileSize: file.size },
            isSelf: true,
            timestamp: Date.now()
        }));
        sound.playPop();

        new P2PImageSender(file, () => channels, {
            id: messageId,
            transferId,
            sender: username,
            isHost,
            caption,
            onProgress: ({ percent }) => setMessages(setTransferPercent(transferId, percent)),
            onComplete: () => setMessages((prev) => prev.map((m) => (m.transferId === transferId ? { ...m, imageTransfer: null } : m))),
            onError: (err) => {
                room.log(`❌ Image transfer failed: ${err.message}`);
                room.notify(`Image send failed: ${err.message}`);
            }
        }).start();
    }, [bus, room]);

    return { messages, unreadChatCount, sendMessage, sendImage };
}
