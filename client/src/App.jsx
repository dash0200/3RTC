import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from './components/Header';
import Stage from './components/Stage';
import LiveChat from './components/LiveChat';
import CreateRoomModal from './components/CreateRoomModal';
import JoinRoomModal from './components/JoinRoomModal';
import ServerSettingsModal from './components/ServerSettingsModal';
import { fetchYouTubeTitle } from './components/YouTubeSyncPlayer';
import { sound } from './utils/sound';
import { copyToClipboard } from './utils/clipboard';
import { P2PStreamSender, P2PStreamReceiver } from './utils/p2pStreamer';
import './App.css';

const DEFAULT_SIGNAL_URL = 'wss://34.57.36.145.sslip.io:443';
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

const IS_LOCAL = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]' ||
    Boolean(import.meta.env?.DEV)
);

function extractAudioSdp(sdp) {
    if (!sdp) return 'none';
    const lines = sdp.split('\n');
    const audioIndex = lines.findIndex((l) => l.startsWith('m=audio'));
    if (audioIndex === -1) return 'no m=audio';
    const audioBlock = [];
    for (let i = audioIndex; i < Math.min(lines.length, audioIndex + 15); i++) {
        const line = lines[i].trim();
        if (i > audioIndex && line.startsWith('m=')) break;
        if (line.startsWith('m=audio') || line.startsWith('a=sendrecv') || line.startsWith('a=recvonly') || line.startsWith('a=sendonly') || line.startsWith('a=inactive') || line.startsWith('a=mid')) {
            audioBlock.push(line);
        }
    }
    return audioBlock.join(' | ');
}

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
    const [initialJoinPin, setInitialJoinPin] = useState('');
    const [toastMessage, setToastMessage] = useState('');

    // WebRTC Voice Chat State
    const [isMicMuted, setIsMicMuted] = useState(true);
    const [isAudioBlocked, setIsAudioBlocked] = useState(false);
    const [peerVoiceStates, setPeerVoiceStates] = useState({});

    // Feature 2.1: Per-Peer Volume Sliders & Speaking Rings State
    const [peerVolumes, setPeerVolumes] = useState({}); // { [peerId]: number (0.0 to 2.0) }
    const [localMutedPeers, setLocalMutedPeers] = useState({}); // { [peerId]: boolean }
    const [peerAudioActivity, setPeerAudioActivity] = useState({}); // { [peerId]: { isSpeaking: boolean, level: number } }
    const [localAudioActivity, setLocalAudioActivity] = useState({ isSpeaking: false, level: 0 });
    const [peerMetadata, setPeerMetadata] = useState({}); // { [peerId]: { username: string, isHost: boolean, isMuted: boolean } }

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

    const localStreamRef = useRef(null);
    const isMicMutedRef = useRef(true);
    const isAudioBlockedRef = useRef(false);
    const peerVolumesRef = useRef({});
    const localMutedPeersRef = useRef({});
    const localAnalyserRef = useRef(null);
    const localSourceNodeRef = useRef(null);

    currentRoomRef.current = roomId;
    isHostRef.current = isHost;
    activeVideoIdRef.current = activeVideoId;
    isMicMutedRef.current = isMicMuted;
    isAudioBlockedRef.current = isAudioBlocked;
    peerVolumesRef.current = peerVolumes;
    localMutedPeersRef.current = localMutedPeers;

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
            try {
                if (entry.audioElement) {
                    entry.audioElement.pause();
                    entry.audioElement.srcObject = null;
                    try { entry.audioElement.remove(); } catch { }
                    entry.audioElement = null;
                }
            } catch { }
            try {
                if (entry.webAudioSource) {
                    entry.webAudioSource.disconnect();
                    entry.webAudioSource = null;
                }
            } catch { }
            try {
                if (entry.webAudioGain) {
                    entry.webAudioGain.disconnect();
                    entry.webAudioGain = null;
                }
            } catch { }
            try {
                if (entry.analyserNode) {
                    entry.analyserNode.disconnect();
                    entry.analyserNode = null;
                }
            } catch { }
            try { entry.dataChannel?.close(); } catch { }
            try { entry.pc?.close(); } catch { }
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
        for (const [peerId, entry] of peersRef.current.entries()) {
            try {
                if (entry.audioElement) {
                    entry.audioElement.pause();
                    entry.audioElement.srcObject = null;
                    try { entry.audioElement.remove(); } catch { }
                    entry.audioElement = null;
                }
            } catch { }
            try {
                if (entry.webAudioSource) {
                    entry.webAudioSource.disconnect();
                    entry.webAudioSource = null;
                }
            } catch { }
            try {
                if (entry.webAudioGain) {
                    entry.webAudioGain.disconnect();
                    entry.webAudioGain = null;
                }
            } catch { }
            try {
                if (entry.analyserNode) {
                    entry.analyserNode.disconnect();
                    entry.analyserNode = null;
                }
            } catch { }
            try { entry.dataChannel?.close(); } catch { }
            try { entry.pc?.close(); } catch { }
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

    // Create or get peer connection in mesh
    const getOrCreatePeerConnection = useCallback((targetPeerId, isInitiator) => {
        if (peersRef.current.has(targetPeerId)) {
            return peersRef.current.get(targetPeerId);
        }

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const peerEntry = {
            pc,
            dataChannel: null,
            isConnected: false,
            candidateQueue: [],
            audioElement: null
        };
        peersRef.current.set(targetPeerId, peerEntry);

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
                    const audioTrack = localStreamRef.current.getAudioTracks()[0];
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

        // Handle incoming audio stream from remote peer
        pc.ontrack = (event) => {

            // 1. Audio Element Pipeline (Offscreen layout instead of display:none to prevent Chrome background throttling)
            let audioEl = peerEntry.audioElement;
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = `remote-audio-${targetPeerId}`;
                audioEl.autoplay = true;
                audioEl.playsInline = true;
                audioEl.style.position = 'fixed';
                audioEl.style.left = '-9999px';
                audioEl.style.top = '-9999px';
                audioEl.style.width = '1px';
                audioEl.style.height = '1px';
                audioEl.style.opacity = '0.01';
                document.body.appendChild(audioEl);
                peerEntry.audioElement = audioEl;
            }

            const remoteStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
            const isLocalMutedInit = Boolean(localMutedPeersRef.current[targetPeerId]);
            const peerVolInit = peerVolumesRef.current[targetPeerId] !== undefined ? peerVolumesRef.current[targetPeerId] : 1.0;
            const effectiveInit = isAudioBlockedRef.current || isLocalMutedInit ? 0 : peerVolInit;

            audioEl.srcObject = remoteStream;
            audioEl.muted = effectiveInit === 0;
            audioEl.volume = Math.min(1.0, effectiveInit);
            if (typeof audioEl.setSinkId === 'function') {
                audioEl.setSinkId('').catch(() => { });
            }

            // 2. Direct Web Audio API Pipeline (Routes directly to system audio hardware, bypassing Chromium MediaElement sink bugs)
            const connectWebAudioPipeline = (stream) => {
                try {
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    if (!AudioContextClass) return;
                    if (!window.__webrtcAudioCtx) {
                        window.__webrtcAudioCtx = new AudioContextClass();
                    }
                    const ctx = window.__webrtcAudioCtx;
                    if (ctx.state === 'suspended') {
                        ctx.resume().catch(() => { });
                    }

                    if (peerEntry.webAudioSource) {
                        try { peerEntry.webAudioSource.disconnect(); } catch { }
                    }
                    if (peerEntry.webAudioGain) {
                        try { peerEntry.webAudioGain.disconnect(); } catch { }
                    }
                    if (peerEntry.analyserNode) {
                        try { peerEntry.analyserNode.disconnect(); } catch { }
                    }

                    const srcNode = ctx.createMediaStreamSource(stream);
                    const gainNode = ctx.createGain();
                    const analyserNode = ctx.createAnalyser();
                    analyserNode.fftSize = 256;
                    analyserNode.smoothingTimeConstant = 0.5;

                    const isLocalMuted = Boolean(localMutedPeersRef.current[targetPeerId]);
                    const currentVol = peerVolumesRef.current[targetPeerId] !== undefined ? peerVolumesRef.current[targetPeerId] : 1.0;
                    const effectiveGain = isAudioBlockedRef.current || isLocalMuted ? 0 : currentVol;

                    gainNode.gain.value = effectiveGain;
                    srcNode.connect(gainNode);
                    gainNode.connect(ctx.destination);

                    // Connect to analyser for Voice Activity Detection (Speaking Rings & VU meter)
                    srcNode.connect(analyserNode);

                    peerEntry.webAudioSource = srcNode;
                    peerEntry.webAudioGain = gainNode;
                    peerEntry.analyserNode = analyserNode;
                    logLocalDebug('WEBAUDIO_ROUTED', `Peer: ${targetPeerId} -> Web Audio route connected (ctx: ${ctx.state}, gain: ${effectiveGain})`);
                } catch (err) {
                    logLocalDebug('WEBAUDIO_ERR', `AudioContext route error: ${err.message}`);
                }
            };

            connectWebAudioPipeline(remoteStream);

            // Handle when remote sender un-mutes and RTP packets arrive
            event.track.onunmute = () => {
                if (peerEntry.audioElement && !isAudioBlockedRef.current) {
                    const freshStream = new MediaStream([event.track]);
                    peerEntry.audioElement.srcObject = freshStream;
                    peerEntry.audioElement.play().then(() => {
                        logLocalDebug('PLAY_ON_UNMUTE_OK', `Peer: ${targetPeerId} audio is actively playing!`);
                    }).catch((err) => {
                        logLocalDebug('PLAY_ON_UNMUTE_ERR', `Peer: ${targetPeerId} - ${err.name}: ${err.message}`);
                    });
                    connectWebAudioPipeline(freshStream);
                }
            };

            event.track.onmute = () => {
                logLocalDebug('TRACK_ONMUTE', `Peer: ${targetPeerId} - Incoming audio track muted`);
            };

            const playPromise = audioEl.play();
            if (playPromise !== undefined) {
                playPromise.then(() => {
                    logLocalDebug('INITIAL_PLAY_OK', `Peer: ${targetPeerId} audio element playing (paused: ${audioEl.paused})`);
                }).catch((err) => {
                    logLocalDebug('INITIAL_PLAY_BLOCKED', `Peer: ${targetPeerId} Autoplay blocked (${err.name}): ${err.message}`);
                    const resumeOnInteraction = () => {
                        if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
                            window.__webrtcAudioCtx.resume().catch(() => { });
                        }
                        if (peerEntry.audioElement && !isAudioBlockedRef.current) {
                            peerEntry.audioElement.play().then(() => {
                                logLocalDebug('RESUME_PLAY_OK', `Peer: ${targetPeerId} audio playback resumed on user gesture!`);
                            }).catch((e) => {
                                logLocalDebug('RESUME_PLAY_ERR', `Peer: ${targetPeerId} resume failed: ${e.name} - ${e.message}`);
                            });
                        }
                        window.removeEventListener('click', resumeOnInteraction);
                        window.removeEventListener('keydown', resumeOnInteraction);
                        window.removeEventListener('touchstart', resumeOnInteraction);
                    };
                    window.addEventListener('click', resumeOnInteraction);
                    window.addEventListener('keydown', resumeOnInteraction);
                    window.addEventListener('touchstart', resumeOnInteraction);
                });
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal({
                    type: 'ice-candidate',
                    targetId: targetPeerId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                peerEntry.isConnected = false;
                updateP2PStatus();
            }
        };

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

            dc.onmessage = async (event) => {
                // Binary Chunk over WebRTC DataChannel (Feature 1.4: P2P Video Streaming)
                if (event.data instanceof ArrayBuffer) {
                    if (streamReceiverRef.current) {
                        streamReceiverRef.current.handleChunk(event.data);
                    }
                    return;
                } else if (event.data instanceof Blob) {
                    try {
                        const buf = await event.data.arrayBuffer();
                        if (streamReceiverRef.current) {
                            streamReceiverRef.current.handleChunk(buf);
                        }
                    } catch (e) { }
                    return;
                }

                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'peer-identity') {
                        setPeerMetadata((prev) => ({
                            ...prev,
                            [targetPeerId]: {
                                username: data.username || `User_${targetPeerId.slice(0, 4)}`,
                                isHost: Boolean(data.isHost),
                                isMuted: Boolean(data.isMuted)
                            }
                        }));
                        if (!data.isReply) {
                            try {
                                dc.send(JSON.stringify({
                                    type: 'peer-identity',
                                    peerId: peerIdRef.current,
                                    username: username,
                                    isHost: isHostRef.current,
                                    isMuted: isMicMutedRef.current,
                                    isReply: true
                                }));
                            } catch (e) { }
                        }
                    } else if (data.type === 'chat') {
                        setMessages((prev) => [...prev, { ...data, isSelf: false }]);
                        sound.playPop();
                    } else if (data.type === 'peer-voice-status') {
                        setPeerVoiceStates((prev) => ({
                            ...prev,
                            [data.sender]: { isMuted: data.isMuted }
                        }));
                        setPeerMetadata((prev) => ({
                            ...prev,
                            [targetPeerId]: {
                                ...(prev[targetPeerId] || {}),
                                username: data.sender || prev[targetPeerId]?.username || `User_${targetPeerId.slice(0, 4)}`,
                                isMuted: data.isMuted
                            }
                        }));
                        // When remote peer un-mutes, ensure their audio element is actively playing
                        if (!data.isMuted) {
                            for (const peer of peersRef.current.values()) {
                                if (peer.audioElement && !isAudioBlockedRef.current) {
                                    peer.audioElement.play().catch(() => { });
                                }
                            }
                        }
                    } else if (data.type === 'yt-action') {
                        handleRemoteYouTubeAction(data);
                    } else if (data.type === 'local-video-action') {
                        handleRemoteLocalVideoAction(data);
                    } else if (data.type === 'queue-action') {
                        handleRemoteQueueAction(data);
                    } else if (data.type === 'reaction') {
                        handleRemoteReaction(data);
                    } else if (data.type === 'p2p-stream-request') {
                        // Remote peer requests to stream the local video file
                        if (localVideoFileRef.current && peerEntry.dataChannel) {
                            addSystemMessage(`📡 Peer "${data.requester || 'User'}" requested video stream. Slicing and streaming chunks...`);
                            showToast(`Streaming video to ${data.requester || 'peer'}...`);

                            const sender = new P2PStreamSender(localVideoFileRef.current, peerEntry.dataChannel, {
                                targetPeerId,
                                senderName: username,
                                onProgress: () => { },
                                onComplete: (info) => {
                                    addSystemMessage(`✅ Completed streaming video chunks to ${data.requester || 'peer'} (${(info.totalBytes / (1024 * 1024)).toFixed(1)} MB in ${info.durationSec.toFixed(1)}s)`);
                                    showToast(`Stream transfer complete!`);
                                },
                                onError: (err) => {
                                    addSystemMessage(`❌ Stream transfer error: ${err.message}`);
                                }
                            });
                            activeStreamSendersRef.current.set(targetPeerId, sender);
                            sender.start();
                        }
                    } else if (data.type === 'p2p-stream-header') {
                        // Incoming P2P video stream header
                        addSystemMessage(`📡 Receiving video stream from ${data.sender || 'Peer'}: "${data.fileName}" (${(data.fileSize / (1024 * 1024)).toFixed(1)} MB)`);
                        showToast(`Streaming "${data.fileName}"...`);

                        if (streamReceiverRef.current) {
                            streamReceiverRef.current.abort();
                        }

                        const receiver = new P2PStreamReceiver(data, {
                            onReady: (blobUrl, meta) => {
                                setStreamVideoUrl(blobUrl);
                                setStreamProgress((prev) => ({
                                    ...(prev || {}),
                                    isReady: true,
                                    percent: meta.percent
                                }));
                            },
                            onProgress: (prog) => {
                                setStreamProgress((prev) => ({
                                    ...(prev || {}),
                                    ...prog
                                }));
                            },
                            onComplete: (blobUrl, meta) => {
                                setStreamVideoUrl(blobUrl);
                                setStreamProgress((prev) => ({
                                    ...(prev || {}),
                                    percent: 100,
                                    isReady: true,
                                    isCompleted: true
                                }));
                                addSystemMessage(`✅ Video stream fully buffered (${(meta.fileSize / (1024 * 1024)).toFixed(1)} MB). Ready to play!`);
                                showToast(`Stream ready to play!`);
                            },
                            onError: (err) => {
                                addSystemMessage(`❌ Video stream error: ${err.message}`);
                                showToast(`Stream error: ${err.message}`);
                            }
                        });
                        streamReceiverRef.current = receiver;
                        setStreamProgress({
                            percent: 0,
                            speedMBs: 0,
                            receivedBytes: 0,
                            totalBytes: data.fileSize,
                            receivedChunksCount: 0,
                            totalChunks: data.totalChunks,
                            fileName: data.fileName,
                            isReady: false
                        });
                    } else if (data.type === 'p2p-stream-complete') {
                        if (streamReceiverRef.current) {
                            streamReceiverRef.current.handleComplete();
                        }
                    } else if (data.type === 'p2p-stream-cancel') {
                        if (activeStreamSendersRef.current.has(targetPeerId)) {
                            activeStreamSendersRef.current.get(targetPeerId).abort();
                            activeStreamSendersRef.current.delete(targetPeerId);
                        }
                        if (streamReceiverRef.current) {
                            streamReceiverRef.current.abort();
                            streamReceiverRef.current = null;
                            setStreamProgress(null);
                        }
                    } else if (data.type === 'yt-request-sync') {
                        // A newly joined peer is asking for the current playing media & timestamp
                        let hasSent = false;
                        if (syncStateGetterRef.current) {
                            const state = syncStateGetterRef.current();
                            if (state) {
                                if (state.mediaType === 'local' && state.fileName) {
                                    dc.send(JSON.stringify({
                                        type: 'local-video-sync-state',
                                        ...state,
                                        sender: username
                                    }));
                                    hasSent = true;
                                } else if (state.videoId) {
                                    dc.send(JSON.stringify({
                                        type: 'yt-sync-state',
                                        ...state,
                                        queue: queueRef.current,
                                        skipVotes: skipVotesRef.current,
                                        activeVideoTitle: activeVideoTitleRef.current,
                                        sender: username
                                    }));
                                    hasSent = true;
                                }
                            }
                        }
                        if (!hasSent && localVideoFileRef.current) {
                            dc.send(JSON.stringify({
                                type: 'local-video-sync-state',
                                mediaType: 'local',
                                fileName: localVideoFileRef.current.name,
                                fileSize: localVideoFileRef.current.size,
                                currentTime: 0,
                                isPlaying: false,
                                sender: username
                            }));
                        }
                    } else if (data.type === 'yt-sync-state') {
                        // Received sync state from an existing peer in the room
                        if (data.videoId) {
                            setLocalVideoFile(null);
                            setRemoteLocalVideoMeta(null);
                            setActiveVideoId(data.videoId);
                            if (data.activeVideoTitle) {
                                setActiveVideoTitle(data.activeVideoTitle);
                            }
                            if (Array.isArray(data.queue)) {
                                setQueue(data.queue);
                                queueRef.current = data.queue;
                            }
                            if (Array.isArray(data.skipVotes)) {
                                setSkipVotes(data.skipVotes);
                                skipVotesRef.current = data.skipVotes;
                            }
                            setRemoteAction({
                                action: data.isPlaying ? 'play' : 'pause',
                                currentTime: data.currentTime,
                                newVideoId: data.videoId
                            });
                            addSystemMessage(`🔄 Synced YouTube playback & queue with room`);
                        }
                    } else if (data.type === 'local-video-sync-state') {
                        if (data.fileName) {
                            setActiveVideoId(null);
                            setRemoteLocalVideoMeta({
                                fileName: data.fileName,
                                fileSize: data.fileSize,
                                sender: data.sender
                            });
                            setRemoteAction({
                                action: data.isPlaying ? 'play' : 'pause',
                                currentTime: data.currentTime,
                                fileName: data.fileName,
                                sender: data.sender,
                                subtitleInfo: data.subtitleInfo
                            });
                            addSystemMessage(`🔄 Synced with room's local video session: "${data.fileName}"`);
                        }
                    }
                } catch (e) { }
            };

            dc.onclose = () => {
                if (activeStreamSendersRef.current.has(targetPeerId)) {
                    activeStreamSendersRef.current.get(targetPeerId).abort();
                    activeStreamSendersRef.current.delete(targetPeerId);
                }
                peerEntry.isConnected = false;
                updateP2PStatus();
            };

            dc.onerror = () => { };
        };

        if (isInitiator) {
            try {
                const dc = pc.createDataChannel(`chat-${targetPeerId}`, { ordered: true });
                bindDataChannel(dc);

                pc.createOffer().then((offer) => {
                    return pc.setLocalDescription(offer).then(() => {
                        const audioSdp = extractAudioSdp(offer.sdp);
                        const tInfo = pc.getTransceivers ? pc.getTransceivers().map(t => `${t.mid || 'pending'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                        logLocalDebug('OFFER_SENT', `To: ${targetPeerId} | SDP: ${audioSdp} | Transceivers: ${tInfo}`);

                        sendSignal({
                            type: 'offer',
                            targetId: targetPeerId,
                            offer: {
                                type: offer.type,
                                sdp: offer.sdp
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
    }, [addSystemMessage, handleRemoteYouTubeAction, handleRemoteLocalVideoAction, handleRemoteQueueAction, handleRemoteReaction, logLocalDebug, sendSignal, showToast, updateP2PStatus, username]);

    // Handle incoming signaling messages
    const handleSignalingMessage = useCallback(async (msg) => {
        switch (msg.type) {
            case 'room-created': {
                setRoomId(msg.roomId);
                setIsHost(true);
                isHostRef.current = true;
                setPeerCount(1);
                setP2pStatusText('Waiting for peer to enter 5-digit code...');
                addSystemMessage(`You created room ${msg.roomId} as "${username}".`);
                showToast(`Created room ${msg.roomId}`);
                break;
            }

            case 'joined': {
                setRoomId(msg.roomId);
                setIsHost(false);
                isHostRef.current = false;
                const count = (msg.peers ? msg.peers.length : 0) + 1;
                setPeerCount(count);
                addSystemMessage(`You joined room ${msg.roomId} as "${username}".`);
                showToast(`Joined room ${msg.roomId}`);

                // Prepare receiver connections for each existing peer in the room
                if (msg.peers && msg.peers.length > 0) {
                    setP2pStatusText('Connecting direct P2P data channels...');
                    for (const peerId of msg.peers) {
                        getOrCreatePeerConnection(peerId, false);
                    }
                }
                break;
            }

            case 'peer-joined': {
                const newCount = peersRef.current.size + 2;
                setPeerCount(newCount);
                addSystemMessage(`A peer entered room ${currentRoomRef.current}. Establishing P2P connection...`);
                setP2pStatusText('Connecting direct P2P data channel...');
                // Existing peers initiate offer to the newcomer
                getOrCreatePeerConnection(msg.peerId, true);
                break;
            }

            case 'offer': {
                try {
                    const senderId = msg.from;
                    const peerEntry = getOrCreatePeerConnection(senderId, false);
                    const pc = peerEntry.pc;

                    const offerAudioSdp = extractAudioSdp(msg.offer?.sdp);
                    logLocalDebug('OFFER_RECEIVED', `From: ${senderId} | Offer SDP: ${offerAudioSdp}`);

                    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));

                    // Ensure the negotiated audio transceiver on the answerer is active and set to sendrecv
                    if (pc.getTransceivers) {
                        const allTransceivers = pc.getTransceivers();
                        for (const t of allTransceivers) {
                            const isValid = t.mid !== null || allTransceivers.length === 1;
                            if (isValid && (!t.receiver?.track || t.receiver.track.kind === 'audio' || t.sender?.track?.kind === 'audio')) {
                                t.direction = 'sendrecv';
                                if (localStreamRef.current && !isMicMutedRef.current && t.sender) {
                                    const audioTrack = localStreamRef.current.getAudioTracks()[0];
                                    if (audioTrack) {
                                        t.sender.replaceTrack(audioTrack).catch(() => { });
                                    }
                                }
                            }
                        }
                    }

                    // Flush queued candidates
                    while (peerEntry.candidateQueue.length > 0) {
                        const cand = peerEntry.candidateQueue.shift();
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(cand));
                        } catch { }
                    }

                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);

                    const answerAudioSdp = extractAudioSdp(answer.sdp);
                    const tInfo = pc.getTransceivers ? pc.getTransceivers().map(t => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                    logLocalDebug('ANSWER_SENT', `To: ${senderId} | Answer SDP: ${answerAudioSdp} | Transceivers: ${tInfo}`);

                    sendSignal({
                        type: 'answer',
                        targetId: senderId,
                        answer: {
                            type: answer.type,
                            sdp: answer.sdp
                        }
                    });
                } catch (err) {
                    logLocalDebug('OFFER_HANDLE_ERR', err.message);
                }
                break;
            }

            case 'answer': {
                try {
                    const senderId = msg.from;
                    const peerEntry = peersRef.current.get(senderId);
                    if (peerEntry && peerEntry.pc) {
                        const pc = peerEntry.pc;
                        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));

                        const answerAudioSdp = extractAudioSdp(msg.answer?.sdp);
                        const tInfo = pc.getTransceivers ? pc.getTransceivers().map(t => `${t.mid || 'mid?'}:${t.direction}->${t.currentDirection || 'none'}`).join(', ') : 'none';
                        logLocalDebug('ANSWER_PROCESSED', `From: ${senderId} | Answer SDP: ${answerAudioSdp} | Host Transceivers: ${tInfo}`);

                        while (peerEntry.candidateQueue.length > 0) {
                            const cand = peerEntry.candidateQueue.shift();
                            try {
                                await pc.addIceCandidate(new RTCIceCandidate(cand));
                            } catch { }
                        }
                    }
                } catch (err) {
                    logLocalDebug('ANSWER_HANDLE_ERR', err.message);
                }
                break;
            }

            case 'ice-candidate': {
                const senderId = msg.from;
                const peerEntry = peersRef.current.get(senderId);
                if (peerEntry && msg.candidate) {
                    const pc = peerEntry.pc;
                    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch { }
                    } else {
                        peerEntry.candidateQueue.push(msg.candidate);
                    }
                }
                break;
            }

            case 'peer-left': {
                cleanupPeer(msg.peerId);
                setPeerCount(peersRef.current.size + 1);
                addSystemMessage('A peer disconnected from the room.');
                break;
            }

            case 'error': {
                showToast(msg.message || 'Signaling error');
                break;
            }

            default:
                break;
        }
    }, [addSystemMessage, cleanupPeer, getOrCreatePeerConnection, logLocalDebug, sendSignal, showToast, username]);

    const handleSignalingMessageRef = useRef();
    handleSignalingMessageRef.current = handleSignalingMessage;

    // Connect to Signaling Server
    useEffect(() => {
        let isCancelled = false;
        let reconnectTimeout = null;
        let pingInterval = null;

        const safeCloseSocket = (socket) => {
            if (!socket) return;
            try {
                if (socket.readyState === WebSocket.CONNECTING) {
                    // Defer closing until open to avoid Chrome console error:
                    // "WebSocket is closed before the connection is established"
                    socket.onopen = () => {
                        try { socket.close(1000, 'Replaced or unmounted'); } catch { }
                    };
                    socket.onerror = () => { };
                    socket.onclose = () => { };
                } else if (socket.readyState === WebSocket.OPEN) {
                    socket.close(1000, 'Replaced or unmounted');
                }
            } catch { }
        };

        if (wsRef.current) {
            safeCloseSocket(wsRef.current);
            wsRef.current = null;
        }

        const isLocalServer = signalUrl.includes('localhost') || signalUrl.includes('127.0.0.1');
        const serverLabel = isLocalServer ? 'Local' : 'Cloud';

        const connect = () => {
            if (isCancelled) return;
            let hasOpened = false;

            setSignalStatus({ connected: false, label: 'Connecting...' });

            let ws;
            try {
                ws = new WebSocket(signalUrl);
                wsRef.current = ws;
            } catch (err) {
                if (isCancelled) return;
                setSignalStatus({ connected: false, label: 'Connection Failed' });
                showToast(`Failed to connect to ${signalUrl}`);
                return;
            }

            ws.onopen = () => {
                hasOpened = true;
                if (isCancelled) {
                    safeCloseSocket(ws);
                    return;
                }

                setSignalStatus({ connected: true, label: `${serverLabel} Connected` });
                showToast(`Connected to ${serverLabel} signaling`);

                // If previously inside a room before connection drop, re-announce
                if (currentRoomRef.current) {
                    const activeRoom = currentRoomRef.current;
                    addSystemMessage(`🔄 Reconnected to signaling. Resuming room ${activeRoom}...`);
                    if (isHostRef.current) {
                        ws.send(JSON.stringify({
                            type: 'create-room',
                            roomId: activeRoom,
                            peerId: peerIdRef.current
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'join',
                            roomId: activeRoom,
                            peerId: peerIdRef.current
                        }));
                    }
                }

                // Flush any queued signals
                while (pendingSignalsRef.current.length > 0) {
                    const data = pendingSignalsRef.current.shift();
                    ws.send(JSON.stringify(data));
                }

                // Start periodic ping to prevent reverse proxies (e.g. Caddy on GCP) from terminating idle connections
                clearInterval(pingInterval);
                pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'ping' }));
                        } catch { }
                    }
                }, 25000);
            };

            ws.onmessage = (event) => {
                if (isCancelled) return;
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'pong') return;
                    handleSignalingMessageRef.current?.(msg);
                } catch (err) { }
            };

            ws.onclose = (event) => {
                clearInterval(pingInterval);
                if (isCancelled) return;

                // If closed cleanly with code 1000 on intentional unmount, do not reconnect
                if (event.code === 1000) {
                    setSignalStatus({ connected: false, label: 'Disconnected' });
                    return;
                }

                setSignalStatus({ connected: false, label: 'Reconnecting...' });

                // Show friendly prompt if local dev server was selected but is not running
                if (isLocalServer && !hasOpened) {
                    showToast('Local server not reachable on port 8080. Start "node server.js" or switch to GCP Cloud Server.');
                }

                // Schedule auto-reconnect
                clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => {
                    if (!isCancelled) {
                        connect();
                    }
                }, 2500);
            };

            ws.onerror = () => {
                if (isCancelled) return;
                setSignalStatus({ connected: false, label: 'Signaling Error' });
            };
        };

        connect();

        return () => {
            isCancelled = true;
            clearTimeout(reconnectTimeout);
            clearInterval(pingInterval);
            if (wsRef.current) {
                safeCloseSocket(wsRef.current);
                wsRef.current = null;
            }
        };
    }, [signalUrl, showToast, addSystemMessage]);
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

    const handleRequestP2PStream = useCallback(() => {
        if (!remoteLocalVideoMeta) return;
        const reqMsg = {
            type: 'p2p-stream-request',
            requester: username,
            fileName: remoteLocalVideoMeta.fileName,
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

    // Voice Chat: Toggle Microphone Mute/Unmute
    const toggleMicrophone = useCallback(async () => {
        // If incoming audio is currently blocked, unmuting microphone also unblocks audio
        if (isAudioBlockedRef.current) {
            setIsAudioBlocked(false);
            isAudioBlockedRef.current = false;
            for (const peer of peersRef.current.values()) {
                if (peer.audioElement) {
                    peer.audioElement.muted = false;
                }
                if (peer.webAudioGain) {
                    peer.webAudioGain.gain.value = 1.0;
                }
            }
        }

        if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
            window.__webrtcAudioCtx.resume().catch(() => { });
        }

        if (isMicMutedRef.current) {
            try {
                let stream = localStreamRef.current;
                const currentTrack = stream?.getAudioTracks()[0];
                if (!currentTrack || currentTrack.readyState === 'ended') {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    });
                    localStreamRef.current = stream;
                }

                // Connect local microphone to Web Audio AnalyserNode for Speaking Rings & VU meter
                try {
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    if (AudioContextClass) {
                        if (!window.__webrtcAudioCtx) {
                            window.__webrtcAudioCtx = new AudioContextClass();
                        }
                        const ctx = window.__webrtcAudioCtx;
                        if (ctx.state === 'suspended') {
                            ctx.resume().catch(() => { });
                        }
                        if (localSourceNodeRef.current) {
                            try { localSourceNodeRef.current.disconnect(); } catch { }
                        }
                        if (localAnalyserRef.current) {
                            try { localAnalyserRef.current.disconnect(); } catch { }
                        }
                        const localSrc = ctx.createMediaStreamSource(stream);
                        const localAnalyser = ctx.createAnalyser();
                        localAnalyser.fftSize = 256;
                        localAnalyser.smoothingTimeConstant = 0.5;
                        localSrc.connect(localAnalyser);
                        localSourceNodeRef.current = localSrc;
                        localAnalyserRef.current = localAnalyser;
                    }
                } catch { }

                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = true;
                    logLocalDebug('MIC_UNMUTE', `User "${username}" unmuting mic. Track: "${audioTrack.label}", ID: ${audioTrack.id}, state: ${audioTrack.readyState}`);

                    for (const [peerId, peer] of peersRef.current.entries()) {
                        if (peer.pc) {
                            const transceivers = peer.pc.getTransceivers ? peer.pc.getTransceivers() : [];
                            logLocalDebug('MIC_PEER_TRANSCEIVERS', `Peer ${peerId} has ${transceivers.length} transceivers: ${transceivers.map(t => `${t.mid}:${t.direction}->${t.currentDirection}`).join(', ')}`);

                            let replaced = false;
                            for (const t of transceivers) {
                                const isValid = t.mid !== null || transceivers.length === 1;
                                if (isValid && t.sender && (!t.sender.track || t.sender.track.kind === 'audio')) {
                                    t.direction = 'sendrecv';
                                    t.sender.replaceTrack(audioTrack)
                                        .then(() => logLocalDebug('REPLACETRACK_OK', `Peer ${peerId} audio track replaced on transceiver mid: ${t.mid}!`))
                                        .catch((err) => logLocalDebug('REPLACETRACK_ERR', `Peer ${peerId} error: ${err.message}`));
                                    replaced = true;
                                }
                            }
                            if (!replaced) {
                                logLocalDebug('NO_AUDIO_TRANSCEIVER', `Peer ${peerId} had no matching transceiver. Using getSenders fallback.`);
                                const senders = peer.pc.getSenders();
                                for (const s of senders) {
                                    if (!s.track || s.track.kind === 'audio') {
                                        s.replaceTrack(audioTrack)
                                            .then(() => logLocalDebug('SENDER_REPLACETRACK_OK', `Peer ${peerId} track replaced on sender`))
                                            .catch((err) => logLocalDebug('SENDER_REPLACETRACK_ERR', `Peer ${peerId} sender error: ${err.message}`));
                                    }
                                }
                            }
                        }
                    }
                }

                setIsMicMuted(false);
                isMicMutedRef.current = false;
                sound.playPop();
                showToast('🎙️ Microphone unmuted (Live)');
                addSystemMessage('🎙️ You unmuted your microphone (Voice Chat Active).');

                const voiceMsg = {
                    type: 'peer-voice-status',
                    sender: username,
                    isMuted: false
                };
                for (const peer of peersRef.current.values()) {
                    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                        try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                    }
                }
            } catch (err) {
                showToast('⚠️ Could not access microphone. Check permissions.');
            }
        } else {
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach((track) => {
                    track.enabled = false;
                });
            }
            setIsMicMuted(true);
            isMicMutedRef.current = true;
            setLocalAudioActivity({ isSpeaking: false, level: 0 });
            showToast('🔇 Microphone muted');
            addSystemMessage('🔇 You muted your microphone.');

            const voiceMsg = {
                type: 'peer-voice-status',
                sender: username,
                isMuted: true
            };
            for (const peer of peersRef.current.values()) {
                if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                    try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                }
            }
        }
    }, [addSystemMessage, logLocalDebug, showToast, username]);

    // Voice Chat: Toggle Block Incoming Audio (Deafen) - blocks incoming audio AND microphone
    const toggleBlockAudio = useCallback(() => {
        setIsAudioBlocked((prev) => {
            const nextVal = !prev;
            isAudioBlockedRef.current = nextVal;

            // Mute/unmute all peer audio streams (HTMLMediaElement + Web Audio gain)
            for (const [pId, peer] of peersRef.current.entries()) {
                const isLocalMuted = Boolean(localMutedPeersRef.current[pId]);
                const vol = peerVolumesRef.current[pId] !== undefined ? peerVolumesRef.current[pId] : 1.0;
                const effective = nextVal || isLocalMuted ? 0 : vol;
                if (peer.audioElement) {
                    peer.audioElement.muted = effective === 0;
                    peer.audioElement.volume = Math.min(1.0, effective);
                }
                if (peer.webAudioGain) {
                    peer.webAudioGain.gain.value = effective;
                }
            }

            if (nextVal) {
                // When audio is blocked, the microphone is also blocked (muted)
                if (localStreamRef.current) {
                    localStreamRef.current.getAudioTracks().forEach((track) => {
                        track.enabled = false;
                    });
                }
                setIsMicMuted(true);
                isMicMutedRef.current = true;
                setLocalAudioActivity({ isSpeaking: false, level: 0 });

                const voiceMsg = {
                    type: 'peer-voice-status',
                    sender: username,
                    isMuted: true
                };
                for (const peer of peersRef.current.values()) {
                    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                        try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                    }
                }

                showToast('🔇 Audio & microphone blocked (Text Chat only)');
                addSystemMessage('🔇 Audio & microphone blocked (Text Chat only mode).');
            } else {
                showToast('🔊 Incoming audio unblocked');
                addSystemMessage('🔊 You unblocked incoming audio.');
            }
            return nextVal;
        });
    }, [addSystemMessage, showToast, username]);

    // Feature 2.1: Real-time Voice Activity Detection (VAD) & Speaking Rings Sampling Loop
    useEffect(() => {
        const buffer = new Uint8Array(128); // 128 frequency bins (fftSize = 256)
        const interval = setInterval(() => {
            // 1. Local Microphone Activity
            let localSpeaking = false;
            let localLevel = 0;
            if (!isMicMutedRef.current && localAnalyserRef.current) {
                try {
                    localAnalyserRef.current.getByteFrequencyData(buffer);
                    let sum = 0;
                    for (let i = 0; i < buffer.length; i++) {
                        sum += buffer[i];
                    }
                    const avg = sum / buffer.length;
                    if (avg > 12) {
                        localSpeaking = true;
                    }
                    localLevel = Math.min(100, Math.round((avg / 70) * 100));
                } catch { }
            }

            // 2. Remote Peers Voice Activity
            const activityMap = {};
            for (const [peerId, entry] of peersRef.current.entries()) {
                if (entry.analyserNode) {
                    try {
                        entry.analyserNode.getByteFrequencyData(buffer);
                        let sum = 0;
                        for (let i = 0; i < buffer.length; i++) {
                            sum += buffer[i];
                        }
                        const avg = sum / buffer.length;
                        const isSpeaking = avg > 12;
                        const level = Math.min(100, Math.round((avg / 70) * 100));
                        activityMap[peerId] = { isSpeaking, level };
                    } catch {
                        activityMap[peerId] = { isSpeaking: false, level: 0 };
                    }
                } else {
                    activityMap[peerId] = { isSpeaking: false, level: 0 };
                }
            }

            setLocalAudioActivity((prev) => {
                if (prev.isSpeaking !== localSpeaking || Math.abs(prev.level - localLevel) > 4) {
                    return { isSpeaking: localSpeaking, level: localLevel };
                }
                return prev;
            });

            setPeerAudioActivity((prev) => {
                let changed = false;
                const peerIds = Object.keys(activityMap);
                if (peerIds.length !== Object.keys(prev).length) {
                    return activityMap;
                }
                for (const pid of peerIds) {
                    const oldAct = prev[pid];
                    const newAct = activityMap[pid];
                    if (!oldAct || oldAct.isSpeaking !== newAct.isSpeaking || Math.abs(oldAct.level - newAct.level) > 5) {
                        changed = true;
                        break;
                    }
                }
                return changed ? activityMap : prev;
            });
        }, 75);

        return () => clearInterval(interval);
    }, []);

    // Feature 2.1: Per-Peer Volume Slider Handler (0% - 200%)
    const handleSetPeerVolume = useCallback((peerId, vol) => {
        const clamped = Math.max(0, Math.min(2.0, Math.round(vol * 100) / 100));
        setPeerVolumes((prev) => ({
            ...prev,
            [peerId]: clamped
        }));
        peerVolumesRef.current[peerId] = clamped;

        // Auto unmute if user adjusts slider while locally muted
        if (localMutedPeersRef.current[peerId] && clamped > 0) {
            setLocalMutedPeers((prev) => ({ ...prev, [peerId]: false }));
            localMutedPeersRef.current[peerId] = false;
        }

        const entry = peersRef.current.get(peerId);
        if (entry) {
            const isLocalMuted = Boolean(localMutedPeersRef.current[peerId]);
            const effective = isAudioBlockedRef.current || isLocalMuted ? 0 : clamped;
            if (entry.webAudioGain) {
                entry.webAudioGain.gain.value = effective;
            }
            if (entry.audioElement) {
                entry.audioElement.volume = Math.min(1.0, effective);
                entry.audioElement.muted = effective === 0;
            }
        }
    }, []);

    // Feature 2.1: One-Click Peer Mute for Me
    const handleToggleMutePeer = useCallback((peerId) => {
        setLocalMutedPeers((prev) => {
            const nextVal = !prev[peerId];
            localMutedPeersRef.current[peerId] = nextVal;

            const entry = peersRef.current.get(peerId);
            if (entry) {
                const vol = peerVolumesRef.current[peerId] !== undefined ? peerVolumesRef.current[peerId] : 1.0;
                const effective = isAudioBlockedRef.current || nextVal ? 0 : vol;
                if (entry.webAudioGain) {
                    entry.webAudioGain.gain.value = effective;
                }
                if (entry.audioElement) {
                    entry.audioElement.volume = Math.min(1.0, effective);
                    entry.audioElement.muted = effective === 0;
                }
            }

            const pName = peerMetadata[peerId]?.username || 'Peer';
            if (nextVal) {
                showToast(`🔇 Muted ${pName} for you`);
                addSystemMessage(`🔇 You muted ${pName} for yourself.`);
            } else {
                showToast(`🔊 Unmuted ${pName}`);
                addSystemMessage(`🔊 You unmuted ${pName}.`);
            }

            return { ...prev, [peerId]: nextVal };
        });
    }, [addSystemMessage, peerMetadata, showToast]);

    // Construct connected peers list with volume, mute, identity & speaking status
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
                    />
                </main>
            </div>

            <LiveChat
                messages={messages}
                systemLogs={systemLogs}
                onSendMessage={handleSendMessage}
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
            />

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

            {/* Toast Notification */}
            {toastMessage && <div className="toast">{toastMessage}</div>}
        </div>
    );
}