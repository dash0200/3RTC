/**
 * WebRTC P2P Live Studio & YouTube-style Live Chat
 * Direct peer-to-peer data channels negotiated via WebSocket signaling.
 */

// Default configuration
const DEFAULT_SIGNAL_URL = 'wss://34.57.36.145.sslip.io:443';
const LOCAL_SIGNAL_URL = 'ws://localhost:8080';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// App State
const state = {
  signalUrl: localStorage.getItem('webrtc_signal_url') || DEFAULT_SIGNAL_URL,
  username: localStorage.getItem('webrtc_username') || `User_${Math.floor(100 + Math.random() * 900)}`,
  roomId: null,
  peerId: null,
  isHost: false,
  peerCount: 0,
  ws: null,
  pc: null,
  dataChannel: null,
  isP2PConnected: false,
  isAutoScroll: true,
  unreadCount: 0
};

// DOM Elements
const elements = {
  signalIndicator: document.getElementById('signalIndicator'),
  signalStatus: document.getElementById('signalStatus'),
  serverSettingsBtn: document.getElementById('serverSettingsBtn'),
  myAvatar: document.getElementById('myAvatar'),
  myUsernameDisplay: document.getElementById('myUsernameDisplay'),
  livePill: document.getElementById('livePill'),
  liveStatusText: document.getElementById('liveStatusText'),
  roomStatusChip: document.getElementById('roomStatusChip'),
  chipRoomCode: document.getElementById('chipRoomCode'),
  chipCopyBtn: document.getElementById('chipCopyBtn'),
  
  // Stage
  stageTitle: document.getElementById('stageTitle'),
  stageSubtitle: document.getElementById('stageSubtitle'),
  initialActions: document.getElementById('initialActions'),
  activeRoomDisplay: document.getElementById('activeRoomDisplay'),
  activeCodeDigits: document.getElementById('activeCodeDigits'),
  copyShareBtn: document.getElementById('copyShareBtn'),
  p2pStatusCard: document.getElementById('p2pStatusCard'),
  p2pStatusText: document.getElementById('p2pStatusText'),
  peerCountText: document.getElementById('peerCountText'),
  dataChannelBadge: document.getElementById('dataChannelBadge'),
  leaveBtn: document.getElementById('leaveBtn'),
  toggleChatBtn: document.getElementById('toggleChatBtn'),

  // Chat
  chatSection: document.getElementById('chatSection'),
  closeChatBtn: document.getElementById('closeChatBtn'),
  chatMessagesContainer: document.getElementById('chatMessagesContainer'),
  chatMessagesInner: document.getElementById('chatMessagesInner'),
  scrollBottomPill: document.getElementById('scrollBottomPill'),
  chatTextarea: document.getElementById('chatTextarea'),
  sendBtn: document.getElementById('sendBtn'),
  charCount: document.getElementById('charCount'),
  inputAvatar: document.getElementById('inputAvatar'),
  inputSenderName: document.getElementById('inputSenderName'),
  
  // Modals
  createRoomModal: document.getElementById('createRoomModal'),
  joinRoomModal: document.getElementById('joinRoomModal'),
  serverSettingsModal: document.getElementById('serverSettingsModal'),
  btnOpenCreate: document.getElementById('btnOpenCreate'),
  btnOpenJoin: document.getElementById('btnOpenJoin'),
  btnConfirmCreate: document.getElementById('btnConfirmCreate'),
  btnConfirmJoin: document.getElementById('btnConfirmJoin'),
  createUsername: document.getElementById('createUsername'),
  joinUsername: document.getElementById('joinUsername'),
  pinBoxes: document.querySelectorAll('.pin-box'),
  pinError: document.getElementById('pinError'),
  customWsUrl: document.getElementById('customWsUrl'),
  presetCloudBtn: document.getElementById('presetCloudBtn'),
  presetLocalBtn: document.getElementById('presetLocalBtn'),
  btnApplyServer: document.getElementById('btnApplyServer'),
  toast: document.getElementById('toast')
};

