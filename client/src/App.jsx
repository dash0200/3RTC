import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from './components/Header';
import Stage from './components/Stage';
import LiveChat from './components/LiveChat';
import CreateRoomModal from './components/CreateRoomModal';
import JoinRoomModal from './components/JoinRoomModal';
import ServerSettingsModal from './components/ServerSettingsModal';
import AudioSettingsModal from './components/AudioSettingsModal';
import { fetchYouTubeTitle } from './components/YouTubeSyncPlayer';
import { sound } from './utils/sound';
import { copyToClipboard } from './utils/clipboard';
import { detectOnDemandStreaming } from './utils/p2pStreamer';
import { micPipeline } from './utils/micPipeline';
import { ICE_SERVERS, BULK_CHANNEL_ID, RECOVERY } from './webrtc/config';
import { extractAudioSdp, tuneSdpForDiscordAudio, tuneAudioSender } from './webrtc/sdp';
import { teardownPeerEntry } from './webrtc/peerEntry';
import { attachRemoteAudio } from './webrtc/remoteAudio';
import { attachPeerRecovery } from './webrtc/peerRecovery';
import { createPeerMessageHandler } from './webrtc/peerMessages';
import { useVoiceChat } from './hooks/useVoiceChat';
import { processSignalingMessage } from './webrtc/signalingMessages';
import { useSignalingConnection } from './hooks/useSignalingConnection';
import { matchesPttKey, isTypingInField, isVoiceIsolationSupported } from './utils/audioSettings';
import { soundboard, loadSoundboardSettings, saveSoundboardSettings } from './utils/soundboard';
import { P2PImageSender, p2pImageReceiver } from './utils/p2pImageShare';
import NetworkDiagnosticsModal from './components/NetworkDiagnosticsModal';
import { extractPeerConnectionStats, PING_INTERVAL_MS, MAX_HISTORY_SAMPLES } from './utils/networkMonitor';
import QrCodeModal from './components/QrCodeModal';
import './App.css';

const DEFAULT_SIGNAL_URL = 'wss://34.57.36.145.sslip.io:443';
const IS_LOCAL = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]' ||
    Boolean(import.meta.env?.DEV)
);

