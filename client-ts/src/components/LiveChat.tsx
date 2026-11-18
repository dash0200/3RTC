import React, { useState, useRef, useEffect, useMemo } from 'react';
import { RichText } from '../features/chat/RichText';
import { LinkPreview } from '../features/chat/LinkPreview';
import { firstLink } from '../features/chat/linkPreviewClient';
import { mentionedPeerIds, mentionQueryAt, plainSnippet, type MentionTarget } from '../utils/chatFormat';
import QuickPicksModal from './QuickPicksModal';
import { getAvatarColor } from '../utils/sound';
import { EMOJI_CATEGORIES } from '../utils/emoji';
import { useReactionSet, openReactionsEditor } from '../features/reactions/reactionSet';
import { copyToClipboard } from '../utils/clipboard';
import { resolvePastedLink } from '../features/media/resolveLink';
import { PeerVoicePanel, getInitials } from './PeerVoiceRoster';
import SoundboardTray from './SoundboardTray';
import ImageLightboxModal, { type LightboxImage } from './ImageLightboxModal';
import { formatFileSize, isImageFile, getFileIcon } from '../utils/p2pImageShare';
import { useBackLayer } from '../core/backStack';
import InvitePanel from './room/InvitePanel';
import type { QueueItem } from '../features/queue/useQueue';
import type { SystemLogEntry } from '../features/notices/useNotices';
import type { AudioSettings } from '../utils/audioSettings';
import type { SoundboardSettings, SoundboardClip } from '../utils/soundboard';
import type { ActiveSoundboardSfx } from '../features/soundboard/useSoundboard';
import type { ActivityInfo } from '../features/activities/activityState';
import type { ActivityDefinition } from '../features/activities/registry';
import type { ActivityStatus, ActivityViewKind } from '../features/activities/activityHost';
import type { ChatMessage, ChatReplyRef } from '../features/chat/useChat';
import { transferStatusText } from '../features/chat/chatMessages';
import FolderOfferCard from '../features/chat/FolderOfferCard';
import type { MediaItem, ConnectedPeer, SelfInfo } from '../types';
import type { QuickPickVideo } from '../utils/quickPicks';

// Longest chat message (the box stops there; a counter shows near the end)
const MAX_CHAT_CHARS = 200;