// ==========================================================================
// Web Audio Synthesizer (Sweet Sound Effects for Messages & Connect)
// ==========================================================================
class SoundFx {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
  }

  playPop() {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.08);
    } catch {}
  }

  playChime() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);
        gain.gain.setValueAtTime(0.1, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.25);
      });
    } catch {}
  }
}
const sound = new SoundFx();

// ==========================================================================
// User Avatars & Color Helpers
// ==========================================================================
function getAvatarColor(name) {
  const colors = [
    'linear-gradient(135deg, #f43f5e, #e11d48)',
    'linear-gradient(135deg, #a855f7, #7c3aed)',
    'linear-gradient(135deg, #3b82f6, #2563eb)',
    'linear-gradient(135deg, #10b981, #059669)',
    'linear-gradient(135deg, #f59e0b, #d97706)',
    'linear-gradient(135deg, #06b6d4, #0891b2)'
  ];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function updateProfileUI() {
  const initial = (state.username[0] || 'U').toUpperCase();
  elements.myAvatar.textContent = initial;
  elements.myAvatar.style.background = getAvatarColor(state.username);
  elements.myUsernameDisplay.textContent = state.username;
  elements.inputAvatar.textContent = initial;
  elements.inputAvatar.style.background = getAvatarColor(state.username);
  elements.inputSenderName.textContent = `Chatting as ${state.username}`;
  elements.createUsername.value = state.username;
  elements.joinUsername.value = state.username;
}

// ==========================================================================
// WebSocket Signaling Client
// ==========================================================================
function connectSignaling() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
  }

  setSignalStatus('connecting', 'Connecting...');
  
  try {
    state.ws = new WebSocket(state.signalUrl);
  } catch (err) {
    setSignalStatus('error', 'Connection Failed');
    showToast(`Failed to connect to ${state.signalUrl}`);
    return;
  }

  state.ws.onopen = () => {
    setSignalStatus('connected', 'Signaling Connected');
    showToast('Signaling server connected');
  };

  state.ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    handleSignalingMessage(msg);
  };

  state.ws.onclose = () => {
    setSignalStatus('disconnected', 'Disconnected');
    if (state.roomId) {
      showToast('Signaling server disconnected. Reconnecting...');
      setTimeout(connectSignaling, 3000);
    }
  };

  state.ws.onerror = () => {
    setSignalStatus('error', 'Signaling Error');
  };
}

function setSignalStatus(type, label) {
  elements.signalIndicator.className = `signal-indicator ${type === 'connected' ? 'connected' : ''}`;
  elements.signalStatus.textContent = label;
}

function sendSignal(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

// ==========================================================================
// Signaling Message Handler
// ==========================================================================
async function handleSignalingMessage(msg) {
  switch (msg.type) {
    case 'room-created': {
      state.roomId = msg.roomId;
      state.peerId = msg.peerId;
      state.isHost = true;
      onRoomJoined(msg.roomId, true);
      break;
    }

    case 'joined': {
      state.roomId = msg.roomId;
      state.peerId = msg.peerId;
      onRoomJoined(msg.roomId, false);

      // If existing peers are in the room, initiate WebRTC connection
      if (msg.peers && msg.peers.length > 0) {
        state.peerCount = msg.peers.length + 1;
        updatePeerCountUI();
        initiateWebRTC(true);
      }
      break;
    }

    case 'peer-joined': {
      state.peerCount = 2;
      updatePeerCountUI();
      addSystemMessage(`A peer entered room ${state.roomId}. Establishing P2P connection...`);
      elements.p2pStatusText.textContent = 'Connecting direct P2P data channel...';
      elements.p2pStatusCard.classList.remove('connected');

      // The existing peer (Host) initiates the WebRTC offer
      initiateWebRTC(true);
      break;
    }

    case 'offer': {
      // Received WebRTC SDP Offer
      await handleWebRTCOffer(msg.offer);
      break;
    }

    case 'answer': {
      // Received WebRTC SDP Answer
      await handleWebRTCAnswer(msg.answer);
      break;
    }

    case 'ice-candidate': {
      // Received ICE Candidate
      if (state.pc && msg.candidate) {
        try {
          await state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
      break;
    }

    case 'peer-left': {
      state.peerCount = 1;
      updatePeerCountUI();
      addSystemMessage('Peer disconnected from room.');
      resetP2PState();
      elements.p2pStatusText.textContent = `Waiting for peer to enter 5-digit code (${state.roomId})...`;
      break;
    }

    case 'error': {
      showToast(msg.message || 'Signaling error');
      if (msg.message && msg.message.includes('roomId')) {
        elements.pinError.textContent = msg.message;
        elements.pinError.style.display = 'block';
      }
      break;
    }
  }
}

// ==========================================================================
// WebRTC P2P Handshake (RTCDataChannel)
// ==========================================================================
async function initiateWebRTC(isInitiator) {
  cleanupWebRTC();

  state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({
        type: 'ice-candidate',
        candidate: event.candidate
      });
    }
  };

  state.pc.onconnectionstatechange = () => {
    if (state.pc) {
      if (state.pc.connectionState === 'disconnected' || state.pc.connectionState === 'failed') {
        resetP2PState();
      }
    }
  };

  if (isInitiator) {
    // Creator sets up the Data Channel
    try {
      state.dataChannel = state.pc.createDataChannel('yt-live-chat', {
        ordered: true
      });
      setupDataChannel(state.dataChannel);

      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);

      sendSignal({
        type: 'offer',
        offer: {
          type: offer.type,
          sdp: offer.sdp
        }
      });
    } catch (err) {
      console.error('Offer creation error:', err);
    }
  } else {
    // Receiver listens for incoming Data Channel
    state.pc.ondatachannel = (event) => {
      state.dataChannel = event.channel;
      setupDataChannel(state.dataChannel);
    };
  }
}