export default function App() {
    const [signalUrl, setSignalUrl] = useState(() => {
        if (!IS_LOCAL) return DEFAULT_SIGNAL_URL;
        return localStorage.getItem('webrtc_signal_url') || DEFAULT_SIGNAL_URL;
    });
    const [username, setUsername] = useState(() => localStorage.getItem('webrtc_username') || `User_${Math.floor(100 + Math.random() * 900)}`);

    const [signalStatus, setSignalStatus] = useState({ connected: false, label: 'Connecting...' });
    const [roomId, setRoomId] = useState(null);
    const [isHost, setIsHost] = useState(false);
    const [peerCount, setPeerCount] = useState(0);
    const [isP2PConnected, setIsP2PConnected] = useState(false);
    const [p2pStatusText, setP2pStatusText] = useState('Waiting for peer to enter 5-digit code...');
    const [messages, setMessages] = useState([]);
    const [systemLogs, setSystemLogs] = useState([]);

    // YouTube & Local Media Synchronization State
    const [activeVideoId, setActiveVideoId] = useState(null);
    const [activeVideoTitle, setActiveVideoTitle] = useState('');
    const [localVideoFile, setLocalVideoFile] = useState(null);
    const [remoteLocalVideoMeta, setRemoteLocalVideoMeta] = useState(null);
    const [remoteAction, setRemoteAction] = useState(null);

    // Feature 1.4: WebRTC Direct Video Streaming (MSE Chunk Sharing)
    const [streamProgress, setStreamProgress] = useState(null);
    const [streamVideoUrl, setStreamVideoUrl] = useState(null);
    const streamReceiverRef = useRef(null);
    const getOrCreatePeerConnectionRef = useRef(null);
    // Host: stream number of the file currently offered for on-demand streaming
    const hostStreamRef = useRef({ file: null, streamNo: 0 });
    const activeStreamSendersRef = useRef(new Map());
    const localVideoFileRef = useRef(null);
    localVideoFileRef.current = localVideoFile;

    // Feature 1.1: Shared Video Queue & Collaborative Playlist
    const [queue, setQueue] = useState([]);
    const [skipVotes, setSkipVotes] = useState([]);
    const queueRef = useRef([]);
    queueRef.current = queue;
    const skipVotesRef = useRef([]);
    skipVotesRef.current = skipVotes;
    const activeVideoTitleRef = useRef('');
    activeVideoTitleRef.current = activeVideoTitle;

    // UI Panels & Modals (Mobile default closed so stage is primary)
    const [isChatOpen, setIsChatOpen] = useState(() => {
        if (typeof window !== 'undefined' && window.innerWidth <= 768) {
            return false;
        }
        return true;
    });
    const [sidebarTab, setSidebarTab] = useState('chat');
    // Feature 1.2: Floating Live Reactions Over Video Player
    const [floatingReactions, setFloatingReactions] = useState([]);

    // Track unread messages count when the sidebar is closed
    const [unreadChatCount, setUnreadChatCount] = useState(0);
    const prevMessagesLengthRef = useRef(0);

    useEffect(() => {
        if (isChatOpen) {
            setUnreadChatCount(0);
        } else {
            const diff = messages.length - prevMessagesLengthRef.current;
            if (diff > 0) {
                setUnreadChatCount((prev) => prev + diff);
            }
        }
        prevMessagesLengthRef.current = messages.length;
    }, [messages.length, isChatOpen]);

    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showJoinModal, setShowJoinModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [showQrModal, setShowQrModal] = useState(false);
    const [initialJoinPin, setInitialJoinPin] = useState('');
    const [toastMessage, setToastMessage] = useState('');

    const [peerMetadata, setPeerMetadata] = useState({}); // { [peerId]: { username: string, isHost: boolean, isMuted: boolean } }

    const [showAudioSettingsModal, setShowAudioSettingsModal] = useState(false);

    // Feature 2.3: Synchronized Soundboard (Mini SFX Tray)
    const [soundboardSettings, setSoundboardSettings] = useState(() => loadSoundboardSettings());
    const soundboardSettingsRef = useRef(soundboardSettings);
    const [activeSoundboardSfx, setActiveSoundboardSfx] = useState(null);
    const [activeSfxCooldowns, setActiveSfxCooldowns] = useState({});
    const activeSfxTimerRef = useRef(null);
    const lastSfxTimestampRef = useRef(0);
    const lastRemoteSfxTimestampRef = useRef(0);
    const lastRemoteSfxToastRef = useRef(0);

    // Feature 4.1: Real-Time P2P Network HUD (Ping & Latency)
    const [showNetworkHudModal, setShowNetworkHudModal] = useState(false);
    const [networkStats, setNetworkStats] = useState({
        avgPingMs: null,
        minPingMs: null,
        maxPingMs: null,
        overallConnectionType: 'Direct P2P',
        totalDownloadKBps: 0,
        totalUploadKBps: 0,
        syncDriftMs: undefined,
        syncDriftStatus: 'P2P Mesh Ready'
    });
    const [peersNetworkStats, setPeersNetworkStats] = useState([]);
    const peerStatsCacheRef = useRef(new Map());
    const pingHistoryRef = useRef(new Map());
    const lastSyncDriftMsRef = useRef(undefined);

    // Refs for Multi-Peer WebRTC Mesh (up to 3 users)
    // Map<targetPeerId, { pc, dataChannel, isConnected, candidateQueue, audioElement, webAudioSource, webAudioGain, analyserNode }>
    const peersRef = useRef(new Map());
    const wsRef = useRef(null);
    const currentRoomRef = useRef(null);
    const isHostRef = useRef(false);
    const pendingSignalsRef = useRef([]);
    const hasInitializedRef = useRef(false);
    const activeVideoIdRef = useRef(null);
    const syncStateGetterRef = useRef(null);
    const peerIdRef = useRef(crypto.randomUUID());


    currentRoomRef.current = roomId;
    isHostRef.current = isHost;
    activeVideoIdRef.current = activeVideoId;
    soundboardSettingsRef.current = soundboardSettings;

    const showToast = useCallback((msg) => {
        setToastMessage(msg);
        setTimeout(() => {
            setToastMessage('');
        }, 2800);
    }, []);

    const addSystemMessage = useCallback((text, category = 'system') => {
        setSystemLogs((prev) => [
            ...prev,
            {
                id: crypto.randomUUID(),
                text,
                category,
                timestamp: Date.now()
            }
        ]);
    }, []);

    // Developer debug logging is disabled in production to keep console and user logs clean
    const logLocalDebug = useCallback(() => { }, []);

    // Voice chat: mic, push-to-talk, audio settings, deafen, per-peer volume (hooks/useVoiceChat.js)
    const {
        isMicMuted,
        setIsMicMuted,
        isAudioBlocked,
        setIsAudioBlocked,
        peerVoiceStates,
        setPeerVoiceStates,
        peerVolumes,
        setPeerVolumes,
        localMutedPeers,
        setLocalMutedPeers,
        peerAudioActivity,
        setPeerAudioActivity,
        localAudioActivity,
        setLocalAudioActivity,
        audioSettings,
        voiceIsolationStatus,
        isPttActive,
        setIsPttActive,
        isPttActiveRef,
        pttReleaseTimerRef,
        localStreamRef,
        isMicMutedRef,
        isAudioBlockedRef,
        peerVolumesRef,
        localMutedPeersRef,
        localAnalyserRef,
        localSourceNodeRef,
        setMicrophoneMuted,
        toggleMicrophone,
        handleUpdateAudioSettings,
        handlePttPressStart,
        handlePttPressEnd,
        toggleBlockAudio,
        handleSetPeerVolume,
        handleToggleMutePeer
    } = useVoiceChat({ addSystemMessage, logLocalDebug, peerMetadata, peersRef, showToast, username });


    const handleClearLogs = useCallback(() => {
        setSystemLogs([]);
    }, []);

    const handleTestSound = useCallback(() => {
        sound.playChime();
        addSystemMessage('🔊 Test chime played. If you heard the chime, your audio output is working properly.');
        showToast('🔊 Playing test sound...');
    }, [addSystemMessage, showToast]);

    const updateP2PStatus = useCallback(() => {
        const activePeers = Array.from(peersRef.current.values()).filter(p => p.isConnected).length;
        const hasAnyConnected = activePeers > 0;
        setIsP2PConnected(hasAnyConnected);

        if (hasAnyConnected) {
            setP2pStatusText(`Direct P2P Active (${activePeers} peer${activePeers > 1 ? 's' : ''} connected)`);
        } else {
            setP2pStatusText('Waiting for peer to enter 5-digit code...');
        }
    }, []);

    // Safe Signal sender: buffers message if WebSocket is still connecting
    const sendSignal = useCallback((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        } else {
            pendingSignalsRef.current.push(data);
        }
    }, []);

    // Clean up a single peer connection
    const cleanupPeer = useCallback((targetPeerId) => {
        if (peersRef.current.has(targetPeerId)) {
            const entry = peersRef.current.get(targetPeerId);
            teardownPeerEntry(entry);
            peersRef.current.delete(targetPeerId);
            setPeerMetadata((prev) => {
                const next = { ...prev };
                delete next[targetPeerId];
                return next;
            });
            setPeerAudioActivity((prev) => {
                const next = { ...prev };
                delete next[targetPeerId];
                return next;
            });
            updateP2PStatus();
        }
    }, [updateP2PStatus]);

    // Clean up all peers
    const cleanupAllPeers = useCallback(() => {
        for (const entry of peersRef.current.values()) {
            teardownPeerEntry(entry, { sayBye: true });
        }
        peersRef.current.clear();
        setPeerMetadata({});
        setPeerAudioActivity({});
        setIsP2PConnected(false);
        setP2pStatusText('Waiting for peer to enter 5-digit code...');
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        setQueue([]);
        queueRef.current = [];
        setSkipVotes([]);
        skipVotesRef.current = [];
        setActiveVideoTitle('');
    }, []);

    // Broadcast an action (e.g. YouTube or Local Video play/pause/seek/load) to all connected peers
    const handleBroadcastAction = useCallback((action, payload = {}) => {
        const msg = {
            type: payload.type || 'yt-action',
            action,
            sender: username,
            timestamp: Date.now(),
            ...payload
        };

        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(JSON.stringify(msg));
                } catch { }
            }
        }
    }, [username]);

    // Broadcast a queue action to all connected peers
    const broadcastQueueAction = useCallback((actionType, payload = {}) => {
        const msg = {
            type: 'queue-action',
            action: actionType,
            sender: username,
            timestamp: Date.now(),
            ...payload
        };
        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(JSON.stringify(msg));
                } catch { }
            }
        }
    }, [username]);

    // Handle incoming remote YouTube action
    const handleRemoteYouTubeAction = useCallback(async (data) => {
        if (data.action === 'close' || data.action === 'unload') {
            setActiveVideoId(null);
            setActiveVideoTitle('');
            setSkipVotes([]);
            skipVotesRef.current = [];
            setRemoteAction(data);
            addSystemMessage(`🎬 ${data.sender || 'Peer'} exited the video`);
            showToast(`${data.sender || 'Peer'} exited the video`);
            return;
        }
        if (data.action === 'load') {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            const newId = data.newVideoId || data.videoId;
            setActiveVideoId(newId);
            setSkipVotes([]);
            skipVotesRef.current = [];
            let title = data.title;
            if (!title) {
                title = await fetchYouTubeTitle(newId);
            }
            setActiveVideoTitle(title);
            const titleInfo = title ? `: "${title}"` : '';
            addSystemMessage(`🎬 ${data.sender || 'Peer'} loaded a YouTube video${titleInfo}`);
            showToast(`${data.sender || 'Peer'} loaded ${title || 'video'}`);
        } else if (data.action === 'play') {
            addSystemMessage(`▶️ ${data.sender || 'Peer'} played the video`);
        } else if (data.action === 'pause') {
            addSystemMessage(`⏸️ ${data.sender || 'Peer'} paused the video`);
        } else if (data.action === 'seek') {
            const min = Math.floor((data.currentTime || 0) / 60);
            const sec = Math.floor((data.currentTime || 0) % 60).toString().padStart(2, '0');
            addSystemMessage(`⏩ ${data.sender || 'Peer'} seeked to ${min}:${sec}`);
        }
        setRemoteAction(data);
    }, [addSystemMessage, showToast]);

    // Handle incoming remote Queue action
    const handleRemoteQueueAction = useCallback((data) => {
        switch (data.action) {
            case 'add': {
                if (data.item) {
                    setQueue((prev) => {
                        if (prev.some((q) => q.id === data.item.id)) return prev;
                        const next = [...prev, data.item];
                        queueRef.current = next;
                        return next;
                    });
                    addSystemMessage(`📑 ${data.sender || 'Peer'} queued: "${data.item.title}"`);
                    showToast(`📑 ${data.sender || 'Peer'} added to queue`);
                }
                break;
            }
            case 'remove': {
                if (data.itemId) {
                    setQueue((prev) => {
                        const removed = prev.find((q) => q.id === data.itemId);
                        const next = prev.filter((q) => q.id !== data.itemId);
                        queueRef.current = next;
                        if (removed) {
                            addSystemMessage(`🗑️ ${data.sender || 'Peer'} removed "${removed.title}" from queue`);
                        }
                        return next;
                    });
                }
                break;
            }
            case 'reorder': {
                if (Array.isArray(data.queue)) {
                    setQueue(data.queue);
                    queueRef.current = data.queue;
                }
                break;
            }
            case 'clear': {
                setQueue([]);
                queueRef.current = [];
                addSystemMessage(`🗑️ ${data.sender || 'Peer'} cleared the queue`);
                break;
            }
            case 'play-item': {
                if (data.itemId) {
                    setQueue((prev) => {
                        const next = prev.filter((q) => q.id !== data.itemId);
                        queueRef.current = next;
                        return next;
                    });
                    setSkipVotes([]);
                    skipVotesRef.current = [];
                }
                break;
            }
            case 'next': {
                if (Array.isArray(data.remainingQueue)) {
                    setQueue(data.remainingQueue);
                    queueRef.current = data.remainingQueue;
                } else if (data.nextVideoId) {
                    setQueue((prev) => prev.filter((q) => q.videoId !== data.nextVideoId));
                }
                setSkipVotes([]);
                skipVotesRef.current = [];
                if (data.nextTitle) {
                    setActiveVideoTitle(data.nextTitle);
                    addSystemMessage(`⏭️ Now playing next queued: "${data.nextTitle}"`);
                }
                break;
            }
            case 'vote-skip': {
                if (Array.isArray(data.skipVotes)) {
                    setSkipVotes(data.skipVotes);
                    skipVotesRef.current = data.skipVotes;
                }
                break;
            }
            case 'vote-skip-passed': {
                setSkipVotes([]);
                skipVotesRef.current = [];
                addSystemMessage(`⏭️ Skip vote passed by consensus`);
                break;
            }
            default:
                break;
        }
    }, [addSystemMessage, showToast]);

    // Handle incoming remote Local Video action
    const handleRemoteLocalVideoAction = useCallback((data) => {
        if (data.action === 'load') {
            setActiveVideoId(null);
            setRemoteLocalVideoMeta({
                fileName: data.fileName,
                fileSize: data.fileSize,
                sender: data.sender
            });
            setRemoteAction(data);
            addSystemMessage(`📁 ${data.sender || 'Peer'} loaded local video: "${data.fileName}"`);
            showToast(`${data.sender || 'Peer'} loaded: ${data.fileName}`);
        } else if (data.action === 'close') {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            setRemoteAction(data);
            addSystemMessage(`📁 ${data.sender || 'Peer'} exited the local video`);
            showToast(`${data.sender || 'Peer'} exited local video`);
        } else if (data.action === 'subtitle-share') {
            setRemoteAction(data);
            addSystemMessage(`💬 ${data.sender || 'Peer'} shared subtitles: "${data.fileName || 'captions'}"`);
            showToast(`Subtitles loaded from ${data.sender || 'Peer'}`);
        } else {
            setRemoteAction(data);
            if (data.action === 'play') {
                addSystemMessage(`▶️ ${data.sender || 'Peer'} played local video`);
            } else if (data.action === 'pause') {
                addSystemMessage(`⏸️ ${data.sender || 'Peer'} paused local video`);
            } else if (data.action === 'seek') {
                const min = Math.floor((data.currentTime || 0) / 60);
                const sec = Math.floor((data.currentTime || 0) % 60).toString().padStart(2, '0');
                addSystemMessage(`⏩ ${data.sender || 'Peer'} seeked to ${min}:${sec}`);
            }
        }
    }, [addSystemMessage, showToast]);

    // Handle incoming remote Live Reaction
    const handleRemoteReaction = useCallback((data) => {
        if (!data || !data.emoji) return;
        const id = data.id || crypto.randomUUID();
        const reactionItem = {
            id,
            emoji: data.emoji,
            sender: data.sender || 'Peer',
            isSelf: false,
            lane: typeof data.lane === 'number' ? data.lane : (20 + Math.random() * 60),
            driftVariant: data.driftVariant || Math.floor(1 + Math.random() * 4),
            scale: data.scale || (1.05 + Math.random() * 0.35),
            rot: typeof data.rot === 'number' ? data.rot : ((Math.random() - 0.5) * 30),
            createdAt: Date.now()
        };

        if (!isAudioBlockedRef.current) {
            sound.playReactionPop();
        }

        setFloatingReactions((prev) => [...prev.slice(-25), reactionItem]);

        setTimeout(() => {
            setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
        }, 2600);
    }, []);

    // Feature 2.3: Handle incoming remote Soundboard SFX
    const handleRemoteSoundboardSfx = useCallback((data) => {
        if (!data || !data.soundId) return;
        const now = Date.now();
        // Allow rapid spamming while guarding against recursive flood loops
        if (now - lastRemoteSfxTimestampRef.current < 40) return;
        lastRemoteSfxTimestampRef.current = now;

        const effectiveVol = soundboardSettingsRef.current?.muted ? 0 : (soundboardSettingsRef.current?.volume ?? 0.75);
        if (!isAudioBlockedRef.current && effectiveVol > 0) {
            soundboard.play(data.soundId, effectiveVol);
        }

        const sfxInfo = {
            soundId: data.soundId,
            soundName: data.soundName || data.soundId,
            emoji: data.emoji || '🎵',
            sender: data.sender || 'Peer',
            timestamp: now
        };
        setActiveSoundboardSfx(sfxInfo);
        if (activeSfxTimerRef.current) clearTimeout(activeSfxTimerRef.current);
        activeSfxTimerRef.current = setTimeout(() => setActiveSoundboardSfx(null), 1800);

        // Throttle chat notifications so rapid spam clicks play audio every time without flooding chat
        if (now - lastRemoteSfxToastRef.current > 1200) {
            lastRemoteSfxToastRef.current = now;
            showToast(`🔊 ${data.sender || 'Peer'} played ${data.soundName || 'Sound'} ${data.emoji || ''}`);
            addSystemMessage(`🔊 ${data.sender || 'Peer'} played soundboard clip: "${data.soundName || data.soundId}"`);
        }
    }, [addSystemMessage, showToast]);

    // Feature 3.3: Handle incoming P2P image transfer start
    const handleIncomingImageStart = useCallback((data) => {
        p2pImageReceiver.handleStart(data);
        setMessages((prev) => [
            ...prev,
            {
                type: 'chat',
                id: data.id,
                transferId: data.transferId,
                sender: data.sender,
                isHost: data.isHost,
                text: data.caption || '',
                imageTransfer: {
                    transferId: data.transferId,
                    isTransferring: true,
                    percent: 0,
                    fileName: data.fileName,
                    fileSize: data.fileSize
                },
                isSelf: false,
                timestamp: data.timestamp || Date.now()
            }
        ]);
        sound.playChime();
    }, []);

    // Feature 3.3: Handle incoming binary chunk for P2P image transfer
    const handleIncomingImageChunk = useCallback((arrayBuffer) => {
        p2pImageReceiver.handleChunk(arrayBuffer, {
            onProgress: (transferId, percent) => {
                setMessages((prev) =>
                    prev.map((m) => {
                        if (m.transferId === transferId && m.imageTransfer) {
                            return {
                                ...m,
                                imageTransfer: { ...m.imageTransfer, percent }
                            };
                        }
                        return m;
                    })
                );
            },
            onComplete: (transferId, result) => {
                setMessages((prev) =>
                    prev.map((m) => {
                        if (m.transferId === transferId) {
                            return {
                                ...m,
                                imageTransfer: null,
                                image: {
                                    url: result.objectUrl,
                                    name: result.fileName,
                                    size: result.fileSize,
                                    mimeType: result.mimeType,
                                    blob: result.blob
                                }
                            };
                        }
                        return m;
                    })
                );
                sound.playPop();
            }
        });
    }, []);

    // Feature 4.1: Record DataChannel ping latency probe
    const recordPeerPing = useCallback((peerId, pingMs) => {
        if (!peerId || typeof pingMs !== 'number' || pingMs < 0 || pingMs > 10000) return;

        const history = pingHistoryRef.current.get(peerId) || [];
        const updatedHistory = [...history.slice(-(MAX_HISTORY_SAMPLES - 1)), pingMs];
        pingHistoryRef.current.set(peerId, updatedHistory);

        const avg = Math.round(updatedHistory.reduce((a, b) => a + b, 0) / updatedHistory.length);

        setPeersNetworkStats((prev) => {
            const existing = prev.find((p) => p.peerId === peerId);
            if (existing) {
                return prev.map((p) => (p.peerId === peerId ? {
                    ...p,
                    pingMs,
                    avgPingMs: avg,
                    pingHistory: updatedHistory
                } : p));
            } else {
                return [...prev, {
                    peerId,
                    username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
                    pingMs,
                    avgPingMs: avg,
                    pingHistory: updatedHistory,
                    connectionType: 'Direct P2P',
                    protocol: 'UDP'
                }];
            }
        });
    }, [peerMetadata]);

    // Create or get peer connection in mesh
    const getOrCreatePeerConnection = useCallback((targetPeerId, isInitiator) => {
        if (peersRef.current.has(targetPeerId)) {
            return peersRef.current.get(targetPeerId);
        }

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const peerEntry = {
            pc,
            dataChannel: null,
            bulkChannel: null,
            isConnected: false,
            candidateQueue: [],
            audioElement: null,
            isInitiator: Boolean(isInitiator), // the initiator drives ICE restarts (no offer glare)
            applyingRemote: false,             // remote description being applied: queue candidates
            recoveryTimer: null,
            restartAttempts: 0,
            brokenSince: 0,
            wasInterrupted: false,
            signalingGone: false,              // peer dropped off signaling but P2P link was still up
            rebuilt: false
        };
        peersRef.current.set(targetPeerId, peerEntry);

        // Bulk channel (video stream / images), same pre-agreed id on both sides
        try {
            const bulk = pc.createDataChannel('bulk', { negotiated: true, id: BULK_CHANNEL_ID, ordered: true });
            bulk.binaryType = 'arraybuffer';
            peerEntry.bulkChannel = bulk;
        } catch (err) {
            logLocalDebug('BULK_CHANNEL_ERR', err.message);
        }

        // Audio Transceiver for WebRTC Voice Chat
        // Initiator must call addTransceiver to include 'm=audio sendrecv' in Offer.
        // Answerer must NOT call addTransceiver before Offer arrives; setRemoteDescription(offer) will create the single mid:0 transceiver cleanly.
        try {
            if (isInitiator) {
                let audioTransceiver = pc.getTransceivers ? pc.getTransceivers().find(t =>
                    t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'
                ) : null;

                if (!audioTransceiver) {
                    audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
                } else {
                    audioTransceiver.direction = 'sendrecv';
                }

                logLocalDebug('TRANSCEIVER_INIT', `Role: HOST/OFFERER -> Peer: ${targetPeerId} | Transceiver mid: ${audioTransceiver?.mid || 'pending'} | direction: ${audioTransceiver?.direction}`);

                if (localStreamRef.current) {
                    const audioTrack = micPipeline.getOutputTrack() || localStreamRef.current.getAudioTracks()[0];
                    if (audioTrack && !isMicMutedRef.current && audioTransceiver?.sender) {
                        audioTransceiver.sender.replaceTrack(audioTrack).catch(() => { });
                    }
                }
            } else {
                logLocalDebug('TRANSCEIVER_INIT', `Role: PEER/ANSWERER -> Peer: ${targetPeerId} (Awaiting offer to configure single audio transceiver)`);
            }
        } catch (err) {
            logLocalDebug('TRANSCEIVER_INIT_ERR', err.message);
        }

        attachRemoteAudio(pc, { isAudioBlockedRef, localMutedPeersRef, logLocalDebug, peerEntry, peerVolumesRef, targetPeerId });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal({
                    type: 'ice-candidate',
                    targetId: targetPeerId,
                    candidate: event.candidate
                });
            }
        };

        const { isStillCurrent, scheduleRecovery } = attachPeerRecovery(pc, { addSystemMessage, cleanupPeer, getOrCreatePeerConnectionRef, logLocalDebug, peerEntry, peersRef, sendSignal, setPeerCount, showToast, targetPeerId, updateP2PStatus, wsRef });

        const bindDataChannel = (dc) => {
            peerEntry.dataChannel = dc;
            try {
                dc.binaryType = 'arraybuffer';
            } catch (e) { }

            dc.onopen = () => {
                peerEntry.isConnected = true;
                updateP2PStatus();
                sound.playChime();
                addSystemMessage('Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!');
                showToast('Direct P2P Connected!');

                // Share identity and initial voice mute status with peer
                try {
                    dc.send(JSON.stringify({
                        type: 'peer-identity',
                        peerId: peerIdRef.current,
                        username: username,
                        isHost: isHostRef.current,
                        isMuted: isMicMutedRef.current
                    }));
                    dc.send(JSON.stringify({
                        type: 'peer-voice-status',
                        peerId: peerIdRef.current,
                        sender: username,
                        isMuted: isMicMutedRef.current
                    }));
                } catch (e) { }

                // Request YouTube sync state from existing room peers
                try {
                    dc.send(JSON.stringify({ type: 'yt-request-sync' }));
                } catch (e) { }
            };

            dc.onmessage = createPeerMessageHandler({ activeStreamSendersRef, activeVideoTitleRef, addSystemMessage, cleanupPeer, dc, handleIncomingImageChunk, handleIncomingImageStart, handleRemoteLocalVideoAction, handleRemoteQueueAction, handleRemoteReaction, handleRemoteSoundboardSfx, handleRemoteYouTubeAction, hostStreamRef, isAudioBlockedRef, isHostRef, isMicMutedRef, isStillCurrent, localVideoFileRef, peerEntry, peerIdRef, peersRef, queueRef, recordPeerPing, setActiveVideoId, setActiveVideoTitle, setLocalVideoFile, setMessages, setPeerCount, setPeerMetadata, setPeerVoiceStates, setQueue, setRemoteAction, setRemoteLocalVideoMeta, setSkipVotes, setStreamProgress, setStreamVideoUrl, showToast, skipVotesRef, streamReceiverRef, syncStateGetterRef, targetPeerId, username });

            dc.onclose = () => {
                if (activeStreamSendersRef.current.has(targetPeerId)) {
                    activeStreamSendersRef.current.get(targetPeerId).abort();
                    activeStreamSendersRef.current.delete(targetPeerId);
                }
                if (!isStillCurrent()) return;
                peerEntry.isConnected = false;
                updateP2PStatus();
                // Peer left on purpose: clean up. Otherwise the link died: try to recover
                // (if they closed the tab, the server's peer-left cleans up first)
                if (peerEntry.byeReceived || peerEntry.signalingGone) {
                    cleanupPeer(targetPeerId);
                    setPeerCount(peersRef.current.size + 1);
                } else if (pc.connectionState !== 'closed') {
                    peerEntry.wasInterrupted = true;
                    scheduleRecovery(RECOVERY.disconnectGraceMs);
                }
            };

            dc.onerror = () => { };

            // Bulk transfers (video stream chunks, images) arrive on the bulk channel; same handler
            if (peerEntry.bulkChannel) {
                peerEntry.bulkChannel.onmessage = dc.onmessage;
            }
        };

        if (isInitiator) {
            try {
                const dc = pc.createDataChannel(`chat-${targetPeerId}`, { ordered: true });
                bindDataChannel(dc);

                pc.createOffer().then((offer) => {
                    const tunedSdp = tuneSdpForDiscordAudio(offer.sdp);
                    const tunedOffer = { type: offer.type, sdp: tunedSdp };
                    return pc.setLocalDescription(tunedOffer).then(() => {
                        tuneAudioSender(pc);
                        const audioSdp = extractAudioSdp(tunedOffer.sdp);
                        const tInfo = pc.getTransceivers ? pc.getTransceivers().map((t) => `${t.mid || 'pending'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                        logLocalDebug('OFFER_SENT', `To: ${targetPeerId} | SDP: ${audioSdp} | Transceivers: ${tInfo}`);

                        sendSignal({
                            type: 'offer',
                            targetId: targetPeerId,
                            fresh: true, // brand-new connection: the peer replaces any old one it has
                            offer: {
                                type: tunedOffer.type,
                                sdp: tunedOffer.sdp
                            }
                        });
                    });
                }).catch((err) => {
                    logLocalDebug('OFFER_ERR', `Target: ${targetPeerId} error: ${err.message}`);
                });
            } catch (err) { }
        } else {
            pc.ondatachannel = (event) => {
                bindDataChannel(event.channel);
            };
        }

        return peerEntry;
    }, [addSystemMessage, cleanupPeer, handleIncomingImageChunk, handleIncomingImageStart, handleRemoteYouTubeAction, handleRemoteLocalVideoAction, handleRemoteQueueAction, handleRemoteReaction, handleRemoteSoundboardSfx, logLocalDebug, recordPeerPing, sendSignal, showToast, updateP2PStatus, username]);
    useEffect(() => {
        getOrCreatePeerConnectionRef.current = getOrCreatePeerConnection;
    }, [getOrCreatePeerConnection]);

    // Handle incoming signaling messages
    const handleSignalingMessage = useCallback((msg) => processSignalingMessage(msg, { addSystemMessage, cleanupPeer, currentRoomRef, getOrCreatePeerConnection, isHostRef, isMicMutedRef, localStreamRef, logLocalDebug, peersRef, sendSignal, setIsHost, setP2pStatusText, setPeerCount, setRoomId, showToast, username }), [addSystemMessage, cleanupPeer, getOrCreatePeerConnection, logLocalDebug, sendSignal, showToast, username]);

    // Signaling server connection (hooks/useSignalingConnection.js)
    useSignalingConnection({ addSystemMessage, currentRoomRef, handleSignalingMessage, isHostRef, peerIdRef, peersRef, pendingSignalsRef, setSignalStatus, showToast, signalUrl, wsRef });
    // On-demand P2P stream: the service worker forwards each byte range the video player asks for
    useEffect(() => {
        const sw = navigator.serviceWorker;
        if (!sw) return undefined;
        const handleWorkerMessage = (event) => {
            const msg = event.data || {};
            if (msg.type !== 'p2p-range-open' || !event.ports[0]) return;
            const port = event.ports[0];
            const receiver = streamReceiverRef.current;
            if (receiver && typeof receiver.serve === 'function' && String(receiver.streamNo) === String(msg.streamNo)) {
                receiver.serve(port, msg.start, msg.end);
            } else {
                port.postMessage({ type: 'meta', ok: false });
            }
        };
        sw.addEventListener('message', handleWorkerMessage);
        return () => sw.removeEventListener('message', handleWorkerMessage);
    }, []);

    // Ensure AudioContext is resumed on any user interaction anywhere on the window
    useEffect(() => {
        const resumeAudioCtx = () => {
            if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
                window.__webrtcAudioCtx.resume().catch(() => { });
            }
        };
        window.addEventListener('click', resumeAudioCtx);
        window.addEventListener('keydown', resumeAudioCtx);
        window.addEventListener('touchstart', resumeAudioCtx);
        return () => {
            window.removeEventListener('click', resumeAudioCtx);
            window.removeEventListener('keydown', resumeAudioCtx);
            window.removeEventListener('touchstart', resumeAudioCtx);
        };
    }, []);

    // Auto-detect ?room=12345 URL parameter on initial load
    useEffect(() => {
        if (!hasInitializedRef.current) {
            hasInitializedRef.current = true;
            const urlParams = new URLSearchParams(window.location.search);
            const roomParam = urlParams.get('room');
            if (roomParam && /^\d{5}$/.test(roomParam)) {
                setInitialJoinPin(roomParam);
                setShowJoinModal(true);
            }
            addSystemMessage('Welcome to 3RTC! Create or join a room to chat and watch YouTube together.');
        }
    }, [addSystemMessage]);

    // Room Actions
    const handleConfirmCreate = (displayName) => {
        setUsername(displayName);
        localStorage.setItem('webrtc_username', displayName);
        setShowCreateModal(false);
        sendSignal({
            type: 'create-room',
            peerId: peerIdRef.current
        });
    };

    const handleConfirmJoin = (pin, displayName) => {
        setUsername(displayName);
        localStorage.setItem('webrtc_username', displayName);
        setShowJoinModal(false);
        sendSignal({
            type: 'join',
            roomId: pin,
            peerId: peerIdRef.current
        });
    };

    const handleLeaveRoom = () => {
        if (window.confirm('Leave this room and end P2P connection?')) {
            if (roomId) {
                sendSignal({ type: 'leave' });
            }
            micPipeline.teardown();
            if (localStreamRef.current) {
                try {
                    localStreamRef.current.getTracks().forEach((track) => track.stop());
                } catch { }
                localStreamRef.current = null;
            }
            if (localSourceNodeRef.current) {
                try { localSourceNodeRef.current.disconnect(); } catch { }
                localSourceNodeRef.current = null;
            }
            if (localAnalyserRef.current) {
                try { localAnalyserRef.current.disconnect(); } catch { }
                localAnalyserRef.current = null;
            }
            setIsMicMuted(true);
            setIsAudioBlocked(false);
            setPeerVoiceStates({});
            setPeerVolumes({});
            setLocalMutedPeers({});
            setPeerMetadata({});
            setPeerAudioActivity({});
            setLocalAudioActivity({ isSpeaking: false, level: 0 });
            cleanupAllPeers();
            setRoomId(null);
            setIsHost(false);
            setPeerCount(0);
            setActiveVideoId(null);
            setActiveVideoTitle('');
            setQueue([]);
            queueRef.current = [];
            setSkipVotes([]);
            skipVotesRef.current = [];
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
            setRemoteAction(null);
            if (streamReceiverRef.current) {
                streamReceiverRef.current.abort();
                streamReceiverRef.current = null;
            }
            if (streamVideoUrl) {
                try { URL.revokeObjectURL(streamVideoUrl); } catch (e) { }
                setStreamVideoUrl(null);
            }
            setStreamProgress(null);
            for (const sender of activeStreamSendersRef.current.values()) {
                sender.abort();
            }
            activeStreamSendersRef.current.clear();
            addSystemMessage('You left the room.');
            showToast('Left room');
        }
    };

    const handleCopyRoom = useCallback(async (customVal) => {
        if (!roomId) return;
        const valueToCopy = typeof customVal === 'string' && customVal.trim() ? customVal.trim() : String(roomId).trim();
        const success = await copyToClipboard(valueToCopy);
        if (success) {
            showToast(`Copied Room ID: ${valueToCopy}`);
        } else {
            showToast(`Room ID: ${valueToCopy}`);
        }
    }, [roomId, showToast]);

    const handleSendMessage = (text) => {
        const msgPayload = {
            type: 'chat',
            id: crypto.randomUUID(),
            sender: username,
            isHost,
            text,
            timestamp: Date.now()
        };

        let sentCount = 0;
        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                peer.dataChannel.send(JSON.stringify(msgPayload));
                sentCount++;
            }
        }

        if (sentCount > 0) {
            setMessages((prev) => [...prev, { ...msgPayload, isSelf: true }]);
            sound.playPop();
        } else {
            showToast('Waiting for peer to connect before sending');
        }
    };

    // Feature 3.3: Direct P2P Image & Screenshot Sharing
    const handleSendImage = useCallback((file, caption = '') => {
        if (!file) return;

        if (file.size > 15 * 1024 * 1024) {
            showToast('Image exceeds 15 MB limit. Please select a smaller file.');
            return;
        }

        // Images go over each peer's bulk channel so chat and sync never wait behind them
        const activeChannels = [];
        for (const peer of peersRef.current.values()) {
            if (peer.bulkChannel && peer.bulkChannel.readyState === 'open') {
                activeChannels.push(peer.bulkChannel);
            } else if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                activeChannels.push(peer.dataChannel);
            }
        }

        if (activeChannels.length === 0) {
            showToast('Waiting for peer to connect before sending image');
            return;
        }

        const messageId = crypto.randomUUID();
        const transferId = crypto.randomUUID();
        const localUrl = URL.createObjectURL(file);

        // Optimistically display image in chat with local thumbnail & sending progress
        setMessages((prev) => [
            ...prev,
            {
                type: 'chat',
                id: messageId,
                transferId,
                sender: username,
                isHost: isHostRef.current,
                text: caption,
                image: {
                    url: localUrl,
                    name: file.name || 'screenshot.png',
                    size: file.size,
                    mimeType: file.type || 'image/png',
                    blob: file
                },
                imageTransfer: {
                    transferId,
                    isTransferring: true,
                    percent: 0,
                    fileName: file.name || 'screenshot.png',
                    fileSize: file.size
                },
                isSelf: true,
                timestamp: Date.now()
            }
        ]);
        sound.playPop();

        const sender = new P2PImageSender(file, () => activeChannels, {
            id: messageId,
            transferId,
            sender: username,
            isHost: isHostRef.current,
            caption,
            onProgress: ({ percent }) => {
                setMessages((prev) =>
                    prev.map((m) => {
                        if (m.transferId === transferId && m.imageTransfer) {
                            return {
                                ...m,
                                imageTransfer: { ...m.imageTransfer, percent }
                            };
                        }
                        return m;
                    })
                );
            },
            onComplete: () => {
                setMessages((prev) =>
                    prev.map((m) => {
                        if (m.transferId === transferId) {
                            return { ...m, imageTransfer: null };
                        }
                        return m;
                    })
                );
            },
            onError: (err) => {
                addSystemMessage(`❌ Image transfer failed: ${err.message}`);
                showToast(`Image send failed: ${err.message}`);
            }
        });

        sender.start();
    }, [addSystemMessage, showToast, username]);

    // Feature 4.1: Background WebRTC Mesh Metrics Polling & Ping Loop
    useEffect(() => {
        if (!roomId) {
            setNetworkStats({
                avgPingMs: null,
                minPingMs: null,
                maxPingMs: null,
                overallConnectionType: 'Direct P2P',
                totalDownloadKBps: 0,
                totalUploadKBps: 0,
                syncDriftMs: undefined,
                syncDriftStatus: 'No active room'
            });
            setPeersNetworkStats([]);
            return;
        }

        let isCancelled = false;

        const pollStats = async () => {
            if (isCancelled) return;
            const activePeers = Array.from(peersRef.current.entries());
            if (activePeers.length === 0) return;

            const peerStatsList = [];
            let totalDown = 0;
            let totalUp = 0;
            let sumPing = 0;
            let pingCount = 0;
            let minPing = Infinity;
            let maxPing = -Infinity;
            let hasRelay = false;
            let maxLoss = 0;

            for (const [peerId, peerEntry] of activePeers) {
                if (!peerEntry || !peerEntry.pc) continue;

                // 1. Send active DataChannel net-ping probe
                if (peerEntry.dataChannel && peerEntry.dataChannel.readyState === 'open') {
                    try {
                        peerEntry.dataChannel.send(JSON.stringify({
                            type: 'net-ping',
                            pingId: crypto.randomUUID(),
                            sendTime: performance.now()
                        }));
                    } catch (e) { }
                }

                // 2. Query RTCPeerConnection.getStats()
                const prevStats = peerStatsCacheRef.current.get(peerId);
                const extracted = await extractPeerConnectionStats(peerEntry.pc, prevStats);
                if (extracted) {
                    peerStatsCacheRef.current.set(peerId, extracted);
                }

                const history = pingHistoryRef.current.get(peerId) || [];
                const rtt = extracted?.rttMs ?? (history.length > 0 ? history[history.length - 1] : null);
                if (rtt !== null) {
                    if (history.length === 0 || history[history.length - 1] !== rtt) {
                        history.push(rtt);
                        if (history.length > MAX_HISTORY_SAMPLES) history.shift();
                        pingHistoryRef.current.set(peerId, history);
                    }
                }

                const avgPing = history.length > 0 ? Math.round(history.reduce((a, b) => a + b, 0) / history.length) : rtt;

                if (rtt !== null) {
                    sumPing += rtt;
                    pingCount++;
                    if (rtt < minPing) minPing = rtt;
                    if (rtt > maxPing) maxPing = rtt;
                }

                const downRate = extracted?.downloadKBps || 0;
                const upRate = extracted?.uploadKBps || 0;
                totalDown += downRate;
                totalUp += upRate;

                if (extracted?.connectionType?.includes('Relay')) {
                    hasRelay = true;
                }
                if (extracted?.packetLossPercent > maxLoss) {
                    maxLoss = extracted.packetLossPercent;
                }

                peerStatsList.push({
                    peerId,
                    username: peerMetadata[peerId]?.username || `User_${peerId.slice(0, 4)}`,
                    isConnected: peerEntry.isConnected,
                    pingMs: rtt,
                    avgPingMs: avgPing,
                    pingHistory: [...history],
                    connectionType: extracted?.connectionType || 'Direct P2P (STUN)',
                    protocol: extracted?.protocol || 'UDP',
                    packetLossPercent: extracted?.packetLossPercent ?? 0,
                    jitterMs: extracted?.jitterMs ?? 0,
                    downloadKBps: downRate,
                    uploadKBps: upRate,
                    candidatePair: extracted ? {
                        localType: extracted.localCandidate.type,
                        remoteType: extracted.remoteCandidate.type,
                        localIp: extracted.localCandidate.address,
                        remoteIp: extracted.remoteCandidate.address
                    } : null
                });
            }

            if (isCancelled) return;

            setPeersNetworkStats(peerStatsList);

            const currentAvg = pingCount > 0 ? Math.round(sumPing / pingCount) : null;
            const drift = lastSyncDriftMsRef.current ?? (activeVideoId || localVideoFile ? 14 : undefined);
            const driftText = drift !== undefined
                ? (drift <= 50 ? `Strict Sync (±${drift}ms)` : `Acceptable Drift (±${drift}ms)`)
                : 'In Sync';

            setNetworkStats({
                avgPingMs: currentAvg,
                minPingMs: minPing === Infinity ? currentAvg : minPing,
                maxPingMs: maxPing === -Infinity ? currentAvg : maxPing,
                overallConnectionType: hasRelay ? 'Relay (TURN)' : 'Direct P2P',
                totalDownloadKBps: +totalDown.toFixed(1),
                totalUploadKBps: +totalUp.toFixed(1),
                maxPacketLoss: maxLoss,
                syncDriftMs: drift,
                syncDriftStatus: driftText,
                pingHistory: peerStatsList[0]?.pingHistory || []
            });
        };

        pollStats();
        const interval = setInterval(pollStats, PING_INTERVAL_MS);

        return () => {
            isCancelled = true;
            clearInterval(interval);
        };
    }, [roomId, activeVideoId, localVideoFile, peerMetadata]);

    const handleTriggerPing = useCallback(() => {
        for (const peerEntry of peersRef.current.values()) {
            if (peerEntry.dataChannel && peerEntry.dataChannel.readyState === 'open') {
                try {
                    peerEntry.dataChannel.send(JSON.stringify({
                        type: 'net-ping',
                        pingId: crypto.randomUUID(),
                        sendTime: performance.now()
                    }));
                } catch (e) { }
            }
        }
        showToast('Ping probe sent to mesh peers');
    }, [showToast]);

    // Feature 1.2: Floating Live Reactions Over Video Player
    const handleSendReaction = useCallback((emoji) => {
        if (!emoji) return;

        const id = crypto.randomUUID();
        const lane = 20 + Math.random() * 60;
        const driftVariant = Math.floor(1 + Math.random() * 4);
        const scale = 1.05 + Math.random() * 0.35;
        const rot = (Math.random() - 0.5) * 30;

        const reactionItem = {
            id,
            emoji,
            sender: username,
            isSelf: true,
            lane,
            driftVariant,
            scale,
            rot,
            createdAt: Date.now()
        };

        sound.playReactionPop();

        setFloatingReactions((prev) => [...prev.slice(-25), reactionItem]);

        setTimeout(() => {
            setFloatingReactions((prev) => prev.filter((r) => r.id !== id));
        }, 2600);

        const msg = {
            type: 'reaction',
            id,
            emoji,
            sender: username,
            lane,
            driftVariant,
            scale,
            rot,
            timestamp: Date.now()
        };

        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(JSON.stringify(msg));
                } catch { }
            }
        }
    }, [username]);

    // Feature 2.3: Trigger local soundboard clip and synchronize over DataChannel
    const handlePlaySoundboardClip = useCallback((clip) => {
        if (!clip || !clip.id) return;
        const now = Date.now();
        // Allow rapid continuous spamming like Discord while guarding against accidental double-event quirks
        if (now - lastSfxTimestampRef.current < 30) return;
        lastSfxTimestampRef.current = now;

        // Play locally if not muted (cancels any playing sound and restarts immediately)
        const effectiveVol = soundboardSettingsRef.current?.muted ? 0 : (soundboardSettingsRef.current?.volume ?? 0.75);
        if (!isAudioBlockedRef.current && effectiveVol > 0) {
            soundboard.play(clip.id, effectiveVol);
        }

        const sfxInfo = {
            soundId: clip.id,
            soundName: clip.name,
            emoji: clip.emoji,
            sender: username,
            timestamp: now
        };
        setActiveSoundboardSfx(sfxInfo);
        if (activeSfxTimerRef.current) clearTimeout(activeSfxTimerRef.current);
        activeSfxTimerRef.current = setTimeout(() => setActiveSoundboardSfx(null), 1800);

        // Broadcast to all connected peers via DataChannel
        const sfxMsg = {
            type: 'soundboard-sfx',
            soundId: clip.id,
            soundName: clip.name,
            emoji: clip.emoji,
            sender: username,
            timestamp: now
        };
        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try { peer.dataChannel.send(JSON.stringify(sfxMsg)); } catch { }
            }
        }
    }, [username]);

    const handleSoundboardVolumeChange = useCallback((newVol) => {
        setSoundboardSettings((prev) => {
            const updated = { ...prev, volume: newVol };
            soundboardSettingsRef.current = updated;
            saveSoundboardSettings(updated.volume, updated.muted);
            return updated;
        });
    }, []);

    const handleToggleSoundboardMute = useCallback(() => {
        setSoundboardSettings((prev) => {
            const updated = { ...prev, muted: !prev.muted };
            soundboardSettingsRef.current = updated;
            saveSoundboardSettings(updated.volume, updated.muted);
            return updated;
        });
    }, []);

    const handleApplyServer = (newUrl) => {
        setSignalUrl(newUrl);
        localStorage.setItem('webrtc_signal_url', newUrl);
        showToast(`Connecting to ${newUrl}...`);
    };

    const handleVideoChange = useCallback(async (newId, customTitle = '') => {
        if (newId) {
            setLocalVideoFile(null);
            setRemoteLocalVideoMeta(null);
        }
        setActiveVideoId(newId);
        setSkipVotes([]);
        skipVotesRef.current = [];
        if (newId) {
            let title = customTitle;
            if (!title) {
                title = await fetchYouTubeTitle(newId);
            }
            setActiveVideoTitle(title);
            addSystemMessage(`🎬 You loaded: "${title}"`);
        } else {
            setActiveVideoTitle('');
            addSystemMessage(`🎬 You exited the video`);
        }
    }, [addSystemMessage]);

    // Collaborative Queue Actions
    const handleAddToQueue = useCallback(async ({ videoId, title }) => {
        if (!videoId) return;
        let finalTitle = title;
        if (!finalTitle) {
            finalTitle = await fetchYouTubeTitle(videoId);
        }
        const item = {
            id: crypto.randomUUID(),
            videoId,
            title: finalTitle,
            addedBy: username,
            timestamp: Date.now()
        };

        // If no video is currently active, immediately play it!
        if (!activeVideoIdRef.current && !localVideoFile && !remoteLocalVideoMeta) {
            setActiveVideoId(videoId);
            setActiveVideoTitle(finalTitle);
            handleBroadcastAction('load', {
                type: 'yt-action',
                action: 'load',
                newVideoId: videoId,
                title: finalTitle
            });
            showToast(`▶️ Now playing: "${finalTitle}"`);
            addSystemMessage(`🎬 Now playing: "${finalTitle}"`);
            return;
        }

        setQueue((prev) => {
            const nextQueue = [...prev, item];
            queueRef.current = nextQueue;
            return nextQueue;
        });

        broadcastQueueAction('add', { item });
        showToast(`📑 Added to queue: "${finalTitle}"`);
        addSystemMessage(`📑 You added "${finalTitle}" to the watch queue`);
    }, [addSystemMessage, broadcastQueueAction, handleBroadcastAction, localVideoFile, remoteLocalVideoMeta, showToast, username]);

    const handleRemoveFromQueue = useCallback((itemId) => {
        setQueue((prev) => {
            const removed = prev.find((item) => item.id === itemId);
            const nextQueue = prev.filter((item) => item.id !== itemId);
            queueRef.current = nextQueue;
            if (removed) {
                addSystemMessage(`🗑️ You removed "${removed.title}" from queue`);
                showToast(`Removed from queue`);
            }
            return nextQueue;
        });
        broadcastQueueAction('remove', { itemId });
    }, [addSystemMessage, broadcastQueueAction, showToast]);

    const handleReorderQueue = useCallback((newQueue) => {
        setQueue(newQueue);
        queueRef.current = newQueue;
        broadcastQueueAction('reorder', { queue: newQueue });
    }, [broadcastQueueAction]);

    const handleClearQueue = useCallback(() => {
        setQueue([]);
        queueRef.current = [];
        broadcastQueueAction('clear');
        showToast('Queue cleared');
        addSystemMessage('🗑️ You cleared the queue');
    }, [addSystemMessage, broadcastQueueAction, showToast]);

    const handlePlayQueueItem = useCallback((itemId) => {
        const item = queueRef.current.find((q) => q.id === itemId);
        if (!item) return;

        setQueue((prev) => {
            const nextQueue = prev.filter((q) => q.id !== itemId);
            queueRef.current = nextQueue;
            return nextQueue;
        });
        setSkipVotes([]);
        skipVotesRef.current = [];

        setActiveVideoId(item.videoId);
        setActiveVideoTitle(item.title);

        handleBroadcastAction('load', {
            type: 'yt-action',
            action: 'load',
            newVideoId: item.videoId,
            title: item.title
        });
        broadcastQueueAction('play-item', { itemId });

        showToast(`▶️ Now playing from queue: "${item.title}"`);
        addSystemMessage(`🎬 Playing queued video: "${item.title}"`);
    }, [addSystemMessage, broadcastQueueAction, handleBroadcastAction, showToast]);

    const handlePlayNextInQueue = useCallback(() => {
        const currentQ = queueRef.current;
        if (currentQ.length === 0) {
            showToast('Queue is empty');
            return;
        }

        const [nextItem, ...remaining] = currentQ;
        setQueue(remaining);
        queueRef.current = remaining;
        setSkipVotes([]);
        skipVotesRef.current = [];

        setActiveVideoId(nextItem.videoId);
        setActiveVideoTitle(nextItem.title);

        handleBroadcastAction('load', {
            type: 'yt-action',
            action: 'load',
            newVideoId: nextItem.videoId,
            title: nextItem.title
        });
        broadcastQueueAction('next', { nextVideoId: nextItem.videoId, nextTitle: nextItem.title, remainingQueue: remaining });

        sound.playPop();
        showToast(`▶️ Next Up: "${nextItem.title}"`);
        addSystemMessage(`⏭️ Autoplaying next in queue: "${nextItem.title}"`);
    }, [addSystemMessage, broadcastQueueAction, handleBroadcastAction, showToast]);

    const handleVoteSkip = useCallback(() => {
        if (!activeVideoIdRef.current) return;

        const currentVotes = skipVotesRef.current;
        const alreadyVoted = currentVotes.includes(username);
        const updatedVotes = alreadyVoted
            ? currentVotes.filter((u) => u !== username)
            : [...currentVotes, username];

        setSkipVotes(updatedVotes);
        skipVotesRef.current = updatedVotes;

        const totalPeers = Math.max(1, peerCount || 1);
        const requiredVotes = Math.max(1, Math.ceil(totalPeers / 2));

        broadcastQueueAction('vote-skip', { skipVotes: updatedVotes });

        if (updatedVotes.length >= requiredVotes) {
            showToast(`⏭️ Vote skip passed (${updatedVotes.length}/${requiredVotes})!`);
            addSystemMessage(`⏭️ Vote skip passed (${updatedVotes.length}/${requiredVotes} votes). Skipping video...`);
            setSkipVotes([]);
            skipVotesRef.current = [];
            broadcastQueueAction('vote-skip-passed');

            if (queueRef.current.length > 0) {
                handlePlayNextInQueue();
            } else {
                setActiveVideoId(null);
                setActiveVideoTitle('');
                handleBroadcastAction('close', {});
                addSystemMessage('🎬 Queue ended. Exited video player.');
            }
        } else {
            showToast(alreadyVoted ? 'Removed skip vote' : `Voted to skip (${updatedVotes.length}/${requiredVotes})`);
        }
    }, [broadcastQueueAction, handleBroadcastAction, handlePlayNextInQueue, peerCount, showToast, addSystemMessage, username]);

    const handleOpenQueue = useCallback(() => {
        setIsChatOpen(true);
        setSidebarTab('queue');
    }, []);

    const handleLocalFileSelect = useCallback((file) => {
        if (!file) return;
        localVideoFileRef.current = file;
        if (streamReceiverRef.current) {
            streamReceiverRef.current.abort();
            streamReceiverRef.current = null;
        }
        if (streamVideoUrl) {
            try { URL.revokeObjectURL(streamVideoUrl); } catch (e) { }
            setStreamVideoUrl(null);
        }
        setStreamProgress(null);
        setActiveVideoId(null);
        setLocalVideoFile(file);
        setRemoteLocalVideoMeta(null);
        addSystemMessage(`📁 You loaded local video: "${file.name}"`);
        showToast(`Loaded "${file.name}"`);

        // Broadcast to all peers in the room that this video was loaded
        handleBroadcastAction('load', {
            type: 'local-video-action',
            fileName: file.name,
            fileSize: file.size,
            sender: username
        });
    }, [streamVideoUrl, handleBroadcastAction, username, addSystemMessage, showToast]);

    const handleCloseLocalVideo = useCallback(() => {
        setLocalVideoFile(null);
        setRemoteLocalVideoMeta(null);
        if (streamReceiverRef.current) {
            streamReceiverRef.current.abort();
            streamReceiverRef.current = null;
        }
        if (streamVideoUrl) {
            try { URL.revokeObjectURL(streamVideoUrl); } catch (e) { }
            setStreamVideoUrl(null);
        }
        setStreamProgress(null);
        for (const sender of activeStreamSendersRef.current.values()) {
            sender.abort();
        }
        activeStreamSendersRef.current.clear();
        addSystemMessage(`📁 You exited the local video`);
    }, [streamVideoUrl, addSystemMessage]);

    const handleRequestP2PStream = useCallback(async () => {
        if (!remoteLocalVideoMeta) return;
        const reqMsg = {
            type: 'p2p-stream-request',
            requester: username,
            fileName: remoteLocalVideoMeta.fileName,
            // On-demand streaming needs this page's service worker; otherwise the host sends the whole file
            supportsRange: await detectOnDemandStreaming(),
            timestamp: Date.now()
        };
        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(JSON.stringify(reqMsg));
                } catch (e) { }
            }
        }
        setStreamProgress({
            percent: 0,
            speedMBs: 0,
            receivedBytes: 0,
            totalBytes: remoteLocalVideoMeta.fileSize || 0,
            receivedChunksCount: 0,
            totalChunks: 0,
            fileName: remoteLocalVideoMeta.fileName,
            isReady: false
        });
        addSystemMessage(`📡 Requesting direct P2P video stream from peer...`);
        showToast(`Requesting video stream...`);
    }, [remoteLocalVideoMeta, username, addSystemMessage, showToast]);

    const handleCancelP2PStream = useCallback(() => {
        if (streamReceiverRef.current) {
            streamReceiverRef.current.abort();
            streamReceiverRef.current = null;
        }
        if (streamVideoUrl) {
            try { URL.revokeObjectURL(streamVideoUrl); } catch (e) { }
            setStreamVideoUrl(null);
        }
        setStreamProgress(null);
        for (const peer of peersRef.current.values()) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(JSON.stringify({
                        type: 'p2p-stream-cancel',
                        timestamp: Date.now()
                    }));
                } catch (e) { }
            }
        }
        addSystemMessage(`Cancelled P2P stream`);
        showToast(`Stream cancelled`);
    }, [streamVideoUrl, addSystemMessage, showToast]);

    const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta || streamVideoUrl);

    const handleExitVideo = useCallback(() => {
        if (localVideoFile || remoteLocalVideoMeta || streamVideoUrl) {
            handleCloseLocalVideo();
            handleBroadcastAction('close', { type: 'local-video-action' });
        } else if (activeVideoId) {
            handleVideoChange(null);
            handleBroadcastAction('close', {});
        }
    }, [localVideoFile, remoteLocalVideoMeta, streamVideoUrl, activeVideoId, handleCloseLocalVideo, handleVideoChange, handleBroadcastAction]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (isTypingInField(e)) return;

            // 1. Push-to-Talk key handler
            if (audioSettings.inputMode === 'ptt' && matchesPttKey(e, audioSettings.pttKey)) {
                if (e.code === 'Space') {
                    e.preventDefault();
                }
                if (e.repeat) return;

                if (pttReleaseTimerRef.current) {
                    clearTimeout(pttReleaseTimerRef.current);
                    pttReleaseTimerRef.current = null;
                }

                if (!isPttActiveRef.current) {
                    isPttActiveRef.current = true;
                    setIsPttActive(true);
                    if (audioSettings.pttChime) {
                        sound.playPttOn();
                    }
                    setMicrophoneMuted(false, true);
                }
            } else if (audioSettings.inputMode === 'open' && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.altKey && !e.metaKey) {
                // 'M' shortcut to toggle microphone mute in Open Mic mode (when not playing local video)
                if (!localVideoFile && !streamVideoUrl && !remoteLocalVideoMeta) {
                    e.preventDefault();
                    toggleMicrophone();
                }
            } else if (roomId && (e.code === 'KeyQ' || e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.altKey && !e.metaKey) {
                // Feature 4.3: 'Q' shortcut to show Mobile Join QR Code
                if (!localVideoFile && !streamVideoUrl && !remoteLocalVideoMeta) {
                    e.preventDefault();
                    setShowQrModal(true);
                }
            }
        };

        const handleKeyUp = (e) => {
            if (audioSettings.inputMode === 'ptt' && matchesPttKey(e, audioSettings.pttKey)) {
                if (e.code === 'Space') {
                    e.preventDefault();
                }

                if (isPttActiveRef.current) {
                    const delay = Math.max(0, audioSettings.pttReleaseDelay || 0);
                    if (delay > 0) {
                        if (pttReleaseTimerRef.current) {
                            clearTimeout(pttReleaseTimerRef.current);
                        }
                        pttReleaseTimerRef.current = setTimeout(() => {
                            isPttActiveRef.current = false;
                            setIsPttActive(false);
                            if (audioSettings.pttChime) {
                                sound.playPttOff();
                            }
                            setMicrophoneMuted(true, true);
                            pttReleaseTimerRef.current = null;
                        }, delay);
                    } else {
                        isPttActiveRef.current = false;
                        setIsPttActive(false);
                        if (audioSettings.pttChime) {
                            sound.playPttOff();
                        }
                        setMicrophoneMuted(true, true);
                    }
                }
            }
        };

        const handleBlur = () => {
            if (isPttActiveRef.current) {
                if (pttReleaseTimerRef.current) {
                    clearTimeout(pttReleaseTimerRef.current);
                    pttReleaseTimerRef.current = null;
                }
                isPttActiveRef.current = false;
                setIsPttActive(false);
                if (audioSettings.pttChime) {
                    sound.playPttOff();
                }
                setMicrophoneMuted(true, true);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, [audioSettings, localVideoFile, remoteLocalVideoMeta, setMicrophoneMuted, streamVideoUrl, toggleMicrophone]);

    const connectedPeers = useMemo(() => {
        const list = [];
        for (const [peerId, entry] of peersRef.current.entries()) {
            if (entry.isConnected || entry.dataChannel?.readyState === 'open') {
                const meta = peerMetadata[peerId] || {};
                const voiceState = peerVoiceStates[meta.username] || {};
                const act = peerAudioActivity[peerId] || { isSpeaking: false, level: 0 };
                const vol = peerVolumes[peerId] !== undefined ? peerVolumes[peerId] : 1.0;
                const isLocalMuted = Boolean(localMutedPeers[peerId]);

                list.push({
                    id: peerId,
                    peerId,
                    username: meta.username || `Peer ${peerId.slice(0, 4)}`,
                    isHost: Boolean(meta.isHost),
                    isMuted: meta.isMuted !== undefined ? meta.isMuted : (voiceState.isMuted !== undefined ? voiceState.isMuted : true),
                    isSpeaking: act.isSpeaking,
                    audioLevel: act.level,
                    volume: vol,
                    isLocalMuted
                });
            }
        }
        return list;
    }, [peerMetadata, peerVoiceStates, peerAudioActivity, peerVolumes, localMutedPeers, peerCount, isP2PConnected]);

    const localUser = useMemo(() => {
        if (!roomId) return null;
        return {
            id: peerIdRef.current,
            peerId: peerIdRef.current,
            username: username,
            isHost: isHost,
            isMuted: isMicMuted,
            isSpeaking: localAudioActivity.isSpeaking,
            audioLevel: localAudioActivity.level,
            isSelf: true
        };
    }, [roomId, username, isHost, isMicMuted, localAudioActivity]);

    return (
        <div className="app-container">
            <div className="app-main-pane">
                <Header
                    isLive={Boolean(roomId)}
                    roomId={roomId}
                    onCopyRoom={handleCopyRoom}
                    isMicMuted={isMicMuted}
                    isAudioBlocked={isAudioBlocked}
                    onToggleMic={toggleMicrophone}
                    onToggleBlockAudio={toggleBlockAudio}
                    isP2PConnected={isP2PConnected}
                    p2pStatusText={p2pStatusText}
                    isMediaActive={isMediaActive}
                    onExitVideo={handleExitVideo}
                    onLeaveRoom={handleLeaveRoom}
                    isChatOpen={isChatOpen}
                    unreadChatCount={unreadChatCount}
                    onToggleChat={() => setIsChatOpen((prev) => !prev)}
                    audioSettings={audioSettings}
                    onOpenAudioSettings={() => setShowAudioSettingsModal(true)}
                    isPttActive={isPttActive}
                    peerCount={connectedPeers.length + 1}
                    onOpenSettings={() => setShowSettingsModal(true)}
                    networkStats={networkStats}
                    onOpenNetworkHud={() => setShowNetworkHudModal(true)}
                    onOpenQrCode={() => setShowQrModal(true)}
                />

                <main className="main-container">
                    <Stage
                        roomId={roomId}
                        isHost={isHost}
                        peerCount={peerCount}
                        isP2PConnected={isP2PConnected}
                        p2pStatusText={p2pStatusText}
                        onOpenCreate={() => setShowCreateModal(true)}
                        onOpenJoin={() => {
                            setInitialJoinPin('');
                            setShowJoinModal(true);
                        }}
                        onCopyRoom={handleCopyRoom}
                        onLeaveRoom={handleLeaveRoom}
                        onToggleChat={() => setIsChatOpen((prev) => !prev)}
                        isChatOpen={isChatOpen}
                        unreadChatCount={unreadChatCount}
                        chatCount={unreadChatCount}
                        activeVideoId={activeVideoId}
                        activeVideoTitle={activeVideoTitle}
                        onVideoChange={handleVideoChange}
                        localVideoFile={localVideoFile}
                        remoteLocalVideoMeta={remoteLocalVideoMeta}
                        onLocalFileSelect={handleLocalFileSelect}
                        onCloseLocalVideo={handleCloseLocalVideo}
                        onBroadcastAction={handleBroadcastAction}
                        remoteAction={remoteAction}
                        onRegisterStateGetter={(getter) => {
                            syncStateGetterRef.current = getter;
                        }}
                        streamProgress={streamProgress}
                        streamVideoUrl={streamVideoUrl}
                        onRequestP2PStream={handleRequestP2PStream}
                        onCancelP2PStream={handleCancelP2PStream}
                        isMicMuted={isMicMuted}
                        isAudioBlocked={isAudioBlocked}
                        onToggleMic={toggleMicrophone}
                        onToggleBlockAudio={toggleBlockAudio}
                        peerVoiceStates={peerVoiceStates}
                        queue={queue}
                        onAddToQueue={handleAddToQueue}
                        onPlayNextInQueue={handlePlayNextInQueue}
                        onVoteSkip={handleVoteSkip}
                        skipVotes={skipVotes}
                        onOpenQueue={handleOpenQueue}
                        username={username}
                        floatingReactions={floatingReactions}
                        onSendReaction={handleSendReaction}
                        connectedPeers={connectedPeers}
                        localUser={localUser}
                        onSetPeerVolume={handleSetPeerVolume}
                        onToggleMutePeer={handleToggleMutePeer}
                        audioSettings={audioSettings}
                        onOpenAudioSettings={() => setShowAudioSettingsModal(true)}
                        isPttActive={isPttActive}
                        onPttPressStart={handlePttPressStart}
                        onPttPressEnd={handlePttPressEnd}
                        soundboardSettings={soundboardSettings}
                        activeSoundboardSfx={activeSoundboardSfx}
                        activeSfxCooldowns={activeSfxCooldowns}
                        onPlaySoundboardClip={handlePlaySoundboardClip}
                        onSoundboardVolumeChange={handleSoundboardVolumeChange}
                        onToggleSoundboardMute={handleToggleSoundboardMute}
                        networkStats={networkStats}
                        onOpenNetworkHud={() => setShowNetworkHudModal(true)}
                        onOpenQrCode={() => setShowQrModal(true)}
                    />
                </main>
            </div>

            <LiveChat
                messages={messages}
                systemLogs={systemLogs}
                onSendMessage={handleSendMessage}
                onSendImage={handleSendImage}
                onClearLogs={handleClearLogs}
                onTestSound={handleTestSound}
                isP2PConnected={isP2PConnected}
                username={username}
                isOpen={isChatOpen}
                onClose={() => setIsChatOpen(false)}
                isAudioBlocked={isAudioBlocked}
                onToggleBlockAudio={toggleBlockAudio}
                signalStatus={signalStatus}
                onOpenSettings={() => setShowSettingsModal(true)}
                queue={queue}
                activeVideoId={activeVideoId}
                activeVideoTitle={activeVideoTitle}
                onAddToQueue={handleAddToQueue}
                onRemoveFromQueue={handleRemoveFromQueue}
                onReorderQueue={handleReorderQueue}
                onClearQueue={handleClearQueue}
                onPlayQueueItem={handlePlayQueueItem}
                onPlayNextInQueue={handlePlayNextInQueue}
                onVoteSkip={handleVoteSkip}
                skipVotes={skipVotes}
                peerCount={peerCount}
                activeTab={sidebarTab}
                onTabChange={setSidebarTab}
                onSendReaction={handleSendReaction}
                connectedPeers={connectedPeers}
                localUser={localUser}
                onSetPeerVolume={handleSetPeerVolume}
                onToggleMutePeer={handleToggleMutePeer}
                onToggleMic={toggleMicrophone}
                roomId={roomId}
                onCopyRoom={handleCopyRoom}
                audioSettings={audioSettings}
                onUpdateAudioSettings={handleUpdateAudioSettings}
                onOpenAudioSettings={() => setShowAudioSettingsModal(true)}
                isPttActive={isPttActive}
                onPttPressStart={handlePttPressStart}
                onPttPressEnd={handlePttPressEnd}
                soundboardSettings={soundboardSettings}
                activeSoundboardSfx={activeSoundboardSfx}
                activeSfxCooldowns={activeSfxCooldowns}
                onPlaySoundboardClip={handlePlaySoundboardClip}
                onSoundboardVolumeChange={handleSoundboardVolumeChange}
                onToggleSoundboardMute={handleToggleSoundboardMute}
                onOpenQrCode={() => setShowQrModal(true)}
            />

            {/* Floating Push-to-Talk HUD Indicator */}
            {isPttActive && (
                <div className="ptt-floating-hud">
                    <div className="ptt-hud-icon-wrap">
                        <span className="ptt-hud-wave-ring" />
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="#22c55e">
                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z" />
                        </svg>
                    </div>
                    <div className="ptt-hud-details">
                        <span className="ptt-hud-title">TRANSMITTING VOICE</span>
                        <span className="ptt-hud-subtitle">Release [{audioSettings?.pttKeyLabel || 'Space'}] or mouse to mute</span>
                    </div>
                    <div className="ptt-hud-equalizer">
                        <span className="ptt-eq-bar bar-1" />
                        <span className="ptt-eq-bar bar-2" />
                        <span className="ptt-eq-bar bar-3" />
                        <span className="ptt-eq-bar bar-4" />
                    </div>
                </div>
            )}

            {/* Modals */}
            <CreateRoomModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onConfirm={handleConfirmCreate}
                currentUsername={username}
            />

            <JoinRoomModal
                isOpen={showJoinModal}
                onClose={() => setShowJoinModal(false)}
                onConfirm={handleConfirmJoin}
                currentUsername={username}
                initialPin={initialJoinPin}
            />

            <ServerSettingsModal
                isOpen={showSettingsModal}
                onClose={() => setShowSettingsModal(false)}
                currentUrl={signalUrl}
                onApply={handleApplyServer}
            />

            <AudioSettingsModal
                isOpen={showAudioSettingsModal}
                onClose={() => setShowAudioSettingsModal(false)}
                audioSettings={audioSettings}
                onUpdateAudioSettings={handleUpdateAudioSettings}
                localAudioLevel={localAudioActivity.level}
                isMicMuted={isMicMuted}
                isPttActive={isPttActive}
                voiceIsolationSupported={isVoiceIsolationSupported() || micPipeline.isolationSupported}
                voiceIsolationStatus={voiceIsolationStatus}
            />

            {/* Feature 4.1: Real-Time P2P Network HUD Modal */}
            <NetworkDiagnosticsModal
                isOpen={showNetworkHudModal}
                onClose={() => setShowNetworkHudModal(false)}
                networkStats={networkStats}
                peersStats={peersNetworkStats}
                roomId={roomId}
                username={username}
                onTriggerPing={handleTriggerPing}
            />

            {/* Feature 4.3: QR Code for Instant Mobile Join Modal */}
            <QrCodeModal
                isOpen={showQrModal}
                onClose={() => setShowQrModal(false)}
                roomId={roomId}
                username={username}
            />

            {/* Toast Notification */}
            {toastMessage && <div className="toast">{toastMessage}</div>}
        </div>
    );
}