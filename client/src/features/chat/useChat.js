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

    usePeerMessageOn(bus, 'chat', (data) => {
        setMessages((prev) => [...prev, { ...data, isSelf: false }]);
        sound.playPop();
    });

    usePeerMessageOn(bus, 'p2p-image-start', (data) => {
        p2pImageReceiver.handleStart(data);
        setMessages((prev) => [...prev, {
            type: 'chat',
            id: data.id,
            transferId: data.transferId,
            sender: data.sender,
            isHost: data.isHost,
            text: data.caption || '',
            imageTransfer: { transferId: data.transferId, isTransferring: true, percent: 0, fileName: data.fileName, fileSize: data.fileSize },
            isSelf: false,
            timestamp: data.timestamp || Date.now()
        }]);
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
            setMessages((prev) => [...prev, { ...msg, isSelf: true }]);
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
        setMessages((prev) => [...prev, {
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
        }]);
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