async function handleWebRTCOffer(offerSdp) {
  if (!state.pc) {
    await initiateWebRTC(false);
  }

  await state.pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);

  sendSignal({
    type: 'answer',
    answer: {
      type: answer.type,
      sdp: answer.sdp
    }
  });
}

async function handleWebRTCAnswer(answerSdp) {
  if (state.pc) {
    await state.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
  }
}

function setupDataChannel(channel) {
  channel.onopen = () => {
    state.isP2PConnected = true;
    sound.playChime();
    
    elements.p2pStatusCard.classList.add('connected');
    elements.p2pStatusText.textContent = 'Direct P2P DataChannel Active (Zero Server Latency)';
    elements.dataChannelBadge.textContent = 'P2P DIRECT LIVE';
    elements.dataChannelBadge.classList.add('active');
    
    // Enable Chat Input
    elements.chatTextarea.disabled = false;
    elements.chatTextarea.placeholder = 'Chat publicly as ' + state.username + '...';
    elements.chatTextarea.focus();

    addSystemMessage('Direct Peer-to-Peer DataChannel established. Chat is live!');
    showToast('Direct P2P Connected!');
  };

  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat') {
        renderChatMessage(data, false);
        sound.playPop();
      }
    } catch (e) {
      console.error('Data channel error:', e);
    }
  };

  channel.onclose = () => {
    resetP2PState();
    addSystemMessage('P2P DataChannel closed.');
  };

  channel.onerror = (err) => {
    console.error('DataChannel error:', err);
  };
}

function resetP2PState() {
  state.isP2PConnected = false;
  elements.p2pStatusCard.classList.remove('connected');
  elements.dataChannelBadge.textContent = 'P2P IDLE';
  elements.dataChannelBadge.classList.remove('active');
  elements.chatTextarea.disabled = true;
  elements.chatTextarea.placeholder = 'Waiting for P2P connection...';
  elements.sendBtn.disabled = true;
}

function cleanupWebRTC() {
  if (state.dataChannel) {
    try { state.dataChannel.close(); } catch {}
    state.dataChannel = null;
  }
  if (state.pc) {
    try { state.pc.close(); } catch {}
    state.pc = null;
  }
  resetP2PState();
}

