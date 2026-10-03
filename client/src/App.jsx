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

  const handleClearLogs = useCallback(() => {
    setSystemLogs([]);
  }, []);

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
          entry.audioElement = null;
        }
      } catch {}
      try { entry.dataChannel?.close(); } catch {}
      try { entry.pc?.close(); } catch {}
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
          entry.audioElement = null;
        }
      } catch {}
      try { entry.dataChannel?.close(); } catch {}
      try { entry.pc?.close(); } catch {}
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

    // Audio Transceiver for WebRTC Voice Chat (guarantees audio m-line in SDP offer/answer)
    try {
      const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (localStreamRef.current) {
        const audioTrack = localStreamRef.current.getAudioTracks()[0];
        if (audioTrack && !isMicMutedRef.current) {
          audioTransceiver.sender.replaceTrack(audioTrack).catch((err) => console.error(err));
        }
      }
    } catch (err) {
      console.warn('Failed to add audio transceiver:', err);
    }

    // Handle incoming audio stream from remote peer
    pc.ontrack = (event) => {
      const remoteStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      let audioEl = peerEntry.audioElement;
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        peerEntry.audioElement = audioEl;
      }
      audioEl.srcObject = remoteStream;
      audioEl.muted = isAudioBlockedRef.current;
      audioEl.play().catch((err) => {
        console.warn(`Autoplay prevented for peer ${targetPeerId}, will resume on user gesture:`, err);
        const resumeOnInteraction = () => {
          audioEl.play().catch(() => {});
          window.removeEventListener('click', resumeOnInteraction);
          window.removeEventListener('keydown', resumeOnInteraction);
        };
        window.addEventListener('click', resumeOnInteraction);
        window.addEventListener('keydown', resumeOnInteraction);
      });
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
        } catch (e) {}

        // Request YouTube sync state from existing room peers
        try {
          dc.send(JSON.stringify({ type: 'yt-request-sync' }));
        } catch (e) {}
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
  }, [addSystemMessage, handleRemoteYouTubeAction, handleRemoteLocalVideoAction, sendSignal, showToast, updateP2PStatus, username]);

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

          await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));

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
  }, [addSystemMessage, cleanupPeer, getOrCreatePeerConnection, sendSignal, showToast, username]);

  const handleSignalingMessageRef = useRef();
  handleSignalingMessageRef.current = handleSignalingMessage;

  // Connect to Signaling Server
  useEffect(() => {
    let isCancelled = false;

    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
    }

    setSignalStatus({ connected: false, label: 'Connecting...' });

    let ws;
    try {
      ws = new WebSocket(signalUrl);
      wsRef.current = ws;
    } catch {
      setSignalStatus({ connected: false, label: 'Connection Failed' });
      showToast(`Failed to connect to ${signalUrl}`);
      return;
    }

    ws.onopen = () => {
      if (isCancelled) return;
      setSignalStatus({ connected: true, label: 'Signaling Connected' });
      showToast('Signaling server connected');

      // Flush any queued signals
      while (pendingSignalsRef.current.length > 0) {
        const data = pendingSignalsRef.current.shift();
        ws.send(JSON.stringify(data));
      }
    };

    ws.onmessage = (event) => {
      if (isCancelled) return;
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessageRef.current?.(msg);
      } catch (err) {
        console.error('Signaling parse error:', err);
      }
    };

    ws.onclose = () => {
      if (isCancelled) return;
      setSignalStatus({ connected: false, label: 'Disconnected' });
    };

    ws.onerror = () => {
      if (isCancelled) return;
      setSignalStatus({ connected: false, label: 'Signaling Error' });
    };

    return () => {
      isCancelled = true;
      try { ws.close(); } catch {}
    };
  }, [signalUrl]);

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
      peerId: crypto.randomUUID()
    });
  };

  const handleConfirmJoin = (pin, displayName) => {
    setUsername(displayName);
    localStorage.setItem('webrtc_username', displayName);
    setShowJoinModal(false);
    sendSignal({
      type: 'join',
      roomId: pin,
      peerId: crypto.randomUUID()
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
        } catch {}
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
      }
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
          for (const peer of peersRef.current.values()) {
            if (peer.pc) {
              const senders = peer.pc.getSenders();
              const audioSender = senders.find((s) => !s.track || s.track.kind === 'audio');
              if (audioSender) {
                audioSender.replaceTrack(audioTrack).catch((err) => console.error('replaceTrack error:', err));
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
            try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch {}
          }
        }
      } catch (err) {
        console.error('Microphone access error:', err);
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
          try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch {}
        }
      }
    }
  }, [addSystemMessage, showToast, username]);

  // Voice Chat: Toggle Block Incoming Audio (Deafen) - blocks incoming audio AND microphone
  const toggleBlockAudio = useCallback(() => {
    setIsAudioBlocked((prev) => {
      const nextVal = !prev;
      isAudioBlockedRef.current = nextVal;

      // Mute/unmute all peer audio streams
      for (const peer of peersRef.current.values()) {
        if (peer.audioElement) {
          peer.audioElement.muted = nextVal;
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
            try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch {}
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
          isP2PConnected={isP2PConnected}
          username={username}
          isOpen={isChatOpen}
          onClose={() => setIsChatOpen(false)}
          isAudioBlocked={isAudioBlocked}
          onToggleBlockAudio={toggleBlockAudio}
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