// 1-3 emojis and nothing else: shown large without a bubble, like WhatsApp
const EMOJI_ONLY_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f]|[0-9#*]\ufe0f?\u20e3|\s)+$/u;
const GRAPHEMES = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function isEmojiOnly(text: string): boolean {
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

export interface LiveChatMessage {
  id: string;
  sender?: string;
  text?: string;
  timestamp?: number;
  isSelf?: boolean;
  isHost?: boolean;
  image?: {
    url: string;
    name?: string;
    size?: number;
    blob?: Blob;
  };
  imageTransfer?: {
    fileName: string;
    fileSize: number;
    percent?: number;
    isPaused?: boolean;
    /** Cancelled (by us, by its sender, or nobody was receiving it): no controls, just the word. */
    isCancelled?: boolean;
    /** Theirs, big: Accept or Decline. */
    isOffered?: boolean;
  };
  [key: string]: unknown;
}

export interface LiveChatProps {
  onSeekTo?: (seconds: number) => void;
  messages?: ChatMessage[];
  systemLogs?: SystemLogEntry[];
  onSendMessage: (text: string, extras?: { replyTo?: ChatReplyRef | null; mentions?: string[] }) => void;
  onSendImage?: (file: File, caption?: string) => void;
  onSendFile?: (file: File, caption?: string) => void;
  onPauseTransfer?: (transferId: string) => void;
  onResumeTransfer?: (transferId: string) => void;
  onCancelTransfer?: (transferId: string) => void;
  /** A big file (or a folder's file) offered to us: get it. */
  onAcceptTransfer?: (transferId: string) => void;
  onClearLogs?: () => void;
  onTestSound?: () => void;
  isP2PConnected: boolean;
  username: string;
  isOpen: boolean;
  onClose: () => void;
  isAudioBlocked?: boolean;
  onToggleBlockAudio?: () => void;
  queue?: QueueItem[];
  activeVideoId?: string | null;
  activeMedia?: MediaItem | null; // a link source playing (features/media)
  activeVideoTitle?: string;
  onAddToQueue?: (item: Partial<QueueItem> & { videoId?: string; title?: string; media?: MediaItem }, options?: { autoplay?: boolean }) => void;
  onRemoveFromQueue?: (id: string) => void;
  onReorderQueue?: (updatedQueue: QueueItem[]) => void;
  onClearQueue?: () => void;
  onPlayQueueItem?: (id: string) => void;
  onPlayNextInQueue?: () => void;
  onVoteSkip?: () => void;
  skipVotes?: string[];
  peerCount?: number;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  onSendReaction?: (emoji: string) => void;
  connectedPeers?: ConnectedPeer[];
  localUser?: (SelfInfo & { isMuted?: boolean; isSpeaking?: boolean }) | null;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onToggleMutePeer?: (peerId: string) => void;
  /** Host only: make that person the host */
  onMakeHost?: (peerId: string) => void;
  onToggleMic?: () => void;
  roomId?: string | null;
  onCopyRoom?: () => void;
  audioSettings?: AudioSettings | null;
  onUpdateAudioSettings?: (patch: Partial<AudioSettings>) => void;
  onOpenAudioSettings?: () => void;
  isPttActive?: boolean;
  onPttPressStart?: () => void;
  onPttPressEnd?: () => void;
  soundboardSettings?: SoundboardSettings | null;
  activeSoundboardSfx?: ActiveSoundboardSfx | null;
  activeSfxCooldowns?: Record<string, number>;
  onPlaySoundboardClip?: (clip: string | SoundboardClip) => void;
  onSoundboardVolumeChange?: (volume: number) => void;
  onToggleSoundboardMute?: () => void;
  onOpenQrCode?: () => void;
  activity?: ActivityInfo | null;
  activityDefinition?: ActivityDefinition | null;
  activityView?: ActivityViewKind;
  onSetActivityView?: (view: ActivityViewKind) => void;
  activityStatus?: ActivityStatus | null;
  embedded?: boolean;
  isHost?: boolean;
  playbackLock?: boolean;
}

export default function LiveChat({
  onSeekTo,
  messages = [],
  systemLogs = [],
  onSendMessage,
  onSendImage,
  onSendFile,
  onPauseTransfer,
  onResumeTransfer,
  onCancelTransfer,
  onAcceptTransfer,
  onClearLogs,
  onTestSound,
  isP2PConnected,
  username,
  isOpen,
  onClose,
  isAudioBlocked = false,
  onToggleBlockAudio,
  queue = [],
  activeVideoId = null,
  activeMedia = null,
  activeVideoTitle = '',
  onAddToQueue,
  onRemoveFromQueue = () => {},
  onReorderQueue,
  onClearQueue,
  onPlayQueueItem = () => {},
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
  onMakeHost,
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
  activity = null,
  activityDefinition = null,
  activityView = 'full',
  onSetActivityView,
  activityStatus = null,
  embedded = false,
  isHost = false,
  playbackLock = false
}: LiveChatProps) {
  const isLockedForMe = Boolean(playbackLock && !(isHost || localUser?.isHost));
  const DEFAULT_WIDTH = 360;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 720;

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
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

  const handleStartResize = (e: React.MouseEvent | React.TouchEvent) => {
    if ('button' in e && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    isResizingRef.current = true;
    setIsResizing(true);
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    startXRef.current = clientX;
    startWidthRef.current = sidebarWidth;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (!isResizingRef.current) return;
      const currentX = 'touches' in moveEvent ? moveEvent.touches[0].clientX : (moveEvent as MouseEvent).clientX;
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

  const handleResetWidth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSidebarWidth(DEFAULT_WIDTH);
    try {
      localStorage.setItem('3rtc_sidebar_width', String(DEFAULT_WIDTH));
    } catch {
      // ignore
    }
  };

  const [internalActiveTab, setInternalActiveTab] = useState<string>('chat');
  const activeTab = controlledActiveTab !== undefined ? controlledActiveTab : internalActiveTab;
  const setActiveTab = (tab: string) => {
    if (typeof onTabChange === 'function') {
      onTabChange(tab);
    }
    setInternalActiveTab(tab);
  };

  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [showReactions, setShowReactions] = useState(false);
  const [unreadLogsCount, setUnreadLogsCount] = useState(0);
  const [inputText, setInputText] = useState('');
  // Rich chat: the message being replied to, and the @name being typed (its suggestions)
  const [replyTarget, setReplyTarget] = useState<(ChatReplyRef & { mine?: boolean }) | null>(null);
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [showScrollPill, setShowScrollPill] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);

  // Emoji Picker States
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState('smileys');
  const [emojiSearch, setEmojiSearch] = useState('');
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const smileyBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isEmojiPickerOpen) return;
    const handleClickOutside = (e: PointerEvent) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target as Node) &&
        !smileyBtnRef.current?.contains(e.target as Node)
      ) {
        setIsEmojiPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isEmojiPickerOpen]);

  const handleInsertEmoji = (emoji: string) => {
    setInputText((prev) => prev + emoji);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const currentCategoryObj = EMOJI_CATEGORIES.find((c) => c.id === activeEmojiCategory) || EMOJI_CATEGORIES[0];
  const displayedEmojis = emojiSearch.trim()
    ? EMOJI_CATEGORIES.flatMap((c) => c.emojis).filter((emoji, idx, self) => self.indexOf(emoji) === idx)
    : currentCategoryObj.emojis;

  // Direct P2P Image states
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleSelectImageFile = (file: File) => {
    if (!file) return;
    if (pendingImage?.previewUrl) {
      URL.revokeObjectURL(pendingImage.previewUrl);
    }
    const isImg = isImageFile(file);
    const previewUrl = isImg ? URL.createObjectURL(file) : '';
    setPendingImage({ file, previewUrl });
    setActiveTab('chat');
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleSelectImageFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          handleSelectImageFile(file);
          break;
        }
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleSelectImageFile(files[0]);
    }
  };

  // Collaborative queue states
  const [queueInput, setQueueInput] = useState('');
  const [showQuickPicks, setShowQuickPicks] = useState(false);

  useBackLayer(isEmojiPickerOpen, () => setIsEmojiPickerOpen(false));
  useBackLayer(isLightboxOpen, () => setIsLightboxOpen(false));
  useBackLayer(showQuickPicks, () => setShowQuickPicks(false));

  const [queueError, setQueueError] = useState('');
  const [isAddingQueue, setIsAddingQueue] = useState(false);

  const handleQueueSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = queueInput.trim();
    if (!trimmed) return;

    setQueueError('');
    setIsAddingQueue(true);
    try {
      const res = await resolvePastedLink(trimmed);
      if ('error' in res && res.error) {
        setQueueError(res.error);
        return;
      }
      if (typeof onAddToQueue === 'function') {
        if (res.kind === 'media') {
          onAddToQueue({ media: res.media, title: res.media.title });
        } else if (res.kind === 'youtube') {
          onAddToQueue({ videoId: res.videoId, title: res.title });
        }
      }
      setQueueInput('');
    } finally {
      setIsAddingQueue(false);
    }
  };

  const handleMoveQueueItem = (fromIndex: number, toIndex: number) => {
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

  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const displayLogs = useMemo(() => {
    return (systemLogs || []).filter((log) => log.category !== 'debug').slice(-15);
  }, [systemLogs]);
  const prevMsgCountRef = useRef(messages.length);

  // Who can be @mentioned: the people in the room, and us (to highlight our own name)
  const peerTargets = useMemo<MentionTarget[]>(
    () => connectedPeers.filter((p) => p.username).map((p) => ({ peerId: p.peerId, name: p.username })),
    [connectedPeers]
  );
  const mentionTargets = useMemo<MentionTarget[]>(
    () => (username ? [...peerTargets, { peerId: localUser?.peerId || 'self', name: username, self: true }] : peerTargets),
    [peerTargets, username, localUser?.peerId]
  );
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    return peerTargets
      .filter((p) => p.name.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(` ${q}`))
      .slice(0, 6);
  }, [mentionQuery, peerTargets]);

  const insertMention = (name: string) => {
    if (!mentionQuery) return;
    const before = inputText.slice(0, mentionQuery.start);
    const after = inputText.slice(mentionQuery.start + 1 + mentionQuery.query.length);
    const next = `${before}@${name} ${after.replace(/^ /, '')}`;
    setInputText(next);
    setMentionQuery(null);
    const caret = before.length + name.length + 2;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const startReply = (msg: ChatMessage) => {
    setReplyTarget({
      id: msg.id,
      // the real name goes out ("You" is only how we show it)
      sender: msg.isSelf ? username : msg.sender,
      mine: msg.isSelf,
      text: plainSnippet(msg.text || (msg.file ? `📎 ${msg.file.name}` : msg.image ? '🖼️ Picture' : ''))
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const jumpToMessage = (id: string) => {
    const el = chatContainerRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('cm-flash');
    void el.offsetWidth;
    el.classList.add('cm-flash');
  };
  const prevLogsCountRef = useRef(displayLogs.length);

  const handleCopyLogs = async () => {
    if (!displayLogs || displayLogs.length === 0) return;
    const formatted = displayLogs.map((log) => {
      const d = new Date(log.timestamp || 0);
      const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      return `[${timeStr}] ${log.text}`;
    }).join('\n');
    const success = await copyToClipboard(formatted);
    if (success) {
      setLogsCopied(true);
      setTimeout(() => setLogsCopied(false), 2000);
    }
  };

  const emojiOnlyIds = useMemo(() => new Set(
    messages
      .filter((msg) => !msg.image?.url && !msg.imageTransfer && isEmojiOnly(msg.text || ''))
      .map((msg) => msg.id)
  ), [messages]);

  const wasNearBottomRef = useRef(true);
  useEffect(() => {
    if (activeTab === 'chat') wasNearBottomRef.current = true;
  }, [activeTab]);

  useEffect(() => {
    const scroller = chatContainerRef.current;
    if (!scroller || activeTab !== 'chat') return;

    const lastMsg = messages[messages.length - 1];
    const isSelfMsg = lastMsg?.isSelf;
    if (wasNearBottomRef.current || isSelfMsg) {
      scroller.scrollTop = scroller.scrollHeight;
      wasNearBottomRef.current = true;
      setShowScrollPill(false);
    } else {
      setShowScrollPill(true);
    }
  }, [messages, activeTab]);

  useEffect(() => {
    const scroller = logsContainerRef.current;
    if (!scroller || activeTab !== 'logs') return;

    const isNearTop = scroller.scrollTop < 80;
    if (isNearTop) {
      scroller.scrollTop = 0;
    }
  }, [displayLogs, activeTab]);

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
      if (typeof onSendFile === 'function') {
        onSendFile(pendingImage.file, clean);
      } else if (typeof onSendImage === 'function') {
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
      onSendMessage(clean, {
        replyTo: replyTarget ? { id: replyTarget.id, sender: replyTarget.sender, text: replyTarget.text } : null,
        mentions: mentionedPeerIds(clean, peerTargets)
      });
      setReplyTarget(null);
      setMentionQuery(null);
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @name suggestions: arrows move, Enter or Tab picks, Esc closes
    if (mentionQuery && mentionSuggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMentionIndex((i) => (i + step + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)].name);
        return;
      }
    }
    if (e.key === 'Escape' && (mentionQuery || replyTarget)) {
      e.preventDefault();
      e.stopPropagation();
      if (mentionQuery) setMentionQuery(null);
      else setReplyTarget(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    const query = mentionQueryAt(e.target.value, e.target.selectionStart ?? e.target.value.length);
    setMentionQuery(query);
    if (!query || query.query !== mentionQuery?.query) setMentionIndex(0);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 80)}px`;
  };

  const quickReactions = useReactionSet();
  const handleReactionClick = (emoji: string) => {
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
              <div className="drag-overlay-title">Drop file or image to share</div>
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

        {/* Tabs: Invite (if alone) vs Chat vs Queue vs Peers */}
        <div className="chat-nav-tabs" role="tablist" aria-label="Room panel">
          {connectedPeers.length === 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'invite'}
              className={`chat-tab-btn ${activeTab === 'invite' ? 'active' : ''}`}
              onClick={() => setActiveTab('invite')}
            >
              <span>Invite</span>
            </button>
          )}

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'chat'}
            className={`chat-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('chat');
              setUnreadChatCount(0);
            }}
          >
            <span>Chat</span>
            {activeTab !== 'chat' && unreadChatCount > 0 && (
              <span className="tab-badge chat-badge" aria-label={`${unreadChatCount} unread`}>{unreadChatCount}</span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'queue'}
            className={`chat-tab-btn ${activeTab === 'queue' ? 'active' : ''}`}
            onClick={() => setActiveTab('queue')}
          >
            <span>Queue</span>
            {queue.length > 0 && <span className="tab-count">{queue.length}</span>}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'peers'}
            className={`chat-tab-btn ${activeTab === 'peers' ? 'active' : ''}`}
            onClick={() => setActiveTab('peers')}
            title="People and voice"
          >
            <span>People</span>
            <span className="tab-count">{connectedPeers.length + 1}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'logs'}
            className={`chat-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('logs');
              setUnreadLogsCount(0);
            }}
            title="Room activity and events log"
          >
            <span>Logs</span>
            {activeTab !== 'logs' && unreadLogsCount > 0 ? (
              <span className="tab-badge logs-badge" aria-label={`${unreadLogsCount} new logs`}>
                {unreadLogsCount}
              </span>
            ) : displayLogs.length > 0 ? (
              <span className="tab-count">{displayLogs.length}</span>
            ) : null}
          </button>

          {activity && !embedded && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'activity'}
              className={`chat-tab-btn chat-tab-activity ${activeTab === 'activity' ? 'active' : ''} ${activityStatus?.attention ? 'needs-you' : ''}`}
              onClick={() => {
                setActiveTab('activity');
                if (activityView !== 'sidebar') {
                  onSetActivityView?.('sidebar');
                }
              }}
              title={activityDefinition ? `${activityDefinition.name} game` : 'Activity'}
            >
              <span>{activityDefinition?.icon || '🎲'} {activityDefinition?.name || 'Game'}</span>
              {activityStatus?.attention && (
                <span className="tab-badge activity-badge" style={activityStatus?.color ? { backgroundColor: activityStatus.color } : undefined} aria-label={activityStatus?.label || 'Your turn'}>•</span>
              )}
            </button>
          )}
        </div>

        {isAudioBlocked && (
          <div className="audio-blocked-chat-banner">
            <div className="blocked-banner-left">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="#f59e0b">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
              <span>Audio &amp; microphone blocked (Text-only mode)</span>
            </div>
            {typeof onToggleBlockAudio === 'function' && (
              <button
                type="button"
                className="btn-unblock-audio"
                onClick={onToggleBlockAudio}
                title="Click to unblock audio &amp; microphone"
              >
                Unblock
              </button>
            )}
          </div>
        )}

        {/* TAB: Docked Activity (Ludo / Games) */}
        {!embedded && (
          <div
            id="activity-sidebar-portal"
            className={`activity-sidebar-container ${activeTab === 'activity' ? 'is-active' : ''}`}
            style={{ display: activeTab === 'activity' ? 'flex' : 'none' }}
          >
            {activeTab === 'activity' && activityView !== 'sidebar' && (
              <div className="activity-sidebar-detached-placeholder">
                <span className="detached-icon">{activityDefinition?.icon || '🎲'}</span>
                <p className="detached-title">{activityDefinition?.name || 'Game'} is {activityView === 'bubble' ? 'minimised' : 'floating'}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onSetActivityView?.('sidebar')}
                >
                  Dock here in sidebar
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 0: Invite Tab (when host is alone in room) */}
        {activeTab === 'invite' && (
          <InvitePanel
            roomId={roomId}
            onShowQr={onOpenQrCode}
            onCopied={() => {}}
            isTab={true}
          />
        )}

        {/* TAB 1: Real Peer Chat */}
        {activeTab === 'chat' && (
          <>
            <div className="chat-messages-container" ref={chatContainerRef} onScroll={handleScroll}>
              {messages.length === 0 ? (
                <div className="chat-empty-state">
                  <div className="empty-state-title">No messages yet</div>
                  <div className="empty-state-subtitle">Say hi — everyone in the room sees it.</div>
                </div>
              ) : (
                <div className="chat-messages-inner cm-feed">
                  {messages.map((msg, index) => {
                    const date = new Date(msg.timestamp || 0);
                    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    const msgInitial = getInitials(msg.sender || '?');
                    const msgAvatarBg = getAvatarColor(msg.sender || 'Peer');
                    const msgNameColor = msgAvatarBg.match(/#[0-9a-f]{6}/i)?.[0] || '#53bdeb';
                    const prevMsg = index > 0 ? messages[index - 1] : null;
                    const startsGroup = !prevMsg || prevMsg.sender !== msg.sender ||
                      Math.abs((msg.timestamp || 0) - (prevMsg.timestamp || 0)) > 5 * 60 * 1000;
                    const emojiOnly = emojiOnlyIds.has(msg.id);

                    return (
                      <div
                        key={msg.id}
                        data-msg-id={msg.id}
                        className={`cm-row ${startsGroup ? 'group-start' : ''} ${msg.isSelf ? 'is-self' : ''} ${msg.mentionsMe ? 'mentions-me' : ''}`}
                      >
                        {startsGroup
                          ? <div className="rd-av cm-av" style={{ ['--av']: msgAvatarBg } as React.CSSProperties} aria-hidden="true">{msgInitial}</div>
                          : <div className="cm-av-spacer" />}
                        <div className="cm-body">
                          {!msg.imageTransfer && (
                            <button
                              type="button"
                              className="cm-reply-btn"
                              onClick={() => startReply(msg)}
                              title="Reply"
                              aria-label={`Reply to ${msg.isSelf ? 'your message' : msg.sender}`}
                            >
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
                            </button>
                          )}
                          {startsGroup && (
                            <div className="cm-meta">
                              <span className="cm-name" style={{ color: msgNameColor }}>{msg.isSelf ? 'You' : msg.sender}</span>
                              {msg.isHost && <span className="cm-host">Host</span>}
                              <span className="cm-time">{timeStr}</span>
                            </div>
                          )}
                          {/* File or Image Transfer in Progress */}
                          {msg.imageTransfer && (
                            <div className="chat-image-transfer-card">
                              <div className="transfer-header">
                                <span className="transfer-icon">{getFileIcon(msg.imageTransfer.fileName, msg.imageTransfer.mimeType)}</span>
                                <div className="transfer-details">
                                  <span className="transfer-filename" title={msg.imageTransfer.fileName}>
                                    {msg.imageTransfer.fileName}
                                  </span>
                                  <span className="transfer-status">
                                    {transferStatusText(msg.imageTransfer, msg.isSelf, formatFileSize(msg.imageTransfer.fileSize))}
                                  </span>
                                </div>
                              </div>
                              {!msg.imageTransfer.isOffered && !msg.imageTransfer.isCancelled && (
                                <div className="transfer-progress-track">
                                  <div
                                    className="transfer-progress-fill"
                                    style={{
                                      width: `${Math.max(4, msg.imageTransfer.percent || 0)}%`,
                                      filter:
                                        msg.imageTransfer.isPaused || msg.imageTransfer.isCancelled
                                          ? 'grayscale(0.8)'
                                          : undefined
                                    }}
                                  />
                                </div>
                              )}
                              {/* A big file offered to us: Accept or Decline */}
                              {msg.imageTransfer.isOffered && !msg.imageTransfer.isCancelled && (
                                <div className="transfer-actions">
                                  <button
                                    type="button"
                                    className="transfer-action-btn is-accept"
                                    onClick={() => onAcceptTransfer?.(msg.transferId || '')}
                                    title="Download this file"
                                  >
                                    ⬇ Accept
                                  </button>
                                  <button
                                    type="button"
                                    className="transfer-action-btn is-cancel"
                                    onClick={() => onCancelTransfer?.(msg.transferId || '')}
                                    title="Don't download this file"
                                  >
                                    Decline
                                  </button>
                                </div>
                              )}
                              {/* Pause / Resume & Cancel Controls (sender and receivers alike) */}
                              {!msg.imageTransfer.isCancelled && !msg.imageTransfer.isOffered && (
                                <div className="transfer-actions">
                                  {msg.imageTransfer.isPaused ? (
                                    <button
                                      type="button"
                                      className="transfer-action-btn"
                                      onClick={() => onResumeTransfer?.(msg.transferId || '')}
                                      title="Resume transfer"
                                    >
                                      ▶ Resume
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="transfer-action-btn"
                                      onClick={() => onPauseTransfer?.(msg.transferId || '')}
                                      title="Pause transfer"
                                    >
                                      ⏸ Pause
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="transfer-action-btn is-cancel"
                                    onClick={() => onCancelTransfer?.(msg.transferId || '')}
                                    title="Cancel transfer"
                                  >
                                    ✕ Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* A folder offered in chat: pick the files to get */}
                          {msg.folder && (
                            <FolderOfferCard
                              folder={msg.folder}
                              mine={msg.isSelf}
                              sender={msg.isSelf ? 'You' : msg.sender}
                              onAccept={(id) => onAcceptTransfer?.(id)}
                              onCancel={(id) => onCancelTransfer?.(id)}
                            />
                          )}

                          {/* Completed Image Thumbnail */}
                          {msg.image?.url && (msg.image.isImage !== false && isImageFile({ type: msg.image.mimeType, name: msg.image.name } as File)) && (
                            <div
                              className="chat-image-card"
                              onClick={() => {
                                setLightboxImage({
                                  url: msg.image!.url,
                                  name: msg.image!.name,
                                  size: msg.image!.size,
                                  sender: msg.sender,
                                  timestamp: msg.timestamp,
                                  caption: msg.text,
                                  blob: msg.image!.blob
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

                          {/* Completed Non-Image File Card */}
                          {msg.image?.url && (msg.image.isImage === false || !isImageFile({ type: msg.image.mimeType, name: msg.image.name } as File)) && (
                            <div className="chat-file-card">
                              <span className="chat-file-icon">{getFileIcon(msg.image.name, msg.image.mimeType)}</span>
                              <div className="chat-file-details">
                                <span className="chat-file-name" title={msg.image.name}>{msg.image.name}</span>
                                <span className="chat-file-size">{formatFileSize(msg.image.size)}</span>
                              </div>
                              <a
                                href={msg.image.url}
                                download={msg.image.name || 'download'}
                                className="chat-file-download-btn"
                                title={`Download ${msg.image.name || 'file'}`}
                              >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                  <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z" />
                                </svg>
                                <span>Save</span>
                              </a>
                            </div>
                          )}

                          {msg.replyTo && (
                            <button
                              type="button"
                              className="cm-reply-quote"
                              onClick={() => jumpToMessage(msg.replyTo!.id)}
                              title="Show the message this replies to"
                            >
                              <span className="cm-reply-quote-name">{msg.replyTo.sender || 'Message'}</span>
                              <span className="cm-reply-quote-text">{msg.replyTo.text || '…'}</span>
                            </button>
                          )}
                          {msg.text && (
                            <p className={`cm-text ${emojiOnly ? 'is-emoji' : ''}`}>
                              <RichText text={msg.text} targets={mentionTargets} onSeekTo={onSeekTo} />
                            </p>
                          )}
                          {msg.text && !emojiOnly && firstLink(msg.text) && <LinkPreview url={firstLink(msg.text)!} />}
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

            {/* Chat Footer with Input Pill & Reactions Dock */}
            <div className="chat-footer">
              {/* Pending Image Attachment Preview Card */}
              {pendingImage && (
                <div className="chat-pending-image-card">
                  <div className="pending-image-thumb-wrap">
                    {pendingImage.previewUrl ? (
                      <img src={pendingImage.previewUrl} alt="Pending upload preview" className="pending-image-thumb" />
                    ) : (
                      <span style={{ fontSize: '22px' }}>{getFileIcon(pendingImage.file.name, pendingImage.file.type)}</span>
                    )}
                  </div>
                  <div className="pending-image-info">
                    <span className="pending-image-name" title={pendingImage.file.name}>{pendingImage.file.name}</span>
                    <span className="pending-image-size">{formatFileSize(pendingImage.file.size)}</span>
                  </div>
                  <button
                    type="button"
                    className="pending-image-cancel-btn"
                    onClick={handleClearPendingImage}
                    title="Remove attached file"
                    aria-label="Remove attached file"
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

              {/* Quick reactions */}
              {(!embedded || showReactions) && (
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
              )}

              {/* Replying to: the quoted message, until sent or dismissed */}
              {replyTarget && (
                <div className="chat-reply-bar">
                  <div className="chat-reply-bar-body">
                    <span className="chat-reply-bar-label">Replying to <strong>{replyTarget.mine ? 'yourself' : replyTarget.sender}</strong></span>
                    <span className="chat-reply-bar-text">{replyTarget.text || '…'}</span>
                  </div>
                  <button
                    type="button"
                    className="chat-reply-bar-close"
                    onClick={() => setReplyTarget(null)}
                    title="Cancel reply (Esc)"
                    aria-label="Cancel reply"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* @name suggestions while typing a mention */}
              {mentionQuery && mentionSuggestions.length > 0 && (
                <div className="chat-mention-list" role="listbox" aria-label="Mention someone">
                  {mentionSuggestions.map((p, idx) => (
                    <button
                      key={p.peerId}
                      type="button"
                      role="option"
                      aria-selected={idx === mentionIndex}
                      className={`chat-mention-option ${idx === mentionIndex ? 'active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(p.name);
                      }}
                    >
                      <span className="rd-av chat-mention-av" style={{ ['--av']: getAvatarColor(p.name) } as React.CSSProperties} aria-hidden="true">
                        {getInitials(p.name)}
                      </span>
                      {p.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Input Pill Container */}
              <div className="chat-input-pill-container">
                {!embedded && (
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
                )}

                <textarea
                  ref={textareaRef}
                  className="chat-pill-textarea"
                  rows={1}
                  maxLength={MAX_CHAT_CHARS}
                  placeholder={isP2PConnected ? 'Message the room' : 'Connecting…'}
                  value={inputText}
                  onChange={handleTextareaChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  disabled={!isP2PConnected}
                />
                {/* Near the limit, say so (typing or pasting past it is cut off) */}
                {inputText.length >= MAX_CHAT_CHARS - 40 && (
                  <span className={`chat-char-count ${inputText.length >= MAX_CHAT_CHARS ? 'is-full' : ''}`} aria-live="polite">
                    {inputText.length}/{MAX_CHAT_CHARS}
                  </span>
                )}

                {/* Attach file or image */}
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: 'none' }}
                  onChange={handleFileInputChange}
                />
                <button
                  type="button"
                  className="chat-pill-attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isP2PConnected}
                  title="Attach a file or image"
                  aria-label="Attach a file or image"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                  </svg>
                </button>

                {embedded && (
                  <button
                    type="button"
                    className={`chat-pill-smiley-btn chat-pill-react-btn ${showReactions ? 'active' : ''}`}
                    onClick={() => setShowReactions((v) => !v)}
                    aria-label={showReactions ? 'Hide reactions' : 'Reactions'}
                    aria-expanded={showReactions}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></svg>
                  </button>
                )}
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
                {(activeVideoId || activeMedia) && (
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
                      (e.target as HTMLElement).style.display = 'none';
                    }}
                  />
                  <div className="now-playing-info">
                    <div className="now-playing-title" title={activeVideoTitle || `Video ID: ${activeVideoId}`}>
                      {activeVideoTitle || `YouTube Video (${activeVideoId})`}
                    </div>
                    <div className="now-playing-sub">
                      <span className="now-playing-sync-dot"></span>
                      <span>Synced P2P</span>
                      {queue.length > 0 && !isLockedForMe && typeof onPlayNextInQueue === 'function' && (
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
              ) : activeMedia ? (
                <div className="now-playing-body">
                  <span className="now-playing-thumb queue-item-thumb-link" aria-hidden="true">{activeMedia.provider === 'twitch' ? '📺' : activeMedia.provider === 'vimeo' ? '🎞️' : '🔗'}</span>
                  <div className="now-playing-info">
                    <div className="now-playing-title" title={activeMedia.url}>{activeMedia.title || activeMedia.url}</div>
                    <div className="now-playing-sub">
                      <span className="now-playing-sync-dot"></span>
                      <span>Synced P2P</span>
                      {queue.length > 0 && !isLockedForMe && typeof onPlayNextInQueue === 'function' && (
                        <button type="button" className="btn-next-inline" onClick={onPlayNextInQueue} title={`Skip immediately to: "${queue[0].title}"`}>
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

              {(activeVideoId || activeMedia) && requiredVotes > 0 && (
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
              onQueue={(v: QuickPickVideo) => onAddToQueue?.({ videoId: v.id, title: v.title }, { autoplay: false })}
              queuedIds={queue.map((item) => item.videoId).filter((id): id is string => Boolean(id))}
            />

            {/* Add Video to Queue Form */}
            <form className="queue-add-form" onSubmit={handleQueueSubmit}>
              <div className="queue-input-wrapper">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="#e5143d" className="queue-input-icon">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
                <input
                  type="text"
                  className="queue-add-input"
                  placeholder="Paste a link (YouTube, Vimeo, Twitch, .mp4…)"
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
              {queue.length > 0 && !isLockedForMe && typeof onClearQueue === 'function' && (
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
                    Paste a YouTube, Vimeo, Twitch or video link, or click &quot;+ Queue&quot; on presets to add videos to the shared queue.
                  </div>
                </div>
              ) : (
                <div className="queue-items-list">
                  {queue.map((item, index) => (
                    <div key={item.id} className="queue-item-card">
                      <span className="queue-item-index">#{index + 1}</span>
                      {item.videoId ? (
                        <img
                          className="queue-item-thumb"
                          src={`https://img.youtube.com/vi/${item.videoId}/default.jpg`}
                          alt="Thumbnail"
                          onError={(e) => {
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className={`queue-item-thumb queue-item-thumb-link is-${item.media?.provider || 'file'}`} aria-hidden="true">
                          {item.media?.provider === 'twitch' ? '📺' : item.media?.provider === 'vimeo' ? '🎞️' : '🔗'}
                        </span>
                      )}
                      <div className="queue-item-details">
                        <div className="queue-item-title" title={item.title}>
                          {item.title}
                        </div>
                        <div className="queue-item-meta">
                          <span>Added by <strong>{item.addedBy}</strong></span>
                        </div>
                      </div>

                      {!isLockedForMe && (
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
                      )}
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
                {displayLogs.length} event{displayLogs.length === 1 ? '' : 's'} recorded (last 15)
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
                    const date = new Date(log.timestamp || 0);
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
            onMakeHost={onMakeHost}
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