// ==========================================================================
// Room UI Lifecycle
// ==========================================================================
function onRoomJoined(roomId, isHost) {
  elements.roomStatusChip.style.display = 'flex';
  elements.chipRoomCode.textContent = roomId;
  elements.livePill.classList.add('active');
  elements.liveStatusText.textContent = 'LIVE';

  // Render digits in the banner
  const digits = String(roomId).padStart(5, '0').split('');
  elements.activeCodeDigits.innerHTML = digits.map(d => `<span class="digit-box">${d}</span>`).join('');

  elements.initialActions.style.display = 'none';
  elements.activeRoomDisplay.style.display = 'block';
  elements.leaveBtn.style.display = 'flex';

  elements.stageTitle.textContent = `Room ${roomId}`;
  elements.stageSubtitle.textContent = isHost 
    ? 'Share this 5-digit code with your peer to establish direct P2P connection.'
    : 'Joined room. Synchronizing with room host...';

  state.peerCount = 1;
  updatePeerCountUI();

  addSystemMessage(`You joined room ${roomId} as "${state.username}".`);
}

function leaveRoom() {
  if (state.roomId) {
    sendSignal({ type: 'leave' });
  }

  cleanupWebRTC();

  state.roomId = null;
  state.isHost = false;
  state.peerCount = 0;

  elements.roomStatusChip.style.display = 'none';
  elements.livePill.classList.remove('active');
  elements.liveStatusText.textContent = 'OFFLINE';

  elements.initialActions.style.display = 'flex';
  elements.activeRoomDisplay.style.display = 'none';
  elements.leaveBtn.style.display = 'none';

  elements.stageTitle.textContent = 'P2P Video & Live Chat';
  elements.stageSubtitle.textContent = 'Create a 5-digit room or enter an existing code to connect peer-to-peer.';

  updatePeerCountUI();
  addSystemMessage('You left the room.');
  showToast('Left room');
}

function updatePeerCountUI() {
  elements.peerCountText.textContent = `${state.peerCount} Connected`;
}

// ==========================================================================
// YouTube Live Chat Rendering & Mechanics
// ==========================================================================
function sendChatMessage(text) {
  const clean = text.trim();
  if (!clean) return;

  const msgPayload = {
    type: 'chat',
    id: crypto.randomUUID(),
    sender: state.username,
    isHost: state.isHost,
    text: clean,
    timestamp: Date.now()
  };

  // Send over direct WebRTC DataChannel
  if (state.dataChannel && state.dataChannel.readyState === 'open') {
    state.dataChannel.send(JSON.stringify(msgPayload));
  } else {
    showToast('Direct P2P channel not connected yet');
    return;
  }

  // Render locally
  renderChatMessage(msgPayload, true);
  sound.playPop();

  // Reset Input
  elements.chatTextarea.value = '';
  elements.charCount.textContent = '0/200';
  elements.sendBtn.disabled = true;
  elements.chatTextarea.style.height = 'auto';
}

function renderChatMessage(msg, isSelf) {
  const container = elements.chatMessagesInner;
  const msgEl = document.createElement('div');
  msgEl.className = 'yt-message';

  const date = new Date(msg.timestamp || Date.now());
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const initial = (msg.sender[0] || '?').toUpperCase();
  const avatarBg = getAvatarColor(msg.sender);

  const badgeHtml = msg.isHost ? '<span class="yt-badge">HOST</span>' : '';
  const authorClass = isSelf ? 'self' : 'peer';

  msgEl.innerHTML = `
    <div class="yt-avatar" style="background: ${avatarBg};">${initial}</div>
    <div class="yt-message-content">
      <span class="yt-timestamp">${timeStr}</span>
      <span class="yt-author ${authorClass}">${escapeHtml(msg.sender)}</span>
      ${badgeHtml}
      <span class="yt-text">${escapeHtml(msg.text)}</span>
    </div>
  `;

  container.appendChild(msgEl);

  // Auto-scroll logic (like YouTube live chat)
  const scroller = elements.chatMessagesContainer;
  const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

  if (isSelf || isNearBottom || state.isAutoScroll) {
    scroller.scrollTop = scroller.scrollHeight;
    elements.scrollBottomPill.classList.remove('visible');
  } else {
    // User is scrolled up: show "New messages" pill
    elements.scrollBottomPill.classList.add('visible');
  }
}

