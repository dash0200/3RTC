import React, { useState, useRef, useEffect, useMemo } from 'react';
import { splitTimestamps } from '../utils/chatTimestamps';
import QuickPicksModal from './QuickPicksModal';
import { getAvatarColor } from '../utils/sound';
import { EMOJI_CATEGORIES } from '../utils/emoji';
import { useReactionSet, openReactionsEditor } from '../features/reactions/reactionSet';

// 1-3 emojis and nothing else: shown large without a bubble, like WhatsApp
const EMOJI_ONLY_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]|\s)+$/u;
const GRAPHEMES = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
function isEmojiOnly(text) {
  if (!text || !EMOJI_ONLY_RE.test(text) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) return false;
  if (GRAPHEMES) {
    let count = 0;
    for (const _ of GRAPHEMES.segment(text.trim())) {
      if (++count > 3) return false;
    }
    return true;
  }
  return [...text.trim()].length <= 6;
}
import { copyToClipboard } from '../utils/clipboard';
import { extractYouTubeId, fetchYouTubeTitle } from './YouTubeSyncPlayer';
import { PeerVoicePanel } from './PeerVoiceRoster';
import SoundboardTray from './SoundboardTray';
import ImageLightboxModal from './ImageLightboxModal';
import { formatFileSize, isImageFile } from '../utils/p2pImageShare';
import { useBackLayer } from '../core/backStack';



// "Look at 12:34": video timestamps become links that jump everyone there (while a video is loaded)
function renderMessageText(text, onSeekTo) {
  if (!onSeekTo) return text;
  const parts = splitTimestamps(text);
  if (parts.length === 1 && parts[0].seconds === undefined) return text;
  return parts.map((part, idx) => (part.seconds === undefined ? (
    <React.Fragment key={idx}>{part.text}</React.Fragment>
  ) : (
    <button
      key={idx}
      type="button"
      className="chat-timestamp"
      onClick={() => onSeekTo(part.seconds)}
      title={`Jump everyone to ${part.text}`}
    >
      {part.text}
    </button>
  )));
}

