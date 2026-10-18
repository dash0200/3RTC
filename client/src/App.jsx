/**
 * The app shell: creates the room (connection layer + bus), plugs the features into it, and lays
 * out the desktop or phone screen. Feature logic lives in features/*, connection logic in
 * webrtc/*, and the shared plumbing in core/* (see docs/ARCHITECTURE.md).
 */
import { getClientId } from './utils/clientId';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from './components/Header';
import Stage from './components/Stage';
import LiveChat from './components/LiveChat';
import DesktopHome from './components/DesktopHome';
import InviteScreen from './components/InviteScreen';
import InvitePanel from './components/room/InvitePanel';
import ServerSettingsModal from './components/ServerSettingsModal';
import AudioSettingsModal from './components/AudioSettingsModal';
import NetworkDiagnosticsModal from './components/NetworkDiagnosticsModal';
import QrCodeModal from './components/QrCodeModal';
import PreJoinModal from './components/PreJoinModal';
import { PhoneTopBar, PhoneActionBar } from './components/phone/PhoneChrome';
import { AddVideoSheet, MoreSheet, SoundboardSheet } from './components/phone/PhoneSheets';
import PhoneHome from './components/phone/PhoneHome';
import { sound } from './utils/sound';
import { copyToClipboard } from './utils/clipboard';
import { micPipeline } from './utils/micPipeline';
import { loadQuickPicks } from './utils/quickPicks';
import { createRoomBus } from './core/roomBus';
import { pickAuthority } from './core/sharedState';
import { RoomProvider } from './core/RoomContext';
import { PROTOCOL_VERSION } from './webrtc/config';
import { usePeerMesh } from './webrtc/usePeerMesh';
import { useVoiceChat } from './hooks/useVoiceChat';
import { useNetworkStats } from './hooks/useNetworkStats';
import { useWakeLock } from './hooks/useWakeLock';
import { useIsPhone } from './hooks/useIsPhone';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotices } from './features/notices/useNotices';
import { useChat } from './features/chat/useChat';
import { useReactions } from './features/reactions/useReactions';
import { useSoundboard } from './features/soundboard/useSoundboard';
import { useHostControls } from './features/playback/useHostControls';
import { usePlayback } from './features/playback/usePlayback';
import { useStreamTransfer } from './features/playback/useStreamTransfer';
import { useMediaSync } from './features/playback/useMediaSync';
import { useFileFormat } from './features/files/useFileFormat';
import { useQueue } from './features/queue/useQueue';
import { useActivities } from './features/activities/useActivities';
import ActivityStage from './features/activities/ActivityStage';
import { nextActivityView } from './features/activities/activityHost';
import { useActivityLoad } from './features/activities/useActivityLoad';
import ReactionsEditor from './features/reactions/ReactionsEditor';
import { useScreenShare } from './features/screenshare/useScreenShare';
import './App.css';
import './phone.css';
import './redesign.css';
import { useNewVersionNotice } from './pwa/useNewVersionNotice';
import { useBackLayer, useRoomBackGuard } from './core/backStack';
import LeaveRoomDialog from './components/LeaveRoomDialog';
import { saveLastRoom, readLastRoom, forgetLastRoom } from './utils/lastRoom';
import NetworkBlockedBanner from './components/NetworkBlockedBanner';
import { useDriftSync } from './features/playback/useDriftSync';

export const ORACLE_SIGNAL_URL = 'wss://orc.3rtc.me';
export const GCP_SIGNAL_URL = 'wss://gcp.3rtc.me';
export const LOCAL_SIGNAL_URL = 'ws://localhost:8080';

// Default primary server: Oracle Cloud (orc.3rtc.me) with automatic multi-cloud failover to GCP
export const DEFAULT_SIGNAL_URL = ORACLE_SIGNAL_URL;

// Intelligent fallback pool: if orc.3rtc.me is not reachable, seamlessly fallback to GCP, then raw IP
export const BACKUP_SIGNAL_URLS = [
    GCP_SIGNAL_URL,
    'wss://signal.3rtc.me',
    'wss://34.57.36.145.sslip.io:443'
];
const IS_LOCAL = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '[::1]' ||
    Boolean(import.meta.env?.DEV)
);

// Server settings is a developer tool: shown on localhost, dev.3rtc.me and Vercel previews only.
// On 3rtc.me users just see the connection status (the app always uses DEFAULT_SIGNAL_URL there).
const SHOW_SERVER_SETTINGS = IS_LOCAL || (typeof window !== 'undefined' && (
    window.location.hostname === 'dev.3rtc.me' ||
    window.location.hostname.endsWith('.vercel.app')
));

// Developer debug logging is off: keeps the console and the room log clean
const logLocalDebug = () => { };

