import React, { useState, useEffect, useRef, useCallback } from 'react';
import Header from './components/Header';
import Stage from './components/Stage';
import LiveChat from './components/LiveChat';
import CreateRoomModal from './components/CreateRoomModal';
import JoinRoomModal from './components/JoinRoomModal';
import ServerSettingsModal from './components/ServerSettingsModal';
import { sound } from './utils/sound';
import { copyToClipboard } from './utils/clipboard';
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
  const [localVideoFile, setLocalVideoFile] = useState(null);
  const [remoteLocalVideoMeta, setRemoteLocalVideoMeta] = useState(null);
  const [remoteAction, setRemoteAction] = useState(null);

  // UI Panels & Modals
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [initialJoinPin, setInitialJoinPin] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  // WebRTC Voice Chat State
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [isAudioBlocked, setIsAudioBlocked] = useState(false);
  const [peerVoiceStates, setPeerVoiceStates] = useState({});

  // Refs for Multi-Peer WebRTC Mesh (up to 3 users)
  // Map<targetPeerId, { pc, dataChannel, isConnected, candidateQueue, audioElement }>
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

  currentRoomRef.current = roomId;
  isHostRef.current = isHost;
  activeVideoIdRef.current = activeVideoId;
  isMicMutedRef.current = isMicMuted;
  isAudioBlockedRef.current = isAudioBlocked;

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

  const logLocalDebug = useCallback((tag, ...args) => {
    if (!IS_LOCAL) return;
    const formatted = args.map((a) => {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const logText = `[Voice-Debug] [${tag}] ${formatted}`;
    console.log(`%c${logText}`, 'color: #00e676; font-weight: bold;');
    addSystemMessage(logText, 'debug');
  }, [addSystemMessage]);

  const handleClearLogs = useCallback(() => {
    setSystemLogs([]);
  }, []);

  const handleTestSound = useCallback(() => {
    sound.playChime();
    logLocalDebug('TEST_SOUND', 'Played test chime via Web Audio. If you hear this chime, your browser tab audio output works!');
    showToast('🔊 Playing test sound...');
  }, [logLocalDebug, showToast]);

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
      try { entry.dataChannel?.close(); } catch { }
      try { entry.pc?.close(); } catch { }
      peersRef.current.delete(targetPeerId);
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
      try { entry.dataChannel?.close(); } catch { }
      try { entry.pc?.close(); } catch { }
    }
    peersRef.current.clear();
    setIsP2PConnected(false);
    setP2pStatusText('Waiting for peer to enter 5-digit code...');
    setLocalVideoFile(null);
    setRemoteLocalVideoMeta(null);
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
        } catch (err) {
          console.error('Error broadcasting yt-action to peer:', err);
        }
      }
    }
  }, [username]);

  // Handle incoming remote YouTube action
  const handleRemoteYouTubeAction = useCallback((data) => {
    if (data.action === 'close' || data.action === 'unload') {
      setActiveVideoId(null);
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
      const titleInfo = data.title ? `: "${data.title}"` : '';
      addSystemMessage(`🎬 ${data.sender || 'Peer'} loaded a YouTube video${titleInfo}`);
      showToast(`${data.sender || 'Peer'} loaded ${data.title || 'video'}`);
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
            audioTransceiver.sender.replaceTrack(audioTrack).catch((err) => console.error('Transceiver replaceTrack error:', err));
          }
        }
      } else {
        logLocalDebug('TRANSCEIVER_INIT', `Role: PEER/ANSWERER -> Peer: ${targetPeerId} (Awaiting offer to configure single audio transceiver)`);
      }
    } catch (err) {
      console.warn('Failed to configure audio transceiver:', err);
      logLocalDebug('TRANSCEIVER_INIT_ERR', err.message);
    }

    // Handle incoming audio stream from remote peer
    pc.ontrack = (event) => {
      console.log(`[WebRTC Audio] Remote track received from ${targetPeerId}:`, event.track.id, event.track.kind);
      logLocalDebug('ONTRACK', `Peer: ${targetPeerId} | Kind: ${event.track.kind} | Track ID: ${event.track.id} | Muted: ${event.track.muted} | ReadyState: ${event.track.readyState} | Streams: ${event.streams?.length || 0}`);

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
      audioEl.srcObject = remoteStream;
      audioEl.muted = isAudioBlockedRef.current;
      audioEl.volume = 1.0;
      if (typeof audioEl.setSinkId === 'function') {
        audioEl.setSinkId('').catch(() => {});
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
            ctx.resume().catch(() => {});
          }

          if (peerEntry.webAudioSource) {
            try { peerEntry.webAudioSource.disconnect(); } catch {}
          }
          if (peerEntry.webAudioGain) {
            try { peerEntry.webAudioGain.disconnect(); } catch {}
          }

          const srcNode = ctx.createMediaStreamSource(stream);
          const gainNode = ctx.createGain();
          gainNode.gain.value = isAudioBlockedRef.current ? 0 : 1.0;
          srcNode.connect(gainNode);
          gainNode.connect(ctx.destination);

          peerEntry.webAudioSource = srcNode;
          peerEntry.webAudioGain = gainNode;
          logLocalDebug('WEBAUDIO_ROUTED', `Peer: ${targetPeerId} -> Web Audio route connected (ctx: ${ctx.state})`);
        } catch (err) {
          logLocalDebug('WEBAUDIO_ERR', `AudioContext route error: ${err.message}`);
        }
      };

      connectWebAudioPipeline(remoteStream);

      // Handle when remote sender un-mutes and RTP packets arrive
      event.track.onunmute = () => {
        console.log(`[WebRTC Audio] Remote track onunmute for ${targetPeerId}`);
        logLocalDebug('TRACK_ONUNMUTE', `Peer: ${targetPeerId} - Incoming audio track unmuted! Refreshing audio sink & triggering play()`);
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
          console.warn(`Autoplay prevented for peer ${targetPeerId}, will resume on user gesture:`, err);
          logLocalDebug('INITIAL_PLAY_BLOCKED', `Peer: ${targetPeerId} Autoplay blocked (${err.name}): ${err.message}`);
          const resumeOnInteraction = () => {
            if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
              window.__webrtcAudioCtx.resume().catch(() => {});
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

      dc.onopen = () => {
        peerEntry.isConnected = true;
        updateP2PStatus();
        sound.playChime();
        addSystemMessage('Direct Peer-to-Peer DataChannel established. Chat & YouTube Sync is live!');
        showToast('Direct P2P Connected!');

        // Share initial voice mute status with peer
        try {
          dc.send(JSON.stringify({
            type: 'peer-voice-status',
            sender: username,
            isMuted: isMicMutedRef.current
          }));
        } catch (e) { }

        // Request YouTube sync state from existing room peers
        try {
          dc.send(JSON.stringify({ type: 'yt-request-sync' }));
        } catch (e) { }
      };

      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'chat') {
            setMessages((prev) => [...prev, { ...data, isSelf: false }]);
            sound.playPop();
          } else if (data.type === 'peer-voice-status') {
            setPeerVoiceStates((prev) => ({
              ...prev,
              [data.sender]: { isMuted: data.isMuted }
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
          } else if (data.type === 'yt-request-sync') {
            // A newly joined peer is asking for the current playing media & timestamp
            if (syncStateGetterRef.current) {
              const state = syncStateGetterRef.current();
              if (state) {
                if (state.mediaType === 'local' && state.fileName) {
                  dc.send(JSON.stringify({
                    type: 'local-video-sync-state',
                    ...state,
                    sender: username
                  }));
                } else if (state.videoId) {
                  dc.send(JSON.stringify({
                    type: 'yt-sync-state',
                    ...state,
                    sender: username
                  }));
                }
              }
            }
          } else if (data.type === 'yt-sync-state') {
            // Received sync state from an existing peer in the room
            if (data.videoId) {
              setLocalVideoFile(null);
              setRemoteLocalVideoMeta(null);
              setActiveVideoId(data.videoId);
              setRemoteAction({
                action: data.isPlaying ? 'play' : 'pause',
                currentTime: data.currentTime,
                newVideoId: data.videoId
              });
              addSystemMessage(`🔄 Synced YouTube playback with room`);
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
                sender: data.sender
              });
              addSystemMessage(`🔄 Synced with room's local video session: "${data.fileName}"`);
            }
          }
        } catch (e) {
          console.error('DataChannel message parse error:', e);
        }
      };

      dc.onclose = () => {
        peerEntry.isConnected = false;
        updateP2PStatus();
      };

      dc.onerror = (err) => {
        console.error('DataChannel error:', err);
      };
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
          console.error(`Error creating offer for ${targetPeerId}:`, err);
          logLocalDebug('OFFER_ERR', `Target: ${targetPeerId} error: ${err.message}`);
        });
      } catch (err) {
        console.error(`Failed to create data channel for ${targetPeerId}:`, err);
      }
    } else {
      pc.ondatachannel = (event) => {
        bindDataChannel(event.channel);
      };
    }

    return peerEntry;
  }, [addSystemMessage, handleRemoteYouTubeAction, handleRemoteLocalVideoAction, logLocalDebug, sendSignal, showToast, updateP2PStatus, username]);

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
            } catch (e) {
              console.error('Error adding queued candidate:', e);
            }
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
          console.error('Error handling offer:', err);
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
              } catch (e) {
                console.error('Error adding queued candidate:', e);
              }
            }
          }
        } catch (err) {
          console.error('Error handling answer:', err);
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
            } catch (e) {
              console.error('Error adding ICE candidate:', e);
            }
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
        } catch (err) {
          console.error('Signaling parse error:', err);
        }
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

  // Local telemetry: Monitor live WebRTC audio byte counters (outbound/inbound RTP) and element playback
  useEffect(() => {
    if (!IS_LOCAL) return;
    const interval = setInterval(async () => {
      if (peersRef.current.size === 0 || !isP2PConnected) return;
      for (const [peerId, peer] of peersRef.current.entries()) {
        if (!peer.pc) continue;
        const pcState = peer.pc.connectionState || peer.pc.iceConnectionState;
        if (pcState !== 'connected') continue;
        try {
          const stats = await peer.pc.getStats();
          let sentBytes = 0;
          let recvBytes = 0;
          let audioLevel = null;
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
              sentBytes = report.bytesSent || 0;
            }
            if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
              recvBytes = report.bytesReceived || 0;
              if (report.audioLevel !== undefined) audioLevel = report.audioLevel;
            }
          });
          const audioEl = peer.audioElement;
          const elStatus = audioEl ? `{paused: ${audioEl.paused}, muted: ${audioEl.muted}, vol: ${audioEl.volume}}` : 'null';
          const ctxState = window.__webrtcAudioCtx ? window.__webrtcAudioCtx.state : 'none';
          const webAudioActive = Boolean(peer.webAudioSource && peer.webAudioGain);
          logLocalDebug('AUDIO_TELEMETRY', `Peer ${peerId.slice(0, 6)} | Outbound: ${sentBytes}B | Inbound: ${recvBytes}B ${audioLevel !== null ? `(lvl: ${audioLevel})` : ''} | AudioEl: ${elStatus} | Ctx: ${ctxState} (routed: ${webAudioActive})`);
        } catch {}
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [isP2PConnected, logLocalDebug]);

  // Ensure AudioContext is resumed on any user interaction anywhere on the window
  useEffect(() => {
    const resumeAudioCtx = () => {
      if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
        window.__webrtcAudioCtx.resume().catch(() => {});
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
      addSystemMessage('Welcome to P2P Live! Create or join a 5-digit room to chat and watch YouTube together.');
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
      setIsMicMuted(true);
      setIsAudioBlocked(false);
      setPeerVoiceStates({});
      cleanupAllPeers();
      setRoomId(null);
      setIsHost(false);
      setPeerCount(0);
      setActiveVideoId(null);
      setLocalVideoFile(null);
      setRemoteLocalVideoMeta(null);
      setRemoteAction(null);
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

  const handleApplyServer = (newUrl) => {
    setSignalUrl(newUrl);
    localStorage.setItem('webrtc_signal_url', newUrl);
    showToast(`Connecting to ${newUrl}...`);
  };

  const handleVideoChange = useCallback((newId) => {
    if (newId) {
      setLocalVideoFile(null);
      setRemoteLocalVideoMeta(null);
    }
    setActiveVideoId(newId);
    if (newId) {
      addSystemMessage(`🎬 You loaded video ID: ${newId}`);
    } else {
      addSystemMessage(`🎬 You exited the video`);
    }
  }, [addSystemMessage]);

  const handleLocalFileSelect = useCallback((file) => {
    setActiveVideoId(null);
    setLocalVideoFile(file);
    addSystemMessage(`📁 You loaded local video: "${file.name}"`);
    showToast(`Loaded "${file.name}"`);
  }, [addSystemMessage, showToast]);

  const handleCloseLocalVideo = useCallback(() => {
    setLocalVideoFile(null);
    setRemoteLocalVideoMeta(null);
    addSystemMessage(`📁 You exited the local video`);
  }, [addSystemMessage]);

  const isMediaActive = Boolean(activeVideoId || localVideoFile || remoteLocalVideoMeta);

  const handleExitVideo = useCallback(() => {
    if (localVideoFile || remoteLocalVideoMeta) {
      handleCloseLocalVideo();
      handleBroadcastAction('close', { type: 'local-video-action' });
    } else if (activeVideoId) {
      handleVideoChange(null);
      handleBroadcastAction('close', {});
    }
  }, [localVideoFile, remoteLocalVideoMeta, activeVideoId, handleCloseLocalVideo, handleVideoChange, handleBroadcastAction]);

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
      window.__webrtcAudioCtx.resume().catch(() => {});
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
        console.error('Microphone access error:', err);
        logLocalDebug('MIC_ACCESS_ERR', `${err.name}: ${err.message}`);
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
      for (const peer of peersRef.current.values()) {
        if (peer.audioElement) {
          peer.audioElement.muted = nextVal;
        }
        if (peer.webAudioGain) {
          peer.webAudioGain.gain.value = nextVal ? 0 : 1.0;
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

  return (
    <>
      <Header
        isLive={Boolean(roomId)}
        roomId={roomId}
        onCopyRoom={handleCopyRoom}
        signalStatus={signalStatus}
        onOpenSettings={() => setShowSettingsModal(true)}
        username={username}
        isMicMuted={isMicMuted}
        isAudioBlocked={isAudioBlocked}
        onToggleMic={toggleMicrophone}
        onToggleBlockAudio={toggleBlockAudio}
        isLocal={IS_LOCAL}
        isP2PConnected={isP2PConnected}
        p2pStatusText={p2pStatusText}
        isMediaActive={isMediaActive}
        onExitVideo={handleExitVideo}
        onLeaveRoom={handleLeaveRoom}
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
          activeVideoId={activeVideoId}
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
          isMicMuted={isMicMuted}
          isAudioBlocked={isAudioBlocked}
          onToggleMic={toggleMicrophone}
          onToggleBlockAudio={toggleBlockAudio}
          peerVoiceStates={peerVoiceStates}
        />

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
          isLocal={IS_LOCAL}
        />
      </main>

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

      {IS_LOCAL && (
        <ServerSettingsModal
          isOpen={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          currentUrl={signalUrl}
          onApply={handleApplyServer}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && <div className="toast">{toastMessage}</div>}
    </>
  );
}