export default function LiveChat({
  onSeekTo,
  messages = [],
  systemLogs = [],
  onSendMessage,
  onSendImage,
  onClearLogs,
  onTestSound,
  isP2PConnected,
  username,
  isOpen,
  onClose,
  isAudioBlocked = false,
  onToggleBlockAudio,
  signalStatus,
  onOpenSettings,
  queue = [],
  activeVideoId = null,
  activeVideoTitle = '',
  onAddToQueue,
  onRemoveFromQueue,
  onReorderQueue,
  onClearQueue,
  onPlayQueueItem,
  onPlayNextInQueue,
  onVoteSkip,
  skipVotes = [],
  peerCount = 0,
  activeTab: controlledActiveTab,
  onTabChange,
  onSendReaction,
  connectedPeers = [],
  localUser = null,
  onSetPeerVolume,
  onToggleMutePeer,
  onToggleMic,
  roomId = '',
  onCopyRoom,
  audioSettings = null,
  onUpdateAudioSettings,
  onOpenAudioSettings,
  isPttActive = false,
  onPttPressStart,
  onPttPressEnd,
  soundboardSettings = null,
  activeSoundboardSfx = null,
  activeSfxCooldowns = {},
  onPlaySoundboardClip,
  onSoundboardVolumeChange,
  onToggleSoundboardMute,
  onOpenQrCode,
  // Phone layout: shown in the page under the video (no floating sheet, header or resize)
  embedded = false
}) {
  const DEFAULT_WIDTH = 380;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 720;

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('3rtc_sidebar_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          return parsed;
        }
      }
    } catch {
      // Ignore
    }
    return DEFAULT_WIDTH;
  });

  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_WIDTH);

  const handleStartResize = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    isResizingRef.current = true;
    setIsResizing(true);
    const clientX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    startXRef.current = clientX;
    startWidthRef.current = sidebarWidth;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent) => {
      if (!isResizingRef.current) return;
      const currentX = moveEvent.type === 'touchmove' ? moveEvent.touches[0].clientX : moveEvent.clientX;
      const deltaX = startXRef.current - currentX;
      const maxWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 300));
      const newWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidthRef.current + deltaX));
      setSidebarWidth(newWidth);
    };

    const handlePointerUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
      window.removeEventListener('touchcancel', handlePointerUp);

      setSidebarWidth((latestWidth) => {
        try {
          localStorage.setItem('3rtc_sidebar_width', String(latestWidth));
        } catch {
          // ignore
        }
        return latestWidth;
      });
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);
    window.addEventListener('touchcancel', handlePointerUp);
  };

  const handleResetWidth = (e) => {
    e.stopPropagation();
    setSidebarWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem('3rtc_sidebar_width', String(DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  };

  const [internalActiveTab, setInternalActiveTab] = useState('chat'); // 'chat' | 'queue' | 'logs'
  const activeTab = controlledActiveTab !== undefined ? controlledActiveTab : internalActiveTab;
  const setActiveTab = (tab) => {
    if (typeof onTabChange === 'function') {
      onTabChange(tab);
    }
    setInternalActiveTab(tab);
  };

  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [unreadLogsCount, setUnreadLogsCount] = useState(0);
  const [inputText, setInputText] = useState('');
  const [showScrollPill, setShowScrollPill] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);

  // Emoji Picker States (Smiley button popover)
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState('smileys');
  const [emojiSearch, setEmojiSearch] = useState('');
  const emojiPickerRef = useRef(null);
  const smileyBtnRef = useRef(null);

  // Close emoji picker when clicking outside
  useEffect(() => {
    if (!isEmojiPickerOpen) return;
    const handleClickOutside = (e) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target) &&
        !smileyBtnRef.current?.contains(e.target)
      ) {
        setIsEmojiPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isEmojiPickerOpen]);

  const handleInsertEmoji = (emoji) => {
    setInputText((prev) => prev + emoji);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const currentCategoryObj = EMOJI_CATEGORIES.find((c) => c.id === activeEmojiCategory) || EMOJI_CATEGORIES[0];
  const displayedEmojis = emojiSearch.trim()
    ? EMOJI_CATEGORIES.flatMap((c) => c.emojis).filter((emoji, idx, self) => self.indexOf(emoji) === idx)
    : currentCategoryObj.emojis;

  // Feature 3.3: Direct P2P Image & Screenshot states
  const [pendingImage, setPendingImage] = useState(null); // { file, previewUrl }
  const [isDragOver, setIsDragOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const fileInputRef = useRef(null);

  const handleClearPendingImage = () => {
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    setPendingImage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  useEffect(() => {
    return () => {
      if (pendingImage?.previewUrl) {
        URL.revokeObjectURL(pendingImage.previewUrl);
      }
    };
  }, [pendingImage]);

  const handleSelectImageFile = (file) => {
    if (!file || !isImageFile(file)) return;
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    const previewUrl = URL.createObjectURL(file);
    setPendingImage({ file, previewUrl });
    setActiveTab('chat');
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleSelectImageFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          handleSelectImageFile(file);
          break;
        }
      }
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        if (isImageFile(files[i])) {
          handleSelectImageFile(files[i]);
          break;
        }
      }
    }
  };

  // Collaborative queue states
  const [queueInput, setQueueInput] = useState('');
  const [showQuickPicks, setShowQuickPicks] = useState(false);
  // Back closes these first (core/backStack.js)
  useBackLayer(isEmojiPickerOpen, () => setIsEmojiPickerOpen(false));
  useBackLayer(isLightboxOpen, () => setIsLightboxOpen(false));
  useBackLayer(showQuickPicks, () => setShowQuickPicks(false));
  const [queueError, setQueueError] = useState('');
  const [isAddingQueue, setIsAddingQueue] = useState(false);

  const handleQueueSubmit = async (e) => {
    if (e) e.preventDefault();
    const trimmed = queueInput.trim();
    if (!trimmed) return;

    const id = extractYouTubeId(trimmed);
    if (!id) {
      setQueueError('Please enter a valid YouTube link or 11-char ID');
      return;
    }

    setQueueError('');
    setIsAddingQueue(true);
    try {
      const title = await fetchYouTubeTitle(id);
      if (typeof onAddToQueue === 'function') {
        onAddToQueue({ videoId: id, title });
      }
      setQueueInput('');
    } finally {
      setIsAddingQueue(false);
    }
  };

  const handleMoveQueueItem = (fromIndex, toIndex) => {
    if (toIndex < 0 || toIndex >= queue.length) return;
    const updated = [...queue];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    if (typeof onReorderQueue === 'function') {
      onReorderQueue(updated);
    }
  };

  const totalParticipants = peerCount + 1;
  const requiredVotes = totalParticipants <= 2 ? totalParticipants : Math.ceil(totalParticipants / 2);
  const hasVotedSkip = skipVotes.includes(username);

  const chatContainerRef = useRef(null);
  const chatEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const logsEndRef = useRef(null);
  const textareaRef = useRef(null);

  const displayLogs = systemLogs.filter((log) => log.category !== 'debug');
  const prevMsgCountRef = useRef(messages.length);
  const prevLogsCountRef = useRef(displayLogs.length);

  const handleCopyLogs = async () => {
    if (!displayLogs || displayLogs.length === 0) return;
    const formatted = displayLogs.map((log) => {
      const d = new Date(log.timestamp || Date.now());
      const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      return `[${timeStr}] ${log.text}`;
    }).join('\n');
    const success = await copyToClipboard(formatted);
    if (success) {
      setLogsCopied(true);
      setTimeout(() => setLogsCopied(false), 2000);
    }
  };

  // Newest message at the bottom (like WhatsApp): follow new messages while the user is at the
  // bottom, otherwise show the "New messages" pill. Own messages always scroll into view.
  // Which messages are 1-3 emojis only (shown big, without a bubble); recomputed only when messages change
  const emojiOnlyIds = useMemo(() => new Set(
    messages
      .filter((msg) => !msg.image?.url && !msg.imageTransfer && isEmojiOnly(msg.text))
      .map((msg) => msg.id)
  ), [messages]);

  const wasNearBottomRef = useRef(true);
  useEffect(() => {
    // Opening the chat tab always lands on the latest messages
    if (activeTab === 'chat') wasNearBottomRef.current = true;
  }, [activeTab]);
  useEffect(() => {
    const scroller = chatContainerRef.current;
    if (!scroller || activeTab !== 'chat') return;

    const lastMsg = messages[messages.length - 1];
    if (wasNearBottomRef.current || lastMsg?.isSelf) {
      scroller.scrollTop = scroller.scrollHeight;
      wasNearBottomRef.current = true;
      setShowScrollPill(false);
    } else {
      setShowScrollPill(true);
    }
  }, [messages, activeTab]);

  // Auto-scroll room logs when new logs arrive (latest on top)
  useEffect(() => {
    const scroller = logsContainerRef.current;
    if (!scroller || activeTab !== 'logs') return;

    const isNearTop = scroller.scrollTop < 80;
    if (isNearTop) {
      scroller.scrollTop = 0;
    }
  }, [displayLogs, activeTab]);

  // Track unread counts when user is on the alternate tab
  useEffect(() => {
    if (activeTab !== 'chat') {
      const diff = messages.length - prevMsgCountRef.current;
      if (diff > 0) {
        setUnreadChatCount((prev) => prev + diff);
      }
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length, activeTab]);

  useEffect(() => {
    if (activeTab !== 'logs') {
      const diff = displayLogs.length - prevLogsCountRef.current;
      if (diff > 0) {
        setUnreadLogsCount((prev) => prev + diff);
      }
    }
    prevLogsCountRef.current = displayLogs.length;
  }, [displayLogs.length, activeTab]);

  const handleScroll = () => {
    const scroller = chatContainerRef.current;
    if (!scroller) return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    wasNearBottomRef.current = isNearBottom;
    if (isNearBottom) {
      setShowScrollPill(false);
    }
  };

  const scrollToLatest = () => {
    const scroller = chatContainerRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      wasNearBottomRef.current = true;
      setShowScrollPill(false);
    }
  };

  const handleSend = () => {
    const clean = inputText.trim();
    if (!isP2PConnected) return;

    if (pendingImage) {
      if (typeof onSendImage === 'function') {
        onSendImage(pendingImage.file, clean);
      }
      handleClearPendingImage();
      setInputText('');
      setActiveTab('chat');
      setUnreadChatCount(0);
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = 0;
      }
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      return;
    }

    if (clean) {
      onSendMessage(clean);
      setInputText('');
      setActiveTab('chat');
      setUnreadChatCount(0);
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = 0;
      }
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 80)}px`;
  };

  // The quick-reaction row only sends a floating reaction: nothing goes into the chat or the
  // message box (the 😊 button in the message box is for emojis in messages)
  const quickReactions = useReactionSet();
  const handleReactionClick = (emoji) => {
    if (typeof onSendReaction === 'function') onSendReaction(emoji);
  };

  return (
    <>
      {!embedded && (
        <div
          className={`mobile-chat-backdrop ${isOpen ? 'active' : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`chat-section ${embedded ? 'embedded' : ''} ${isOpen ? '' : 'collapsed'} ${isResizing ? 'is-resizing' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
        style={isOpen && !embedded ? { width: `${sidebarWidth}px` } : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag & Drop Visual Overlay */}
        {isDragOver && (
          <div className="chat-drag-overlay" role="alert">
            <div className="drag-overlay-card">
              <div className="drag-icon-pulse">🖼️</div>
              <div className="drag-overlay-title">Drop image to share</div>
              <div className="drag-overlay-subtitle">Direct peer-to-peer file transfer</div>
            </div>
          </div>
        )}
        {/* Sidebar resize handle on the left edge (desktop) */}
        {isOpen && !embedded && (
          <div
            className={`sidebar-resize-handle ${isResizing ? 'resizing' : ''}`}
            onMouseDown={handleStartResize}
            onTouchStart={handleStartResize}
            onDoubleClick={handleResetWidth}
            title="Drag to resize sidebar (double-click to reset)"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
          >
            <div className="resize-handle-bar" />
          </div>
        )}

        {!embedded && (
        <div
          className="mobile-sheet-pill-bar"
          onClick={onClose}
          title="Swipe down to dismiss"
        >
          <div className="mobile-sheet-pill"></div>
        </div>
        )}

        {!embedded && (
        <div className="chat-header">
          <div className="chat-header-title-wrap">
            <span className="chat-header-title">Live Chat & Activity</span>
          </div>

          <div className="chat-header-actions">
            {signalStatus && (
              <button
                type="button"
                className={`sidebar-cloud-pill ${signalStatus.connected ? 'connected' : ''} ${onOpenSettings ? '' : 'static'}`}
                onClick={onOpenSettings}
                disabled={!onOpenSettings}
                title={
                  (signalStatus.connected ? 'Connected to the 3RTC server.' : `Server: ${(signalStatus.label || 'Connecting...').replace(/\.*$/, '')}…`)
                  + (onOpenSettings ? ' Click for server settings.' : '')
                }
              >
                <span className={`signal-dot ${signalStatus.connected ? 'connected' : ''}`} />
                <span className="sidebar-cloud-label">
                  {signalStatus.connected ? 'Cloud Connected' : (signalStatus.label || 'Connecting...')}
                </span>
                {typeof onOpenSettings === 'function' && (
                  <svg className="sidebar-cloud-gear" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                )}
              </button>
            )}

            <button className="header-icon-btn close-sidebar-btn" onClick={onClose} title="Close Sidebar" aria-label="Close Sidebar">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        </div>
        )}

        {/* Tabs: Chat vs Queue vs Peers */}
        <div className="chat-nav-tabs">
          <button
            type="button"
            className={`chat-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('chat');
              setUnreadChatCount(0);
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            <span>Chat</span>
            {(messages.length > 0 || unreadChatCount > 0) && (
              <span className="tab-badge chat-badge">{unreadChatCount || messages.length}</span>
            )}
          </button>

          <button
            type="button"
            className={`chat-tab-btn ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => setActiveTab('queue')}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z" />
            </svg>
            <span>Queue</span>
            {queue.length > 0 && <span className="tab-badge queue-badge">{queue.length}</span>}
          </button>

          <button
            type="button"
            className={`chat-tab-btn ${activeTab === 'peers' ? 'active' : ''}`}
            onClick={() => setActiveTab('peers')}
            title="Peers & Voice Status"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
            <span>Peers</span>
            <span className="tab-badge peers-badge">{connectedPeers.length + 1}</span>
          </button>
        </div>

        {isAudioBlocked && (
          <div className="audio-blocked-chat-banner">
            <div className="blocked-banner-left">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="#f59e0b">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
              <span>Audio & microphone blocked (Text-only mode)</span>
            </div>
            {typeof onToggleBlockAudio === 'function' && (
              <button
                type="button"
                className="btn-unblock-audio"
                onClick={onToggleBlockAudio}
                title="Click to unblock audio & microphone"
              >
                Unblock
              </button>
            )}
          </div>
        )}

        {/* TAB 1: Real Peer Chat */}
        {activeTab === 'chat' && (
          <>
            <div className="chat-messages-container" ref={chatContainerRef} onScroll={handleScroll}>
              {messages.length === 0 ? (
                <div className="chat-empty-state">
                  <div className="empty-state-icon">💬</div>
                  <div className="empty-state-title">No messages yet</div>
                  <div className="empty-state-subtitle">Say hello to your peers in the room!</div>
                </div>
              ) : (
                <div className="chat-messages-inner wa-chat">
                  {messages.map((msg, index) => {
                    const date = new Date(msg.timestamp || Date.now());
                    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    const msgInitial = (msg.sender?.[0] || '?').toUpperCase();
                    const msgAvatarBg = getAvatarColor(msg.sender || 'Peer');
                    // Avatar colors are gradients; the name uses the gradient's first color
                    const msgNameColor = msgAvatarBg.match(/#[0-9a-f]{6}/i)?.[0] || '#53bdeb';
                    // Consecutive messages from the same person within 5 min form one group:
                    // name, avatar and bubble tail only on the first one (like WhatsApp)
                    const prev = messages[index - 1];
                    const startsGroup = !prev || prev.sender !== msg.sender ||
                      Math.abs((msg.timestamp || 0) - (prev.timestamp || 0)) > 5 * 60 * 1000;
                    const emojiOnly = emojiOnlyIds.has(msg.id);
                    const side = msg.isSelf ? 'self' : 'peer';

                    return (
                      <div key={msg.id} className={`wa-row ${side} ${startsGroup ? 'group-start' : ''}`}>
                        {!msg.isSelf && (
                          startsGroup
                            ? <div className="wa-avatar" style={{ background: msgAvatarBg }} title={msg.sender}>{msgInitial}</div>
                            : <div className="wa-avatar-spacer" />
                        )}
                        <div className={`wa-bubble ${side} ${startsGroup ? 'tail' : ''} ${emojiOnly ? 'emoji-only' : ''}`}>
                          {!msg.isSelf && startsGroup && (
                            <div className="wa-sender">
                              <span className="wa-sender-name" style={{ color: msgNameColor }}>{msg.sender}</span>
                              {msg.isHost && <span className="wa-host-badge">HOST</span>}
                            </div>
                          )}

                              {/* Image Transfer in Progress */}
                              {msg.imageTransfer && (
                                <div className="chat-image-transfer-card">
                                  <div className="transfer-header">
                                    <span className="transfer-icon">🖼️</span>
                                    <div className="transfer-details">
                                      <span className="transfer-filename" title={msg.imageTransfer.fileName}>
                                        {msg.imageTransfer.fileName}
                                      </span>
                                      <span className="transfer-status">
                                        {msg.isSelf ? 'Sending' : 'Receiving'} • {msg.imageTransfer.percent || 0}% ({formatFileSize(msg.imageTransfer.fileSize)})
                                      </span>
                                    </div>
                                  </div>
                                  <div className="transfer-progress-track">
                                    <div
                                      className="transfer-progress-fill"
                                      style={{ width: `${Math.max(4, msg.imageTransfer.percent || 0)}%` }}
                                    />
                                  </div>
                                </div>
                              )}

                              {/* Completed Image Thumbnail */}
                              {msg.image?.url && (
                                <div
                                  className="chat-image-card"
                                  onClick={() => {
                                    setLightboxImage({
                                      url: msg.image.url,
                                      name: msg.image.name,
                                      size: msg.image.size,
                                      sender: msg.sender,
                                      timestamp: msg.timestamp,
                                      caption: msg.text,
                                      blob: msg.image.blob
                                    });
                                    setIsLightboxOpen(true);
                                  }}
                                  title="Click to view image in high resolution"
                                >
                                  <img
                                    src={msg.image.url}
                                    alt={msg.image.name || 'Shared Image'}
                                    className="chat-image-thumb"
                                    loading="lazy"
                                  />
                                  <div className="chat-image-hover-overlay">
                                    <span className="chat-image-meta-pill">
                                      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                                        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                                      </svg>
                                      {formatFileSize(msg.image.size)}
                                    </span>
                                    <span className="chat-image-action-label">Preview</span>
                                  </div>
                                </div>
                              )}

                          {msg.text && <span className="wa-text">{renderMessageText(msg.text, onSeekTo)}</span>}
                          <span className="wa-time">{timeStr}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {showScrollPill && (
                <button className="scroll-top-pill wa-latest-pill" onClick={scrollToLatest} title="Jump to latest messages">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
                  </svg>
                  <span>New messages</span>
                </button>
              )}
            </div>

            {/* Chat Footer with Input Pill & Reactions Dock (Matching Screenshot) */}
            <div className="chat-footer">
              {/* Pending Image Attachment Preview Card */}
              {pendingImage && (
                <div className="chat-pending-image-card">
                  <div className="pending-image-thumb-wrap">
                    <img src={pendingImage.previewUrl} alt="Pending upload preview" className="pending-image-thumb" />
                  </div>
                  <div className="pending-image-info">
                    <span className="pending-image-name" title={pendingImage.file.name}>{pendingImage.file.name}</span>
                    <span className="pending-image-size">{formatFileSize(pendingImage.file.size)}</span>
                  </div>
                  <button
                    type="button"
                    className="pending-image-cancel-btn"
                    onClick={handleClearPendingImage}
                    title="Remove attached image"
                    aria-label="Remove attached image"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Emoji Picker Popover Window */}
              {isEmojiPickerOpen && (
                <div className="chat-emoji-picker-window" ref={emojiPickerRef} role="dialog" aria-label="Emoji Picker">
                  <div className="emoji-picker-header">
                    <span className="emoji-picker-title">Emojis</span>
                    <div className="emoji-category-tabs">
                      {EMOJI_CATEGORIES.map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          className={`emoji-cat-tab-btn ${activeEmojiCategory === cat.id && !emojiSearch ? 'active' : ''}`}
                          onClick={() => {
                            setActiveEmojiCategory(cat.id);
                            setEmojiSearch('');
                          }}
                          title={cat.name}
                        >
                          {cat.icon}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="emoji-picker-close-btn"
                      onClick={() => setIsEmojiPickerOpen(false)}
                      title="Close emoji picker"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="emoji-picker-search-bar">
                    <input
                      type="text"
                      className="emoji-picker-search-input"
                      placeholder="Search emojis..."
                      value={emojiSearch}
                      onChange={(e) => setEmojiSearch(e.target.value)}
                    />
                    {emojiSearch && (
                      <button
                        type="button"
                        className="emoji-search-clear-btn"
                        onClick={() => setEmojiSearch('')}
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  <div className="emoji-picker-grid">
                    {displayedEmojis.map((emoji, idx) => (
                      <button
                        key={`${emoji}-${idx}`}
                        type="button"
                        className="emoji-grid-item"
                        onClick={() => handleInsertEmoji(emoji)}
                        title={`Insert ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input Pill Container */}
              <div className="chat-input-pill-container">
                {/* Smiley Button (Opens All Emojis Window) */}
                <button
                  type="button"
                  ref={smileyBtnRef}
                  className={`chat-pill-smiley-btn ${isEmojiPickerOpen ? 'active' : ''}`}
                  onClick={() => setIsEmojiPickerOpen((prev) => !prev)}
                  title={isEmojiPickerOpen ? "Close emoji window" : "Open all emojis"}
                  aria-label="Open emojis"
                  aria-expanded={isEmojiPickerOpen}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
                  </svg>
                </button>

                <textarea
                  ref={textareaRef}
                  className="chat-pill-textarea"
                  rows={1}
                  maxLength={200}
                  placeholder={
                    !isP2PConnected
                      ? 'Waiting for connection...'
                      : 'Type a message...'
                  }
                  value={inputText}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  disabled={!isP2PConnected}
                />

                {/* Attach image (opens the file picker; on phones: gallery / camera) */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileInputChange}
                />
                <button
                  type="button"
                  className="chat-pill-attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isP2PConnected}
                  title="Send an image"
                  aria-label="Send an image"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                  </svg>
                </button>

                <button
                  type="button"
                  className="chat-pill-send-btn"
                  onClick={handleSend}
                  disabled={!isP2PConnected || (inputText.trim().length === 0 && !pendingImage)}
                  title="Send message (Enter)"
                  aria-label="Send message"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              </div>

              {/* Quick Reactions Dock Directly Below Input */}
              <div className="chat-quick-reactions-dock">
                {quickReactions.map(({ emoji, key }) => (
                  <button
                    key={emoji}
                    type="button"
                    className="quick-reaction-dock-btn"
                    onClick={() => handleReactionClick(emoji)}
                    title={`React ${emoji} (key ${key})`}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  className="quick-reaction-dock-btn quick-reaction-edit-btn"
                  onClick={openReactionsEditor}
                  title="Choose your reactions"
                  aria-label="Choose your reactions"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>
                </button>
              </div>
            </div>
          </>
        )}

        {/* TAB 2: Collaborative Playlist Queue */}
        {activeTab === 'queue' && (
          <div className="queue-panel-wrapper">
            {/* Currently Playing Card */}
            <div className="now-playing-card">
              <div className="now-playing-header">
                <span className="now-playing-badge">
                  <span className="equalizer-bar bar1"></span>
                  <span className="equalizer-bar bar2"></span>
                  <span className="equalizer-bar bar3"></span>
                  NOW PLAYING
                </span>
                {activeVideoId && (
                  <button
                    type="button"
                    className={`btn-vote-skip ${hasVotedSkip ? 'voted' : ''}`}
                    onClick={onVoteSkip}
                    title={hasVotedSkip ? 'Cancel your vote to skip' : 'Vote to skip this video'}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                      <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
                    </svg>
                    <span>{hasVotedSkip ? 'Voted' : 'Skip'} ({skipVotes.length}/{requiredVotes})</span>
                  </button>
                )}
              </div>

              {activeVideoId ? (
                <div className="now-playing-body">
                  <img
                    className="now-playing-thumb"
                    src={`https://img.youtube.com/vi/${activeVideoId}/mqdefault.jpg`}
                    alt="Thumbnail"
                    onError={(e) => {
                      e.target.style.display = 'none';
                    }}
                  />
                  <div className="now-playing-info">
                    <div className="now-playing-title" title={activeVideoTitle || `Video ID: ${activeVideoId}`}>
                      {activeVideoTitle || `YouTube Video (${activeVideoId})`}
                    </div>
                    <div className="now-playing-sub">
                      <span className="now-playing-sync-dot"></span>
                      <span>Synced P2P</span>
                      {queue.length > 0 && typeof onPlayNextInQueue === 'function' && (
                        <button
                          type="button"
                          className="btn-next-inline"
                          onClick={onPlayNextInQueue}
                          title={`Skip immediately to: "${queue[0].title}"`}
                        >
                          Next ⏭
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="now-playing-empty">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="#666">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
                  </svg>
                  <span>No video is currently playing</span>
                </div>
              )}

              {activeVideoId && requiredVotes > 0 && (
                <div className="skip-progress-track" title={`${skipVotes.length} of ${requiredVotes} votes to skip`}>
                  <div
                    className="skip-progress-fill"
                    style={{ width: `${Math.min(100, (skipVotes.length / requiredVotes) * 100)}%` }}
                  />
                </div>
              )}
            </div>

            {/* Pick from Quick Watch without leaving the current video */}
            {typeof onAddToQueue === 'function' && (
              <button type="button" className="queue-browse-btn" onClick={() => setShowQuickPicks(true)}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="#f59e0b" aria-hidden="true"><path d="M7 2v11h3v9l7-12h-4l4-8z" /></svg>
                Browse Quick Watch
              </button>
            )}
            <QuickPicksModal
              isOpen={showQuickPicks}
              onClose={() => setShowQuickPicks(false)}
              onQueue={(v) => onAddToQueue({ videoId: v.id, title: v.title }, { autoplay: false })}
              queuedIds={queue.map((item) => item.videoId)}
            />

            {/* Add Video to Queue Form */}
            <form className="queue-add-form" onSubmit={handleQueueSubmit}>
              <div className="queue-input-wrapper">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#FF0033" className="queue-input-icon">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
                <input
                  type="text"
                  className="queue-add-input"
                  placeholder="Paste YouTube link or video ID..."
                  value={queueInput}
                  onChange={(e) => {
                    setQueueInput(e.target.value);
                    if (queueError) setQueueError('');
                  }}
                />
                {queueInput && (
                  <button
                    type="button"
                    className="yt-clear-btn"
                    onClick={() => setQueueInput('')}
                    title="Clear input"
                  >
                    &times;
                  </button>
                )}
              </div>
              <button
                type="submit"
                className="btn btn-primary queue-submit-btn"
                disabled={isAddingQueue || !queueInput.trim()}
                title="Add video to shared queue"
              >
                {isAddingQueue ? '...' : '+ Add'}
              </button>
            </form>
            {queueError && <div className="queue-error-text">{queueError}</div>}

            {/* Queue List Header */}
            <div className="queue-list-header">
              <div className="queue-list-title">
                <span>Up Next</span>
                <span className="queue-count-pill">{queue.length}</span>
              </div>
              {queue.length > 0 && typeof onClearQueue === 'function' && (
                <button
                  type="button"
                  className="btn-clear-queue"
                  onClick={onClearQueue}
                  title="Clear all queued videos"
                >
                  Clear All
                </button>
              )}
            </div>

            {/* Queue Items List */}
            <div className="queue-items-container">
              {queue.length === 0 ? (
                <div className="queue-empty-state">
                  <div className="empty-state-icon">📑</div>
                  <div className="empty-state-title">Queue is empty</div>
                  <div className="empty-state-subtitle">
                    Paste any YouTube URL or click "+ Queue" on presets to add videos to the collaborative watch party queue.
                  </div>
                </div>
              ) : (
                <div className="queue-items-list">
                  {queue.map((item, index) => (
                    <div key={item.id} className="queue-item-card">
                      <span className="queue-item-index">#{index + 1}</span>
                      <img
                        className="queue-item-thumb"
                        src={`https://img.youtube.com/vi/${item.videoId}/default.jpg`}
                        alt="Thumbnail"
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                      <div className="queue-item-details">
                        <div className="queue-item-title" title={item.title}>
                          {item.title}
                        </div>
                        <div className="queue-item-meta">
                          <span>Added by <strong>{item.addedBy}</strong></span>
                        </div>
                      </div>

                      <div className="queue-item-actions">
                        <button
                          type="button"
                          className="btn-queue-action play"
                          onClick={() => onPlayQueueItem(item.id)}
                          title="Play this video now for everyone"
                        >
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="btn-queue-action move-up"
                          onClick={() => handleMoveQueueItem(index, index - 1)}
                          disabled={index === 0}
                          title="Move up in queue"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="btn-queue-action move-down"
                          onClick={() => handleMoveQueueItem(index, index + 1)}
                          disabled={index === queue.length - 1}
                          title="Move down in queue"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          className="btn-queue-action remove"
                          onClick={() => onRemoveFromQueue(item.id)}
                          title="Remove from queue"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: Room Activity Logs */}
        {activeTab === 'logs' && (
          <div className="logs-panel-wrapper">
            <div className="logs-header-bar">
              <span className="logs-count-label">
                <span className="logs-count-dot"></span>
                {displayLogs.length} event{displayLogs.length === 1 ? '' : 's'} recorded
              </span>
              <div className="logs-actions-group">
                {typeof onTestSound === 'function' && (
                  <button
                    type="button"
                    className="btn-copy-logs"
                    onClick={onTestSound}
                    title="Play a test chime to verify this browser window outputs sound"
                  >
                    🔊 Test Sound
                  </button>
                )}
                {displayLogs.length > 0 && (
                  <button
                    type="button"
                    className="btn-copy-logs"
                    onClick={handleCopyLogs}
                    title="Copy all logs to clipboard to share in chat"
                  >
                    {logsCopied ? '✓ Copied!' : '📋 Copy Logs'}
                  </button>
                )}
                {displayLogs.length > 0 && typeof onClearLogs === 'function' && (
                  <button
                    type="button"
                    className="btn-clear-logs"
                    onClick={onClearLogs}
                    title="Clear all room activity logs"
                  >
                    Clear Logs
                  </button>
                )}
              </div>
            </div>

            <div className="room-logs-container" ref={logsContainerRef}>
              {displayLogs.length === 0 ? (
                <div className="chat-empty-state">
                  <div className="empty-state-icon">📋</div>
                  <div className="empty-state-title">No room logs</div>
                  <div className="empty-state-subtitle">Room events, playback sync, and voice actions will appear here.</div>
                </div>
              ) : (
                <div className="room-logs-list">
                  {[...displayLogs].reverse().map((log) => {
                    const date = new Date(log.timestamp || Date.now());
                    const timeStr = date.toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                      second: '2-digit'
                    });

                    return (
                      <div key={log.id} className={`room-log-item log-cat-${log.category || 'system'}`}>
                        <span className="room-log-time">{timeStr}</span>
                        <div className="room-log-content">{log.text}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: Voice & Peer Audio Settings */}
        {activeTab === 'peers' && (
          <PeerVoicePanel
            connectedPeers={connectedPeers}
            localUser={localUser}
            onSetPeerVolume={onSetPeerVolume}
            onToggleMutePeer={onToggleMutePeer}
            onToggleMic={onToggleMic}
            onToggleBlockAudio={onToggleBlockAudio}
            roomId={roomId}
            onCopyRoom={onCopyRoom}
            audioSettings={audioSettings}
            onUpdateAudioSettings={onUpdateAudioSettings}
            onOpenAudioSettings={onOpenAudioSettings}
            isPttActive={isPttActive}
            onPttPressStart={onPttPressStart}
            onPttPressEnd={onPttPressEnd}
          />
        )}

        {/* TAB 5: Synchronized Soundboard (Mini SFX Tray) */}
        {activeTab === 'sfx' && (
          <div className="sidebar-soundboard-tab-wrapper">
            <SoundboardTray
              variant="embedded"
              volume={soundboardSettings?.volume ?? 0.75}
              isMuted={Boolean(soundboardSettings?.muted)}
              onVolumeChange={onSoundboardVolumeChange}
              onToggleMute={onToggleSoundboardMute}
              activeSfx={activeSoundboardSfx}
              activeCooldowns={activeSfxCooldowns}
              onPlayClip={onPlaySoundboardClip}
            />
          </div>
        )}
      </aside>

      {/* Feature 3.3: High-Resolution Image Lightbox Modal */}
      <ImageLightboxModal
        isOpen={isLightboxOpen}
        image={lightboxImage}
        onClose={() => setIsLightboxOpen(false)}
      />
    </>
  );
}
