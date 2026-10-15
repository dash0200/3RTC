/**
 * The app shell: creates the room (connection layer + bus), plugs the features into it, and lays
 * out the desktop or phone screen. Feature logic lives in features/*, connection logic in
 * webrtc/*, and the shared plumbing in core/* (see docs/ARCHITECTURE.md).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Header from './components/Header';
import Stage from './components/Stage';
import LiveChat from './components/LiveChat';
import CreateRoomModal from './components/CreateRoomModal';
import JoinRoomModal from './components/JoinRoomModal';
import ServerSettingsModal from './components/ServerSettingsModal';
import AudioSettingsModal from './components/AudioSettingsModal';
import NetworkDiagnosticsModal from './components/NetworkDiagnosticsModal';
import QrCodeModal from './components/QrCodeModal';
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
import { useQueue } from './features/queue/useQueue';
import { useActivities } from './features/activities/useActivities';
import ActivityStage from './features/activities/ActivityStage';
import ReactionsEditor from './features/reactions/ReactionsEditor';
import './App.css';
import './phone.css';
import { useNewVersionNotice } from './pwa/useNewVersionNotice';
import { useBackLayer, useRoomBackGuard } from './core/backStack';
import LeaveRoomDialog from './components/LeaveRoomDialog';
import { saveLastRoom, readLastRoom, forgetLastRoom } from './utils/lastRoom';

const DEFAULT_SIGNAL_URL = 'wss://signal.3rtc.me';
// Same server under its raw address, used if signal.3rtc.me can't be reached (DNS, certificate)
const BACKUP_SIGNAL_URLS = ['wss://34.57.36.145.sslip.io:443'];
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
    const [signalUrl, setSignalUrl] = useState(() => (IS_LOCAL && localStorage.getItem('webrtc_signal_url')) || DEFAULT_SIGNAL_URL);
    const fallbackUrls = signalUrl === DEFAULT_SIGNAL_URL ? BACKUP_SIGNAL_URLS : undefined;
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
    const usernameRef = useRef(username);
    usernameRef.current = username;
    const [peerMetadata, setPeerMetadata] = useState({}); // { [peerId]: { username, isHost, isMuted } }
    const peerMetadataRef = useRef(peerMetadata);
    peerMetadataRef.current = peerMetadata;
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
        const connectedPeers = () => bus.connectedPeerIds().map((peerId) => ({ peerId, isHost: Boolean(peerMetadataRef.current[peerId]?.isHost) }));
        return {
            bus,
            getSelfId: () => peerIdRef.current,
            getSelf: () => ({ peerId: peerIdRef.current, username: usernameRef.current, isHost: isHostRef.current }),
            isPeerHost: (id) => (id === peerIdRef.current ? isHostRef.current : Boolean(peerMetadataRef.current[id]?.isHost)),
            getHostPeerId: () => Object.entries(peerMetadataRef.current).find(([, m]) => m?.isHost)?.[0] || null,
            peerName: (id) => peerMetadataRef.current[id]?.username || null,
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
        handlePttPressEnd, toggleBlockAudio, handleSetPeerVolume, handleToggleMutePeer
    } = voice;

    const mesh = usePeerMesh({
        bus, peersRef, peerIdRef, isHostRef, setPeerMetadata, username, notices, voice,
        identityFields: () => identityFieldsRef.current(),
        signalUrl, fallbackUrls, setSignalStatus, logLocalDebug
    });
    const { roomId, isHost, peerCount, isP2PConnected, p2pStatusText } = mesh;

    // ---- features ----------------------------------------------------------------------------
    const hostControls = useHostControls({ room, isHost, peerMetadata });
    identityFieldsRef.current = hostControls.identityFields;
    roomSettingsRef.current = () => ({ playbackLock: hostControls.playbackLockRef.current });
    const { playbackLock } = hostControls;

    const playback = usePlayback({ room, hostControls });
    useStreamTransfer({ room, playback });
    const queueFeature = useQueue({ room, playback, hostControls, peerCount });
    useMediaSync({ room, playback, queue: queueFeature, hostControls });
    const {
        activeVideoId, activeVideoTitle, localVideoFile, remoteLocalVideoMeta, remoteAction, streamProgress, streamVideoUrl, isMediaActive
    } = playback;
    const { queue, skipVotes } = queueFeature;

    const [isChatOpen, setIsChatOpen] = useState(() => !(typeof window !== 'undefined' && window.innerWidth <= 768));
    const [sidebarTab, setSidebarTab] = useState('chat');
    const activities = useActivities({ room, hostControls, peopleCount: roomId ? peerCount : 0 });
    const isPhone = useIsPhone();
    const [activityChatSplit, setActivityChatSplit] = useState(() => {
        try { return localStorage.getItem('3rtc_activity_chat') === '1'; } catch { return false; }
    });
    // Unread count: on phones the chat list is on screen when its tab is picked (and, with a game
    // open, when the game's "Chat" view is on); on computers when the chat panel is open
    const phoneChatOnScreen = sidebarTab === 'chat' && (!activities.current || activityChatSplit);
    const chat = useChat({ room, isChatOpen: isPhone ? phoneChatOnScreen : isChatOpen });
    const reactions = useReactions({ room, isAudioBlockedRef, inRoom: Boolean(roomId) });
    const soundboard = useSoundboard({ room, isAudioBlockedRef });
    const { networkStats, peersNetworkStats, handleTriggerPing } = useNetworkStats({ activeVideoId, bus, localVideoFile, peerMetadata, peersRef, roomId, showToast });

    // ---- screens and dialogs -----------------------------------------------------------------
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showJoinModal, setShowJoinModal] = useState(false);
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
            setInitialJoinPin(roomParam);
            setShowJoinModal(true);
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
    useWakeLock(Boolean(roomId) && isMediaActive);

    // ---- room actions ------------------------------------------------------------------------
    const rememberName = (displayName) => {
        setUsername(displayName);
        usernameRef.current = displayName;
        localStorage.setItem('webrtc_username', displayName);
    };
    const handleConfirmCreate = (displayName) => {
        rememberName(displayName);
        setShowCreateModal(false);
        mesh.createRoom();
    };
    const handleConfirmJoin = (pin, displayName) => {
        rememberName(displayName);
        setShowJoinModal(false);
        mesh.joinRoom(pin);
    };
    const leaveRoomNow = () => {
        setShowLeaveDialog(false);
        voice.resetVoice();
        mesh.leaveRoom(); // emits 'room-left': every feature resets itself
        addSystemMessage('You left the room.');
        showToast('Left room');
    };
    const handleLeaveRoom = () => {
        if (!window.confirm('Leave this room and end P2P connection?')) return;
        leaveRoomNow();
    };

    // ---- Back button, rejoining, closing the tab -----------------------------------------------
    // Back in a room closes what's open on top, else asks before leaving (core/backStack.js).
    // Playing videos are never closed by Back: they have their own Exit button.
    const [showLeaveDialog, setShowLeaveDialog] = useState(false);
    const closeLeaveDialog = useCallback(() => setShowLeaveDialog(false), []);
    useRoomBackGuard(roomId, () => setShowLeaveDialog(true));
    useEffect(() => { if (!roomId) setShowLeaveDialog(false); }, [roomId]);
    useBackLayer(Boolean(phoneSheet), closePhoneSheet);
    useBackLayer(showCreateModal, () => setShowCreateModal(false));
    useBackLayer(showJoinModal, () => setShowJoinModal(false));
    useBackLayer(showSettingsModal, () => setShowSettingsModal(false));
    useBackLayer(showAudioSettingsModal, () => setShowAudioSettingsModal(false));
    useBackLayer(showNetworkHudModal, () => setShowNetworkHudModal(false));
    useBackLayer(showQrModal, () => setShowQrModal(false));
    useBackLayer(isPhone && activityChatSplit && Boolean(activities.current), () => setActivityChatSplit(false));

    // The room you were last in: "Rejoin" on the home screen for a while (utils/lastRoom.js)
    const [lastRoom, setLastRoom] = useState(() => readLastRoom());
    useEffect(() => {
        if (!roomId) {
            setLastRoom(readLastRoom());
            return undefined;
        }
        const save = () => saveLastRoom(roomId, isHost);
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
            if (lastRoom.wasHost) mesh.createRoom(lastRoom.roomId);
            else mesh.joinRoom(lastRoom.roomId);
        },
        onDismiss: () => {
            forgetLastRoom();
            setLastRoom(null);
        }
    } : null;

    // Closing or reloading the tab mid-video or mid-game: the browser asks first
    const busyInRoom = Boolean(roomId) && (isMediaActive || Boolean(activities.current));
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
                isHost: Boolean(meta.isHost),
                isMuted: meta.isMuted !== undefined ? meta.isMuted : (voiceState.isMuted !== undefined ? voiceState.isMuted : true),
                volume: peerVolumes[peerId] !== undefined ? peerVolumes[peerId] : 1.0,
                isLocalMuted: Boolean(localMutedPeers[peerId]),
                build: meta.build || null
            });
        }
        return list;
        // peerCount / isP2PConnected: the peer map itself isn't state
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peerMetadata, peerVoiceStates, peerVolumes, localMutedPeers, peerCount, isP2PConnected]);

    const localUser = useMemo(() => (roomId ? {
        id: peerIdRef.current, peerId: peerIdRef.current, username, isHost, isMuted: isMicMuted, isSelf: true
    } : null), [roomId, username, isHost, isMicMuted]);

    // What components deeper down read with useRoom()
    const roomContext = useMemo(() => ({ ...room, roomId, isHost, username, peers: connectedPeers, playbackLock }),
        [room, roomId, isHost, username, connectedPeers, playbackLock]);

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
        <ActivityStage activity={activities.current} definition={activities.definition} onClose={activities.stop} selfId={peerIdRef.current} chat={activityChat} />
    ) : null;

    // Stage and chat panel: shared by the desktop and phone layouts (same props, layout extras)
    const renderStage = (extra = {}) => (
        <Stage
            roomId={roomId}
            isHost={isHost}
            playbackLock={playbackLock}
            onTogglePlaybackLock={hostControls.toggle}
            peerCount={peerCount}
            isP2PConnected={isP2PConnected}
            p2pStatusText={p2pStatusText}
            rejoin={rejoin}
            onOpenCreate={() => setShowCreateModal(true)}
            onOpenJoin={() => {
                setInitialJoinPin('');
                setShowJoinModal(true);
            }}
            onCopyRoom={handleCopyRoom}
            onLeaveRoom={handleLeaveRoom}
            onToggleChat={() => setIsChatOpen((prev) => !prev)}
            isChatOpen={isChatOpen}
            unreadChatCount={chat.unreadChatCount}
            chatCount={chat.unreadChatCount}
            activeVideoId={activeVideoId}
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
            activityMenu={activities.menu}
            onStartActivity={activities.start}
            {...extra}
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
            isAudioBlocked={isAudioBlocked}
            onToggleBlockAudio={toggleBlockAudio}
            signalStatus={signalStatus}
            onOpenSettings={openServerSettings}
            queue={queue}
            activeVideoId={activeVideoId}
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
                        onCopyRoom={handleCopyRoom}
                        networkStats={networkStats}
                        isP2PConnected={isP2PConnected}
                        signalStatus={signalStatus}
                        onOpenNetworkHud={openNetworkHud}
                        playbackLock={playbackLock}
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
                    ) : (
                        <PhoneHome
                            username={username}
                            initialPin={initialJoinPin}
                            onCreate={handleConfirmCreate}
                            onJoin={handleConfirmJoin}
                            onOpenServerSettings={openServerSettings}
                            rejoin={rejoin}
                        />
                    )}
                    <AddVideoSheet
                        isOpen={phoneSheet === 'add'}
                        onClose={closePhoneSheet}
                        isMediaActive={isMediaActive}
                        onLoadYouTube={(id, title) => {
                            playback.changeVideo(id, title);
                            playback.broadcastAction('load', { newVideoId: id, title });
                        }}
                        onQueueYouTube={(id, title) => queueFeature.addToQueue({ videoId: id, title })}
                        onQueuePick={(id, title) => queueFeature.addToQueue({ videoId: id, title }, { autoplay: false })}
                        queuedIds={queue.map((item) => item.videoId)}
                        onPlayQueue={queue.length > 0 && !isMediaActive ? queueFeature.playNextInQueue : undefined}
                        onPickFile={playback.selectLocalFile}
                        onStopVideo={playback.exitVideo}
                    />
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
                        activityMenu={activities.menu}
                        onStartActivity={activities.start}
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
            ) : (
                <>
                    <div className="app-main-pane">
                        <Header
                            isLive={Boolean(roomId)}
                            roomId={roomId}
                            playbackLock={playbackLock}
                            onCopyRoom={handleCopyRoom}
                            isMicMuted={isMicMuted}
                            isAudioBlocked={isAudioBlocked}
                            onToggleMic={toggleMicrophone}
                            onToggleBlockAudio={toggleBlockAudio}
                            isP2PConnected={isP2PConnected}
                            p2pStatusText={p2pStatusText}
                            isMediaActive={isMediaActive}
                            onExitVideo={playback.exitVideo}
                            onLeaveRoom={handleLeaveRoom}
                            isChatOpen={isChatOpen}
                            unreadChatCount={chat.unreadChatCount}
                            onToggleChat={() => setIsChatOpen((prev) => !prev)}
                            audioSettings={audioSettings}
                            onOpenAudioSettings={openAudioSettings}
                            isPttActive={isPttActive}
                            peerCount={connectedPeers.length + 1}
                            onOpenSettings={openServerSettings}
                            networkStats={networkStats}
                            onOpenNetworkHud={openNetworkHud}
                            onOpenQrCode={openQrCode}
                        />
                        <main className="main-container">
                            {renderStage()}
                        </main>
                    </div>
                    {renderChat()}
                </>
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

            <CreateRoomModal
                isOpen={showCreateModal && !isPhone}
                onClose={() => setShowCreateModal(false)}
                onConfirm={handleConfirmCreate}
                currentUsername={username}
            />
            <JoinRoomModal
                isOpen={showJoinModal && !isPhone}
                onClose={() => setShowJoinModal(false)}
                onConfirm={handleConfirmJoin}
                currentUsername={username}
                initialPin={initialJoinPin}
            />
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
            />

            <ReactionsEditor />
            <LeaveRoomDialog
                isOpen={showLeaveDialog && Boolean(roomId)}
                roomId={roomId}
                isPlaying={isMediaActive || Boolean(activities.current)}
                onStay={closeLeaveDialog}
                onLeave={leaveRoomNow}
            />

            {notices.toastMessage && <div className="toast">{notices.toastMessage}</div>}
        </div>
        </RoomProvider>
    );
}