function addSystemMessage(text) {
  const container = elements.chatMessagesInner;
  const sysEl = document.createElement('div');
  sysEl.className = 'yt-system-msg';
  sysEl.innerHTML = `<span>${escapeHtml(text)}</span>`;
  container.appendChild(sysEl);

  const scroller = elements.chatMessagesContainer;
  scroller.scrollTop = scroller.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================================================
// 5-Digit PIN Input Controller
// ==========================================================================
function setupPinInputs() {
  const boxes = Array.from(elements.pinBoxes);

  boxes.forEach((box, index) => {
    // Handle input
    box.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '');
      box.value = val ? val[val.length - 1] : '';

      if (box.value && index < boxes.length - 1) {
        boxes[index + 1].focus();
      }

      validatePin();
    });

    // Handle backspace
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && index > 0) {
        boxes[index - 1].focus();
      }
      if (e.key === 'Enter') {
        if (!elements.btnConfirmJoin.disabled) {
          elements.btnConfirmJoin.click();
        }
      }
    });

    // Handle paste of 5-digit string
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (pasteData.length > 0) {
        const digits = pasteData.slice(0, 5).split('');
        digits.forEach((d, i) => {
          if (boxes[i]) boxes[i].value = d;
        });
        const nextIndex = Math.min(digits.length, boxes.length - 1);
        boxes[nextIndex].focus();
        validatePin();
      }
    });
  });
}

function getEnteredPin() {
  return Array.from(elements.pinBoxes).map(b => b.value.trim()).join('');
}

function validatePin() {
  const pin = getEnteredPin();
  const isValid = /^\d{5}$/.test(pin);
  elements.btnConfirmJoin.disabled = !isValid;
  elements.pinError.style.display = 'none';
  return isValid;
}

function clearPin() {
  elements.pinBoxes.forEach(b => { b.value = ''; });
  elements.btnConfirmJoin.disabled = true;
  elements.pinError.style.display = 'none';
}

// ==========================================================================
// Modal Handlers & UI Interactivity
// ==========================================================================
function openModal(modal) {
  modal.style.display = 'flex';
}

function closeModal(modal) {
  modal.style.display = 'none';
}

function showToast(msg) {
  elements.toast.textContent = msg;
  elements.toast.classList.add('show');
  setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2600);
}