export default function App() {
    // ---- settings ----------------------------------------------------------------------------
    const [signalUrl, setSignalUrl] = useState(() => {
        if (typeof window !== 'undefined') {
            const serverParam = new URLSearchParams(window.location.search).get('s');
            if (serverParam === 'gcp') return GCP_SIGNAL_URL;
            if (serverParam === 'orc') return ORACLE_SIGNAL_URL;
            if (serverParam === 'local') return LOCAL_SIGNAL_URL;
        }
        return (IS_LOCAL && localStorage.getItem('webrtc_signal_url')) || DEFAULT_SIGNAL_URL;
    });

    const fallbackUrls = useMemo(() => {
        if (signalUrl === ORACLE_SIGNAL_URL) {
            return [GCP_SIGNAL_URL, 'wss://signal.3rtc.me', 'wss://34.57.36.145.sslip.io:443'];
        }
        if (signalUrl === GCP_SIGNAL_URL) {
            return [ORACLE_SIGNAL_URL, 'wss://signal.3rtc.me', 'wss://34.57.36.145.sslip.io:443'];
        }
        return signalUrl === DEFAULT_SIGNAL_URL ? BACKUP_SIGNAL_URLS : undefined;
    }, [signalUrl]);

    // YouTube quick picks come from the signaling server's cache (built-in list until then)
    useEffect(() => {
        const urls = [signalUrl, ...(fallbackUrls || [])];
        loadQuickPicks(urls);
        // Reads the server's saved list (no YouTube quota); the server refreshes it every few hours
        const timer = setInterval(() => loadQuickPicks(urls), 60 * 60 * 1000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signalUrl]);
    const [username, setUsername] = useState(() => localStorage.getItem('webrtc_username') || `User_${Math.floor(100 + Math.random() * 900)}`);
    const [signalStatus, setSignalStatus] = useState({ connected: false, label: 'Connecting...' });

    // ---- the room: who is connected, and the bus every feature talks through ------------------
    const notices = useNotices();
    const { showToast, addSystemMessage } = notices;
    useNewVersionNotice(showToast);
    const peerIdRef = useRef(crypto.randomUUID());
    const peersRef = useRef(new Map()); // peerId -> peer entry (webrtc/usePeerMesh.js)
    const isHostRef = useRef(false);
    // Who the host is, as the signaling server says (it knows who made the room). Peers' own claims
    // are not trusted. undefined: an older server that doesn't say (then the peers' claims are used)
    const hostPeerIdRef = useRef(undefined);
    const [hostPeerId, setHostPeerIdState] = useState(undefined);
    const setHostPeerId = useCallback((id) => {
        hostPeerIdRef.current = id;
        setHostPeerIdState(id);
    }, []);
    const usernameRef = useRef(username);
    usernameRef.current = username;
    const [peerMetadata, setPeerMetadata] = useState({}); // { [peerId]: { username, isHost, isMuted } }
    const peerMetadataRef = useRef(peerMetadata);
    peerMetadataRef.current = peerMetadata;
    // Keep each peer's stored host flag in line with the server (the host may come back with a new id)
    useEffect(() => {
        if (hostPeerId === undefined) return;
        setPeerMetadata((prev) => {
            let changed = false;
            const next = {};
            for (const [id, meta] of Object.entries(prev)) {
                const isHostNow = id === hostPeerId;
                changed = changed || Boolean(meta?.isHost) !== isHostNow;
                next[id] = Boolean(meta?.isHost) === isHostNow ? meta : { ...meta, isHost: isHostNow };
            }
            return changed ? next : prev;
        });
    }, [hostPeerId]);
    const roomSettingsRef = useRef(() => ({}));
    const identityFieldsRef = useRef(() => ({}));

    const busRef = useRef(null);
    if (!busRef.current) {
        busRef.current = createRoomBus({
            getPeers: () => peersRef.current,
            getSelf: () => ({ peerId: peerIdRef.current, username: usernameRef.current, isHost: isHostRef.current })
        });
    }
    const bus = busRef.current;

    // Stable facade handed to every feature (see core/RoomContext.jsx)
    const room = useMemo(() => {
        const hostKnown = () => hostPeerIdRef.current !== undefined;
        const isPeerHost = (id) => (id === peerIdRef.current ? isHostRef.current
            : Boolean(hostPeerIdRef.current && id === hostPeerIdRef.current));
        const connectedPeers = () => bus.connectedPeerIds().map((peerId) => ({ peerId, isHost: isPeerHost(peerId) }));
        return {
            bus,
            getSelfId: () => peerIdRef.current,
            getSelf: () => ({ peerId: peerIdRef.current, username: usernameRef.current, isHost: isHostRef.current }),
            isPeerHost,
            // The host among the other people here (null: we are the host, or the host isn't here)
            getHostPeerId: () => {
                const id = hostPeerIdRef.current;
                return id && id !== peerIdRef.current && peerMetadataRef.current[id] ? id : null;
            },
            peerName: (id) => peerMetadataRef.current[id]?.username || null,
            // The app's stable id (same after a reload or rejoin; the peer id isn't)
            clientIdOf: (id) => (id === peerIdRef.current ? getClientId() : peerMetadataRef.current[id]?.clientId || null),
            // Message format version of a peer's app (1 = from before versions were sent)
            peerProtocol: (id) => (id === peerIdRef.current ? PROTOCOL_VERSION : (peerMetadataRef.current[id]?.proto || 1)),
            getAuthorityId: () => pickAuthority(peerIdRef.current, isHostRef.current, connectedPeers()),
            getRoomSettings: () => roomSettingsRef.current(),
            notify: showToast,
            log: addSystemMessage
        };
    }, [bus, showToast, addSystemMessage]);

    const voice = useVoiceChat({ addSystemMessage, logLocalDebug, peerMetadata, peersRef, showToast, username });
    const {
        isMicMuted, isAudioBlocked, peerVoiceStates, peerVolumes, localMutedPeers, audioSettings, voiceIsolationStatus,
        isPttActive, isAudioBlockedRef, toggleMicrophone, handleUpdateAudioSettings, handlePttPressStart,
        handlePttPressEnd, toggleBlockAudio, handleSetPeerVolume, handleToggleMutePeer, selectOutputDevice
    } = voice;

    const mesh = usePeerMesh({
        bus, peersRef, peerIdRef, isHostRef, hostPeerIdRef, setHostPeerId, setPeerMetadata, username, notices, voice,
        identityFields: () => identityFieldsRef.current(),
        signalUrl, fallbackUrls, setSignalStatus, logLocalDebug
    });
    const { roomId, isHost, peerCount, isP2PConnected, p2pStatusText } = mesh;

    const localUser = useMemo(() => (roomId ? {
        id: peerIdRef.current, peerId: peerIdRef.current, username, isHost, isMuted: isMicMuted, isSelf: true
    } : null), [roomId, username, isHost, isMicMuted]);

    const screenShare = useScreenShare(bus, { localUser });
    const isScreenSharingActive = Boolean(screenShare.isScreenShareActive);

    // ---- features ----------------------------------------------------------------------------
    const hostControls = useHostControls({ room, isHost, peerMetadata });
    identityFieldsRef.current = hostControls.identityFields;
    roomSettingsRef.current = () => ({ playbackLock: hostControls.playbackLockRef.current });
    const { playbackLock } = hostControls;

    const playback = usePlayback({ room, hostControls });
    useStreamTransfer({ room, playback });
    const queueFeature = useQueue({ room, playback, hostControls, peerCount });
    useMediaSync({ room, playback, queue: queueFeature, hostControls });
    useDriftSync({ room, playback, active: Boolean(roomId) && playback.isMediaActive });
    const fileFormat = useFileFormat({ room, playback });
    const {
        activeVideoId, activeVideoTitle, localVideoFile, remoteLocalVideoMeta, remoteAction, streamProgress, streamVideoUrl, isMediaActive
    } = playback;
    const { queue, skipVotes } = queueFeature;

    // Desktop: the side panel is always there (Figma); phones embed the chat under the video
    const [isChatOpen, setIsChatOpen] = useState(true);
    const [sidebarTab, setSidebarTab] = useState('chat');
    const activities = useActivities({ room, hostControls, peopleCount: roomId ? peerCount : 0 });
    // Is the game loaded on this device? Only for whoever started it or joined it (features/activities/useActivityLoad.js)
    const activityLoad = useActivityLoad({ bus, activity: activities.current, definition: activities.definition, selfId: peerIdRef.current, notify: showToast });
    const activityOn = Boolean(activities.current) && activityLoad.loaded;
    const joinedByTapRef = useRef(false);
    const joinActivity = useCallback(() => {
        joinedByTapRef.current = true;
        activityLoad.load();
    }, [activityLoad]);
    // The games menu: the open game, not loaded here, is "Join" (instead of greyed out as open)
    const activityMenu = useMemo(() => activities.menu.map((a) => (a.isOpen && !activityLoad.loaded
        ? { ...a, isOpen: false, description: `On now: tap to join` } : a)), [activities.menu, activityLoad.loaded]);
    const startOrJoinActivity = useCallback((id) => {
        if (activities.current?.id === id && !activityLoad.loaded) joinActivity();
        else activities.start(id);
    }, [activities, activityLoad.loaded, joinActivity]);
    const isPhone = useIsPhone();
    // How the open game is shown here: over the stage, in a small window, or as a bubble
    // (only on this device; the game itself is the same for everyone). See activityHost.js.
    const [activityView, setActivityView] = useState('full');
    const viewMemoRef = useRef({ media: false, key: null });
    // (the game counts as opened here when it's loaded here)
    const activityKey = activityOn ? `${activities.current.id}:${activities.current.startedAt}` : null;
    useEffect(() => {
        const memo = viewMemoRef.current;
        const justOpened = Boolean(activityKey) && activityKey !== memo.key;
        if (justOpened && joinedByTapRef.current) {
            // Joined from its bubble: show it (docked in sidebar over a video on a computer)
            joinedByTapRef.current = false;
            setActivityView(!isPhone && isMediaActive ? 'sidebar' : 'full');
        } else {
            setActivityView((view) => nextActivityView({
                view,
                mediaActive: isMediaActive,
                wasMediaActive: memo.media,
                isPhone,
                activityOpen: Boolean(activityKey),
                activityJustOpened: justOpened
            }));
        }
        viewMemoRef.current = { media: isMediaActive, key: activityKey };
    }, [isMediaActive, activityKey, isPhone]);

    const [activityStatus, setActivityStatus] = useState({ attention: false, color: '', label: '' });

    // When activityView transitions to 'sidebar' on desktop, ensure sidebar is open to the activity tab
    const prevActivityViewRef = useRef(activityView);
    useEffect(() => {
        const prevView = prevActivityViewRef.current;
        prevActivityViewRef.current = activityView;
        if (prevView !== 'sidebar' && activityView === 'sidebar' && !isPhone) {
            setIsChatOpen(true);
            setSidebarTab('activity');
        }
    }, [activityView, isPhone]);

    // When activity ends, return sidebar from activity tab back to chat
    useEffect(() => {
        if (!activityOn) {
            if (sidebarTab === 'activity') {
                setSidebarTab('chat');
            }
        }
    }, [activityOn, sidebarTab]);
    const activityAside = activityOn && activityView !== 'full';
    const [activityChatSplit, setActivityChatSplit] = useState(() => {
        try { return localStorage.getItem('3rtc_activity_chat') === '1'; } catch { return false; }
    });
    // Unread count: on phones the chat list is on screen when its tab is picked (and, with a game
    // open, when the game's "Chat" view is on); on computers when the chat panel is open
    const phoneChatOnScreen = sidebarTab === 'chat' && (!activityOn || activityAside || activityChatSplit);
    const chat = useChat({ room, isChatOpen: isPhone ? phoneChatOnScreen : isChatOpen });
    const reactions = useReactions({ room, isAudioBlockedRef, inRoom: Boolean(roomId) });
    const soundboard = useSoundboard({ room, isAudioBlockedRef });
    const { networkStats, peersNetworkStats, handleTriggerPing } = useNetworkStats({ activeVideoId, bus, localVideoFile, peerMetadata, peersRef, roomId, showToast });

    // ---- screens and dialogs -----------------------------------------------------------------
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [showQrModal, setShowQrModal] = useState(false);
    const [showAudioSettingsModal, setShowAudioSettingsModal] = useState(false);
    const [showNetworkHudModal, setShowNetworkHudModal] = useState(false);
    const [initialJoinPin, setInitialJoinPin] = useState('');
    const openServerSettings = SHOW_SERVER_SETTINGS ? () => setShowSettingsModal(true) : undefined;
    const openAudioSettings = useCallback(() => setShowAudioSettingsModal(true), []);
    const openNetworkHud = useCallback(() => setShowNetworkHudModal(true), []);
    const openQrCode = useCallback(() => setShowQrModal(true), []);

    // Phone layout (its own app shell; desktop layout unchanged) and its open bottom sheet
    const [phoneSheet, setPhoneSheet] = useState(null); // 'add' | 'more' | 'soundboard' | null
    useEffect(() => {
        try { localStorage.setItem('3rtc_activity_chat', activityChatSplit ? '1' : '0'); } catch { /* private mode */ }
    }, [activityChatSplit]);
    const chatSeenCountRef = useRef(0);
    const closePhoneSheet = useCallback(() => setPhoneSheet(null), []);

    // Resume the shared AudioContext on any user interaction (browsers start it suspended)
    useEffect(() => {
        const resumeAudioCtx = () => {
            if (window.__webrtcAudioCtx?.state === 'suspended') window.__webrtcAudioCtx.resume().catch(() => { });
        };
        const events = ['click', 'keydown', 'touchstart'];
        events.forEach((e) => window.addEventListener(e, resumeAudioCtx));
        return () => events.forEach((e) => window.removeEventListener(e, resumeAudioCtx));
    }, []);

    // ?room=12345 in the address: open the join dialog with that code
    const hasInitializedRef = useRef(false);
    useEffect(() => {
        if (hasInitializedRef.current) return;
        hasInitializedRef.current = true;
        const roomParam = new URLSearchParams(window.location.search).get('room');
        if (roomParam && /^\d{5}$/.test(roomParam)) {
            setInitialJoinPin(roomParam); // opens the invite screen
        }
        addSystemMessage('Welcome to 3RTC! Create or join a room to chat and watch YouTube together.');
    }, [addSystemMessage]);

    useKeyboardShortcuts({
        audioSettings,
        voice,
        inRoom: Boolean(roomId),
        localVideoOpen: Boolean(localVideoFile || streamVideoUrl || remoteLocalVideoMeta),
        onShowQr: openQrCode
    });

    // Keep the screen on while watching together (phones would dim, lock and pause the stream)
    useWakeLock(Boolean(roomId) && (isMediaActive || isScreenSharingActive));

    // ---- room actions ------------------------------------------------------------------------
    const rememberName = (displayName) => {
        setUsername(displayName);
        usernameRef.current = displayName;
        localStorage.setItem('webrtc_username', displayName);
    };
    const handleConfirmCreate = (displayName) => {
        rememberName(displayName);
        setSidebarTab('invite');
        mesh.createRoom();
    };
    const handleConfirmJoin = (pin, displayName) => {
        rememberName(displayName);
        setSidebarTab('chat');
        mesh.joinRoom(pin);
    };
    // Pre-join Green Room check (UX-H01): preview microphone and audio devices before joining
    const [preJoinConfig, setPreJoinConfig] = useState(null);
    const handleInitiateCreate = (displayName) => {
        setPreJoinConfig({ mode: 'create', name: displayName });
    };
    const handleInitiateJoin = (pin, displayName) => {
        setPreJoinConfig({ mode: 'join', pin, name: displayName });
    };
    const handleConfirmPreJoin = ({ name: chosenName, micOn, pin }) => {
        micOnAfterJoinRef.current = Boolean(micOn);
        const mode = preJoinConfig?.mode;
        const targetPin = pin || preJoinConfig?.pin;
        setPreJoinConfig(null);
        if (mode === 'create') {
            handleConfirmCreate(chosenName);
        } else {
            handleConfirmJoin(targetPin, chosenName);
        }
    };
    // Invite link (?room=12345): its own screen with one Join button; the mic choice is made there
    const [inviteDismissed, setInviteDismissed] = useState(false);
    const showInvite = !roomId && Boolean(initialJoinPin) && !inviteDismissed;
    const micOnAfterJoinRef = useRef(false);
    const handleInviteJoin = (pin, displayName, { micOn } = {}) => {
        micOnAfterJoinRef.current = Boolean(micOn);
        setInviteDismissed(true);
        handleConfirmJoin(pin, displayName);
    };
    const dismissInvite = () => {
        setInviteDismissed(true);
        setInitialJoinPin('');
        try { window.history.replaceState(null, '', window.location.pathname); } catch { /* ignore */ }
    };
    useEffect(() => {
        if (!roomId || !micOnAfterJoinRef.current) return;
        micOnAfterJoinRef.current = false;
        if (isMicMuted) toggleMicrophone();
    }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps
    const leaveRoomNow = () => {
        setShowLeaveDialog(false);
        voice.resetVoice();
        mesh.leaveRoom(); // emits 'room-left': every feature resets itself
        addSystemMessage('You left the room.');
        showToast('Left room');
    };
    // Same "Leave room 12345?" dialog on desktop and phone (was a browser confirm() on desktop)
    const handleLeaveRoom = () => setShowLeaveDialog(true);

    // ---- Back button, rejoining, closing the tab -----------------------------------------------
    // Back in a room closes what's open on top, else asks before leaving (core/backStack.js).
    // Playing videos are never closed by Back: they have their own Exit button.
    const [showLeaveDialog, setShowLeaveDialog] = useState(false);
    const closeLeaveDialog = useCallback(() => setShowLeaveDialog(false), []);
    useRoomBackGuard(roomId, () => setShowLeaveDialog(true));
    useEffect(() => { if (!roomId) setShowLeaveDialog(false); }, [roomId]);
    useBackLayer(Boolean(phoneSheet), closePhoneSheet);
    useBackLayer(showSettingsModal, () => setShowSettingsModal(false));
    useBackLayer(showAudioSettingsModal, () => setShowAudioSettingsModal(false));
    useBackLayer(showNetworkHudModal, () => setShowNetworkHudModal(false));
    useBackLayer(showQrModal, () => setShowQrModal(false));
    useBackLayer(isPhone && activityChatSplit && activityOn, () => setActivityChatSplit(false));
    // Phone, a game open: Back puts the game into its bubble (the game goes on)
    useBackLayer(isPhone && activityOn && activityView === 'full', () => setActivityView('bubble'));

    // The room you were last in: "Rejoin" on the home screen for a while (utils/lastRoom.js)
    const [lastRoom, setLastRoom] = useState(() => readLastRoom());
    useEffect(() => {
        if (!roomId) {
            setLastRoom(readLastRoom());
            return undefined;
        }
        // (the last token seen: leaving clears it before the final save below)
        let hostToken = null;
        const save = () => {
            hostToken = mesh.getHostToken() || hostToken;
            saveLastRoom(roomId, isHost, hostToken);
        };
        save();
        const timer = setInterval(save, 60 * 1000);
        window.addEventListener('pagehide', save);
        return () => {
            save(); // left: the 30 minutes count from now
            clearInterval(timer);
            window.removeEventListener('pagehide', save);
        };
    }, [roomId, isHost]);
    const rejoin = !roomId && lastRoom ? {
        ...lastRoom,
        onRejoin: () => {
            if (lastRoom.wasHost) mesh.createRoom(lastRoom.roomId, lastRoom.hostToken);
            else mesh.joinRoom(lastRoom.roomId);
        },
        onDismiss: () => {
            forgetLastRoom();
            setLastRoom(null);
        }
    } : null;

    // Closing or reloading the tab mid-video or mid-game: the browser asks first
    const busyInRoom = Boolean(roomId) && (isMediaActive || activityOn);
    useEffect(() => {
        if (!busyInRoom) return undefined;
        const ask = (e) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', ask);
        return () => window.removeEventListener('beforeunload', ask);
    }, [busyInRoom]);

    const handleCopyRoom = useCallback(async (customVal) => {
        if (!roomId) return;
        const value = typeof customVal === 'string' && customVal.trim() ? customVal.trim() : String(roomId).trim();
        showToast((await copyToClipboard(value)) ? `Copied Room ID: ${value}` : `Room ID: ${value}`);
    }, [roomId, showToast]);

    const handleTestSound = useCallback(() => {
        sound.playChime();
        addSystemMessage('🔊 Test chime played. If you heard the chime, your audio output is working properly.');
        showToast('🔊 Playing test sound...');
    }, [addSystemMessage, showToast]);

    const handleApplyServer = (newUrl) => {
        setSignalUrl(newUrl);
        localStorage.setItem('webrtc_signal_url', newUrl);
        showToast(`Connecting to ${newUrl}...`);
    };

    const handleOpenQueue = useCallback(() => {
        setIsChatOpen(true);
        setSidebarTab('queue');
    }, []);

    // ---- who is here -------------------------------------------------------------------------
    const connectedPeers = useMemo(() => {
        const list = [];
        for (const [peerId, entry] of peersRef.current.entries()) {
            if (!entry.isConnected && entry.dataChannel?.readyState !== 'open') continue;
            const meta = peerMetadata[peerId] || {};
            const voiceState = peerVoiceStates[meta.username] || {};
            list.push({
                id: peerId,
                peerId,
                username: meta.username || `Peer ${peerId.slice(0, 4)}`,
                isHost: hostPeerId !== undefined ? peerId === hostPeerId : Boolean(meta.isHost),
                isMuted: meta.isMuted !== undefined ? meta.isMuted : (voiceState.isMuted !== undefined ? voiceState.isMuted : true),
                volume: peerVolumes[peerId] !== undefined ? peerVolumes[peerId] : 1.0,
                isLocalMuted: Boolean(localMutedPeers[peerId]),
                build: meta.build || null
            });
        }
        return list;
        // peerCount / isP2PConnected: the peer map itself isn't state
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peerMetadata, peerVoiceStates, peerVolumes, localMutedPeers, peerCount, isP2PConnected, hostPeerId]);

    // Auto-switch from invite tab to chat once a peer connects
    useEffect(() => {
        if (connectedPeers.length > 0 && sidebarTab === 'invite') {
            setSidebarTab('chat');
        }
    }, [connectedPeers.length, sidebarTab]);

    // What components deeper down read with useRoom()
    const roomContext = useMemo(() => ({ ...room, roomId, isHost, username, peers: connectedPeers, playbackLock, signalUrl }),
        [room, roomId, isHost, username, connectedPeers, playbackLock, signalUrl]);

    // ---- layout ------------------------------------------------------------------------------
    // Chat while an activity is open: new messages pop up over it when the chat list isn't in view;
    // on phones a "Chat" button shrinks the game so the messages fit below it
    const chatListVisible = isPhone ? activityChatSplit && sidebarTab === 'chat' : isChatOpen && sidebarTab === 'chat';
    const activityChatUnread = useMemo(() => {
        if (chatListVisible) return 0;
        return chat.messages.slice(chatSeenCountRef.current).filter((m) => !m.isSelf).length;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chat.messages, chatListVisible]);
    if (chatListVisible) chatSeenCountRef.current = chat.messages.length;
    const activityChat = {
        messages: chat.messages,
        isListVisible: chatListVisible,
        unread: activityChatUnread,
        splitView: isPhone && activityChatSplit,
        onOpenChat: () => {
            setSidebarTab('chat');
            if (isPhone) setActivityChatSplit(true);
            else setIsChatOpen(true);
        },
        onToggleSplitView: isPhone ? () => {
            setActivityChatSplit((on) => !on);
            setSidebarTab('chat');
        } : undefined
    };
    const activitySlot = roomId && activities.current ? (
        <ActivityStage
            activity={activities.current} definition={activities.definition} onClose={activities.stop} selfId={peerIdRef.current} chat={activityChat}
            view={activityView} onViewChange={setActivityView} isPhone={isPhone} mediaActive={isMediaActive}
            loaded={activityLoad.loaded} onJoin={joinActivity} onLeave={activityLoad.leave}
            onStatusChange={setActivityStatus}
        />
    ) : null;

    const handleToggleChat = () => {
        setIsChatOpen((prev) => !prev);
    };

    // Stage and chat panel: shared by the desktop and phone layouts (same props, layout extras)
    const renderStage = (extra = {}) => (
        <Stage
            roomId={roomId}
            activityView={activityView}
            isHost={isHost}
            playbackLock={playbackLock}
            onTogglePlaybackLock={hostControls.toggle}
            peerCount={peerCount}
            isP2PConnected={isP2PConnected}
            p2pStatusText={p2pStatusText}
            rejoin={rejoin}
            screenShare={screenShare}
            bus={bus}
            onCopyRoom={handleCopyRoom}
            onLeaveRoom={handleLeaveRoom}
            onToggleChat={handleToggleChat}
            isChatOpen={isChatOpen}
            unreadChatCount={chat.unreadChatCount}
            chatCount={chat.unreadChatCount}
            activeVideoId={activeVideoId}
            activeMedia={playback.activeMedia}
            onPlayLink={playback.playLink}
            onQueueLink={(media) => queueFeature.addToQueue({ media, title: media.title })}
            onExitVideo={playback.exitVideo}
            activeVideoTitle={activeVideoTitle}
            onVideoChange={playback.changeVideo}
            localVideoFile={localVideoFile}
            remoteLocalVideoMeta={remoteLocalVideoMeta}
            onLocalFileSelect={playback.selectLocalFile}
            onCloseLocalVideo={playback.closeLocalVideo}
            onBroadcastAction={playback.broadcastAction}
            remoteAction={remoteAction}
            onRegisterStateGetter={(getter) => {
                playback.syncStateGetterRef.current = getter;
            }}
            streamProgress={streamProgress}
            fileFormat={fileFormat}
            streamVideoUrl={streamVideoUrl}
            onRequestP2PStream={playback.requestStream}
            onCancelP2PStream={playback.cancelStream}
            isMicMuted={isMicMuted}
            isAudioBlocked={isAudioBlocked}
            onToggleMic={toggleMicrophone}
            onToggleBlockAudio={toggleBlockAudio}
            peerVoiceStates={peerVoiceStates}
            queue={queue}
            onAddToQueue={queueFeature.addToQueue}
            onPlayNextInQueue={queueFeature.playNextInQueue}
            onVoteSkip={queueFeature.voteSkip}
            skipVotes={skipVotes}
            onOpenQueue={handleOpenQueue}
            username={username}
            reactionFeed={reactions.reactionFeed}
            onSendReaction={reactions.sendReaction}
            connectedPeers={connectedPeers}
            localUser={localUser}
            onSetPeerVolume={handleSetPeerVolume}
            onToggleMutePeer={handleToggleMutePeer}
            audioSettings={audioSettings}
            onOpenAudioSettings={openAudioSettings}
            isPttActive={isPttActive}
            onPttPressStart={handlePttPressStart}
            onPttPressEnd={handlePttPressEnd}
            soundboardSettings={soundboard.soundboardSettings}
            activeSoundboardSfx={soundboard.activeSoundboardSfx}
            activeSfxCooldowns={soundboard.activeSfxCooldowns}
            onPlaySoundboardClip={soundboard.playClip}
            onSoundboardVolumeChange={soundboard.setVolume}
            onToggleSoundboardMute={soundboard.toggleMute}
            networkStats={networkStats}
            onOpenNetworkHud={openNetworkHud}
            onOpenQrCode={openQrCode}
            activitySlot={activitySlot}
            activityMenu={activityMenu}
            onStartActivity={startOrJoinActivity}
            {...extra}
        />
    );
    const nowPlaying = isScreenSharingActive
        ? `${screenShare.screenSharer?.username || (screenShare.isSharingScreen ? 'Your' : 'Peer')}'s screen`
        : playback.activeMedia
            ? (playback.activeMedia.title || '')
            : activeVideoId ? (activeVideoTitle || 'YouTube video')
                : (localVideoFile?.name || remoteLocalVideoMeta?.fileName || remoteLocalVideoMeta?.name || '');
    const renderAddVideoSheet = () => (
        <AddVideoSheet
            isOpen={phoneSheet === 'add'}
            onClose={closePhoneSheet}
            isMediaActive={isMediaActive}
            onLoadYouTube={(id, title) => {
                playback.changeVideo(id, title);
                playback.broadcastAction('load', { newVideoId: id, title });
            }}
            onQueueYouTube={(id, title) => queueFeature.addToQueue({ videoId: id, title })}
            onLoadLink={playback.playLink}
            onQueueLink={(media) => queueFeature.addToQueue({ media, title: media.title })}
            onQueuePick={(id, title) => queueFeature.addToQueue({ videoId: id, title }, { autoplay: false })}
            queuedIds={queue.map((item) => item.videoId)}
            onPlayQueue={queue.length > 0 && !isMediaActive ? queueFeature.playNextInQueue : undefined}
            onPickFile={playback.selectLocalFile}
            onStopVideo={playback.exitVideo}
        />
    );

    const renderChat = (extra = {}) => (
        <LiveChat
            onSeekTo={isMediaActive ? playback.seekEveryone : undefined}
            messages={chat.messages}
            systemLogs={notices.systemLogs}
            onSendMessage={chat.sendMessage}
            onSendImage={chat.sendImage}
            onClearLogs={notices.clearLogs}
            onTestSound={handleTestSound}
            isP2PConnected={isP2PConnected}
            username={username}
            isOpen={isChatOpen}
            onClose={() => setIsChatOpen(false)}
            activity={activities.current}
            activityDefinition={activities.definition}
            activityView={activityView}
            onSetActivityView={setActivityView}
            activityStatus={activityStatus}
            isAudioBlocked={isAudioBlocked}
            onToggleBlockAudio={toggleBlockAudio}
            signalStatus={signalStatus}
            onOpenSettings={openServerSettings}
            queue={queue}
            activeVideoId={activeVideoId}
            activeMedia={playback.activeMedia}
            activeVideoTitle={activeVideoTitle}
            onAddToQueue={queueFeature.addToQueue}
            onRemoveFromQueue={queueFeature.removeFromQueue}
            onReorderQueue={queueFeature.reorderQueue}
            onClearQueue={queueFeature.clearQueue}
            onPlayQueueItem={queueFeature.playQueueItem}
            onPlayNextInQueue={queueFeature.playNextInQueue}
            onVoteSkip={queueFeature.voteSkip}
            skipVotes={skipVotes}
            peerCount={peerCount}
            activeTab={sidebarTab}
            onTabChange={setSidebarTab}
            onSendReaction={reactions.sendReaction}
            connectedPeers={connectedPeers}
            localUser={localUser}
            onSetPeerVolume={handleSetPeerVolume}
            onToggleMutePeer={handleToggleMutePeer}
            onToggleMic={toggleMicrophone}
            roomId={roomId}
            onCopyRoom={handleCopyRoom}
            audioSettings={audioSettings}
            onUpdateAudioSettings={handleUpdateAudioSettings}
            onOpenAudioSettings={openAudioSettings}
            isPttActive={isPttActive}
            onPttPressStart={handlePttPressStart}
            onPttPressEnd={handlePttPressEnd}
            soundboardSettings={soundboard.soundboardSettings}
            activeSoundboardSfx={soundboard.activeSoundboardSfx}
            activeSfxCooldowns={soundboard.activeSfxCooldowns}
            onPlaySoundboardClip={soundboard.playClip}
            onSoundboardVolumeChange={soundboard.setVolume}
            onToggleSoundboardMute={soundboard.toggleMute}
            onOpenQrCode={openQrCode}
            {...extra}
        />
    );

    return (
        <RoomProvider value={roomContext}>
        <div className={`app-container ${isPhone ? 'phone-app' : ''}`}>
            {isPhone ? (
                <>
                    <PhoneTopBar
                        roomId={roomId}
                        onCopyRoom={async (link) => showToast((await copyToClipboard(link)) ? 'Invite link copied' : link)}
                        people={[
                            ...connectedPeers.map((p) => ({ key: p.peerId || p.id, name: p.username || 'Friend' })),
                            ...(localUser ? [{ key: 'me', name: username || 'You' }] : [])
                        ]}
                        onOpenPeople={() => setSidebarTab('peers')}
                        username={username}
                        networkStats={networkStats}
                        isP2PConnected={isP2PConnected}
                        signalStatus={signalStatus}
                        onOpenNetworkHud={openNetworkHud}
                        playbackLock={playbackLock}
                        signalUrl={signalUrl}
                        onLeaveRoom={handleLeaveRoom}
                    />
                    {roomId ? (
                        <>
                            {renderStage({ layout: 'phone', onOpenAddVideo: () => setPhoneSheet('add') })}
                            {renderChat({ embedded: true, isOpen: true })}
                            <PhoneActionBar
                                isMicMuted={isMicMuted}
                                isPttMode={audioSettings?.inputMode === 'ptt'}
                                isPttActive={isPttActive}
                                onToggleMic={toggleMicrophone}
                                onPttPressStart={handlePttPressStart}
                                onPttPressEnd={handlePttPressEnd}
                                isAudioBlocked={isAudioBlocked}
                                onToggleBlockAudio={toggleBlockAudio}
                                onOpenAddVideo={() => setPhoneSheet('add')}
                                onOpenMore={() => setPhoneSheet('more')}
                            />
                        </>
                    ) : showInvite ? (
                        <InviteScreen pin={initialJoinPin} username={username} onJoin={handleInviteJoin} onDismiss={dismissInvite} />
                    ) : (
                        <PhoneHome
                            username={username}
                            initialPin={initialJoinPin}
                            onCreate={handleInitiateCreate}
                            onJoin={handleInitiateJoin}
                            onOpenServerSettings={openServerSettings}
                            rejoin={rejoin}
                        />
                    )}
                    {renderAddVideoSheet()}
                    <MoreSheet
                        isOpen={phoneSheet === 'more'}
                        onClose={closePhoneSheet}
                        audioSettings={audioSettings}
                        onUpdateAudioSettings={handleUpdateAudioSettings}
                        onOpenAudioSettings={openAudioSettings}
                        onOpenSoundboard={() => setPhoneSheet('soundboard')}
                        onOpenNetworkHud={openNetworkHud}
                        networkStats={networkStats}
                        onOpenQrCode={openQrCode}
                        roomId={roomId}
                        onOpenServerSettings={openServerSettings}
                        onLeaveRoom={handleLeaveRoom}
                        isHost={isHost}
                        playbackLock={playbackLock}
                        onTogglePlaybackLock={hostControls.toggle}
                        activityMenu={activityMenu}
                        onStartActivity={startOrJoinActivity}
                        isScreenSharing={screenShare.isSharingScreen}
                        onToggleScreenShare={screenShare.toggleScreenShare}
                    />
                    <SoundboardSheet
                        isOpen={phoneSheet === 'soundboard'}
                        onClose={closePhoneSheet}
                        soundboardSettings={soundboard.soundboardSettings}
                        activeSoundboardSfx={soundboard.activeSoundboardSfx}
                        activeSfxCooldowns={soundboard.activeSfxCooldowns}
                        onPlaySoundboardClip={soundboard.playClip}
                        onSoundboardVolumeChange={soundboard.setVolume}
                        onToggleSoundboardMute={soundboard.toggleMute}
                    />
                </>
            ) : !roomId ? (
                showInvite ? (
                    <InviteScreen pin={initialJoinPin} username={username} onJoin={handleInviteJoin} onDismiss={dismissInvite} />
                ) : (
                    <DesktopHome
                        username={username}
                        onCreate={handleInitiateCreate}
                        onJoin={handleInitiateJoin}
                        onOpenServerSettings={openServerSettings}
                        rejoin={rejoin}
                        isOnline={signalStatus.connected}
                    />
                )
            ) : (
                <div className="room-desktop">
                    <Header
                        roomId={roomId}
                        onCopyRoom={handleCopyRoom}
                        isP2PConnected={isP2PConnected}
                        networkStats={networkStats}
                        peerCount={connectedPeers.length + 1}
                        onOpenNetworkHud={openNetworkHud}
                        onOpenQrCode={openQrCode}
                        playbackLock={playbackLock}
                        nowPlaying={nowPlaying}
                        isChatOpen={isChatOpen}
                        onToggleChat={handleToggleChat}
                        isMediaActive={isMediaActive || isScreenSharingActive}
                        onExitVideo={() => {
                            if (screenShare.isSharingScreen) {
                                screenShare.stopScreenShare();
                            } else if (screenShare.isScreenShareActive) {
                                screenShare.dismissScreenShare();
                            }
                            playback.exitVideo();
                        }}
                        onVoteSkip={queueFeature.voteSkip}
                        skipVotes={skipVotes}
                        connectedPeers={connectedPeers}
                        isHost={isHost}
                        username={username}
                        activityStatus={activityStatus}
                    />
                    <div className="room-desktop-body">
                        <div className="app-main-pane">
                            <main className="main-container">
                                {renderStage({
                                    onOpenAddVideo: () => setPhoneSheet('add'),
                                    onUpdateAudioSettings: handleUpdateAudioSettings,
                                    onSelectOutput: selectOutputDevice
                                })}
                            </main>
                        </div>
                        {renderChat()}
                    </div>
                    {renderAddVideoSheet()}
                </div>
            )}

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

            <ServerSettingsModal
                isOpen={SHOW_SERVER_SETTINGS && showSettingsModal}
                onClose={() => setShowSettingsModal(false)}
                currentUrl={signalUrl}
                onApply={handleApplyServer}
            />
            <AudioSettingsModal
                isOpen={showAudioSettingsModal}
                onClose={() => setShowAudioSettingsModal(false)}
                audioSettings={audioSettings}
                onUpdateAudioSettings={handleUpdateAudioSettings}
                onSelectOutput={selectOutputDevice}
                isMicMuted={isMicMuted}
                isPttActive={isPttActive}
                voiceIsolationSupported={micPipeline.isolationSupported}
                voiceIsolationStatus={voiceIsolationStatus}
            />
            <NetworkDiagnosticsModal
                isOpen={showNetworkHudModal}
                onClose={() => setShowNetworkHudModal(false)}
                networkStats={networkStats}
                peersStats={peersNetworkStats}
                roomId={roomId}
                username={username}
                onTriggerPing={handleTriggerPing}
            />
            <QrCodeModal
                isOpen={showQrModal}
                onClose={() => setShowQrModal(false)}
                roomId={roomId}
                username={username}
                signalUrl={signalUrl}
            />

            <ReactionsEditor />
            <LeaveRoomDialog
                isOpen={showLeaveDialog && Boolean(roomId)}
                roomId={roomId}
                isPlaying={isMediaActive || activityOn}
                onStay={closeLeaveDialog}
                onLeave={leaveRoomNow}
            />
            <PreJoinModal
                isOpen={preJoinConfig !== null}
                mode={preJoinConfig?.mode}
                pin={preJoinConfig?.pin}
                initialName={preJoinConfig?.name || username}
                audioSettings={audioSettings}
                onUpdateAudioSettings={handleUpdateAudioSettings}
                onSelectOutput={selectOutputDevice}
                onConfirm={handleConfirmPreJoin}
                onCancel={() => setPreJoinConfig(null)}
            />

            {roomId && <NetworkBlockedBanner hint={mesh.networkHint} onDismiss={mesh.dismissNetworkHint} />}
            {notices.toastMessage && <div className="toast">{notices.toastMessage}</div>}
        </div>
        </RoomProvider>
    );
}