// ==========================================================================
// Event Listeners Initialization
// ==========================================================================
function initEvents() {
  // Modal buttons
  elements.btnOpenCreate.addEventListener('click', () => {
    openModal(elements.createRoomModal);
    elements.createUsername.focus();
  });

  elements.btnOpenJoin.addEventListener('click', () => {
    clearPin();
    openModal(elements.joinRoomModal);
    setTimeout(() => elements.pinBoxes[0].focus(), 100);
  });

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close');
      const modal = document.getElementById(modalId);
      if (modal) closeModal(modal);
    });
  });

  // Create room action
  elements.btnConfirmCreate.addEventListener('click', () => {
    const name = elements.createUsername.value.trim() || 'Host';
    state.username = name;
    localStorage.setItem('webrtc_username', name);
    updateProfileUI();

    closeModal(elements.createRoomModal);
    sendSignal({
      type: 'create-room',
      peerId: crypto.randomUUID()
    });
  });

  // Join room action
  elements.btnConfirmJoin.addEventListener('click', () => {
    const pin = getEnteredPin();
    if (!/^\d{5}$/.test(pin)) {
      elements.pinError.textContent = 'Please enter a valid 5-digit number';
      elements.pinError.style.display = 'block';
      return;
    }

    const name = elements.joinUsername.value.trim() || 'Guest';
    state.username = name;
    localStorage.setItem('webrtc_username', name);
    updateProfileUI();

    closeModal(elements.joinRoomModal);
    sendSignal({
      type: 'join',
      roomId: pin,
      peerId: crypto.randomUUID()
    });
  });

  // Copy share button
  const copyRoomAction = () => {
    if (!state.roomId) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${state.roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      showToast(`Copied room link: ${state.roomId}`);
    }).catch(() => {
      navigator.clipboard.writeText(state.roomId);
      showToast(`Copied code: ${state.roomId}`);
    });
  };

  elements.chipCopyBtn.addEventListener('click', copyRoomAction);
  elements.copyShareBtn.addEventListener('click', copyRoomAction);

  // Leave room button
  elements.leaveBtn.addEventListener('click', () => {
    if (confirm('Leave this room and end P2P connection?')) {
      leaveRoom();
    }
  });

  // Chat auto-scroll listener
  elements.chatMessagesContainer.addEventListener('scroll', () => {
    const scroller = elements.chatMessagesContainer;
    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (isNearBottom) {
      elements.scrollBottomPill.classList.remove('visible');
      state.isAutoScroll = true;
    } else {
      state.isAutoScroll = false;
    }
  });

  elements.scrollBottomPill.addEventListener('click', () => {
    elements.chatMessagesContainer.scrollTop = elements.chatMessagesContainer.scrollHeight;
    elements.scrollBottomPill.classList.remove('visible');
    state.isAutoScroll = true;
  });

  // Chat input typing & auto-resize
  elements.chatTextarea.addEventListener('input', () => {
    const text = elements.chatTextarea.value;
    elements.charCount.textContent = `${text.length}/200`;
    elements.sendBtn.disabled = text.trim().length === 0;

    // Auto-grow height
    elements.chatTextarea.style.height = 'auto';
    elements.chatTextarea.style.height = `${Math.min(elements.chatTextarea.scrollHeight, 80)}px`;
  });

  elements.chatTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!elements.sendBtn.disabled) {
        sendChatMessage(elements.chatTextarea.value);
      }
    }
  });

  elements.sendBtn.addEventListener('click', () => {
    sendChatMessage(elements.chatTextarea.value);
  });

  // Quick Emoji reactions
  document.querySelectorAll('.reaction-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.getAttribute('data-emoji');
      if (state.dataChannel && state.dataChannel.readyState === 'open') {
        sendChatMessage(emoji);
      } else {
        elements.chatTextarea.value += emoji;
        elements.chatTextarea.dispatchEvent(new Event('input'));
      }
    });
  });

  // Toggle chat panel
  elements.toggleChatBtn.addEventListener('click', () => {
    elements.chatSection.classList.toggle('collapsed');
  });

  elements.closeChatBtn.addEventListener('click', () => {
    elements.chatSection.classList.add('collapsed');
  });

  // Server settings modal
  elements.serverSettingsBtn.addEventListener('click', () => {
    elements.customWsUrl.value = state.signalUrl;
    elements.presetCloudBtn.classList.toggle('active', state.signalUrl === DEFAULT_SIGNAL_URL);
    elements.presetLocalBtn.classList.toggle('active', state.signalUrl === LOCAL_SIGNAL_URL);
    openModal(elements.serverSettingsModal);
  });

  elements.presetCloudBtn.addEventListener('click', () => {
    elements.customWsUrl.value = DEFAULT_SIGNAL_URL;
    elements.presetCloudBtn.classList.add('active');
    elements.presetLocalBtn.classList.remove('active');
  });

  elements.presetLocalBtn.addEventListener('click', () => {
    elements.customWsUrl.value = LOCAL_SIGNAL_URL;
    elements.presetLocalBtn.classList.add('active');
    elements.presetCloudBtn.classList.remove('active');
  });

  elements.btnApplyServer.addEventListener('click', () => {
    const newUrl = elements.customWsUrl.value.trim();
    if (newUrl) {
      state.signalUrl = newUrl;
      localStorage.setItem('webrtc_signal_url', newUrl);
      closeModal(elements.serverSettingsModal);
      showToast(`Connecting to ${newUrl}...`);
      connectSignaling();
    }
  });

  // Check URL parameters for direct join: ?room=12345
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoom = urlParams.get('room');
  if (paramRoom && /^\d{5}$/.test(paramRoom)) {
    setTimeout(() => {
      openModal(elements.joinRoomModal);
      const digits = paramRoom.split('');
      elements.pinBoxes.forEach((box, i) => {
        if (digits[i]) box.value = digits[i];
      });
      validatePin();
    }, 500);
  }
}

// ==========================================================================
// Initialization
// ==========================================================================
function init() {
  updateProfileUI();
  setupPinInputs();
  initEvents();
  connectSignaling();

  addSystemMessage('Welcome to P2P Live! Create or join a 5-digit room to chat.');
}

window.addEventListener('DOMContentLoaded', init);
