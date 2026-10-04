import React, { useState, useRef, useEffect } from 'react';
import { getAvatarColor } from '../utils/sound';
import { copyToClipboard } from '../utils/clipboard';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];

export default function LiveChat({
  messages = [],
  systemLogs = [],
  onSendMessage,
  onClearLogs,
  onTestSound,
  isP2PConnected,
  username,
  isOpen,
  onClose,
  isAudioBlocked = false,
  onToggleBlockAudio
}) {
  const [activeTab, setActiveTab] = useState('chat'); // 'chat' | 'logs'
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const [unreadLogsCount, setUnreadLogsCount] = useState(0);
  const [inputText, setInputText] = useState('');
  const [showScrollPill, setShowScrollPill] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);

  const chatContainerRef = useRef(null);
  const chatEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const logsEndRef = useRef(null);
  const textareaRef = useRef(null);

  const prevMsgCountRef = useRef(messages.length);
  const prevLogsCountRef = useRef(systemLogs.length);

  const initial = (username[0] || 'U').toUpperCase();
  const avatarBg = getAvatarColor(username);

  const handleCopyLogs = async () => {
    if (!systemLogs || systemLogs.length === 0) return;
    const formatted = systemLogs.map((log) => {
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

  // Auto-scroll chat messages when new messages arrive
  useEffect(() => {
    const scroller = chatContainerRef.current;
    if (!scroller || activeTab !== 'chat') return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    if (isNearBottom) {
      scroller.scrollTop = scroller.scrollHeight;
      setShowScrollPill(false);
    } else {
      setShowScrollPill(true);
    }
  }, [messages, activeTab]);

  // Auto-scroll room logs when new logs arrive
  useEffect(() => {
    const scroller = logsContainerRef.current;
    if (!scroller || activeTab !== 'logs') return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (isNearBottom) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [systemLogs, activeTab]);

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
      const diff = systemLogs.length - prevLogsCountRef.current;
      if (diff > 0) {
        setUnreadLogsCount((prev) => prev + diff);
      }
    }
    prevLogsCountRef.current = systemLogs.length;
  }, [systemLogs.length, activeTab]);

  const handleScroll = () => {
    const scroller = chatContainerRef.current;
    if (!scroller) return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (isNearBottom) {
      setShowScrollPill(false);
    }
  };

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      setShowScrollPill(false);
    }
  };

  const handleSend = () => {
    const clean = inputText.trim();
    if (clean && isP2PConnected) {
      onSendMessage(clean);
      setInputText('');
      setActiveTab('chat');
      setUnreadChatCount(0);
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

  const handleReactionClick = (emoji) => {
    if (isP2PConnected) {
      onSendMessage(emoji);
      setActiveTab('chat');
      setUnreadChatCount(0);
    } else {
      setInputText((prev) => prev + emoji);
    }
  };

  return (
    <>
      <div
        className={`mobile-chat-backdrop ${isOpen ? 'active' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`chat-section ${isOpen ? '' : 'collapsed'}`}>
        <div
          className="mobile-sheet-pill-bar"
          onClick={onClose}
          title="Swipe down to dismiss"
        >
          <div className="mobile-sheet-pill"></div>
        </div>

        <div className="chat-header">
          <div className="chat-header-title-wrap">
            <span className="chat-header-title">Live Chat & Activity</span>
          </div>

        <div className="chat-header-actions">
          <button className="header-icon-btn" onClick={onClose} title="Close Sidebar">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tabs: Chat vs Room Logs */}
      <div className="chat-nav-tabs">
        <button
          type="button"
          className={`chat-tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('chat');
            setUnreadChatCount(0);
          }}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
          </svg>
          <span>Chat</span>
          {messages.length > 0 && <span className="tab-badge">{messages.length}</span>}
          {unreadChatCount > 0 && activeTab !== 'chat' && (
            <span className="tab-unread-dot" title={`${unreadChatCount} new messages`}></span>
          )}
        </button>

        <button
          type="button"
          className={`chat-tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('logs');
            setUnreadLogsCount(0);
          }}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
          </svg>
          <span>Room Logs</span>
          {systemLogs.length > 0 && <span className="tab-badge secondary">{systemLogs.length}</span>}
          {unreadLogsCount > 0 && activeTab !== 'logs' && (
            <span className="tab-unread-dot logs" title={`${unreadLogsCount} new events`}></span>
          )}
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
      {activeTab === 'chat' ? (
        <>
          <div className="chat-messages-container" ref={chatContainerRef} onScroll={handleScroll}>
            {messages.length === 0 ? (
              <div className="chat-empty-state">
                <div className="empty-state-icon">💬</div>
                <div className="empty-state-title">No messages yet</div>
                <div className="empty-state-subtitle">Say hello to your peers in the room!</div>
              </div>
            ) : (
              <div className="chat-messages-inner">
                {messages.map((msg) => {
                  const date = new Date(msg.timestamp || Date.now());
                  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  const msgInitial = (msg.sender?.[0] || '?').toUpperCase();
                  const msgAvatarBg = getAvatarColor(msg.sender || 'Peer');
                  const authorClass = msg.isSelf ? 'self' : 'peer';

                  return (
                    <div key={msg.id} className="yt-message">
                      <div className="yt-avatar" style={{ background: msgAvatarBg }}>
                        {msgInitial}
                      </div>
                      <div className="yt-message-content">
                        <span className="yt-timestamp">{timeStr}</span>
                        <span className={`yt-author ${authorClass}`}>{msg.sender}</span>
                        {msg.isHost && <span className="yt-badge">HOST</span>}
                        <span className="yt-text">{msg.text}</span>
                      </div>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div>
            )}

            {showScrollPill && (
              <button className="scroll-bottom-pill" onClick={scrollToBottom}>
                <span>New messages</span>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
                </svg>
              </button>
            )}
          </div>
        </>
      ) : (
        /* TAB 2: Room Activity Logs */
        <div className="logs-panel-wrapper">
          <div className="logs-header-bar">
            <span className="logs-count-label">
              <span className="logs-count-dot"></span>
              {systemLogs.length} event{systemLogs.length === 1 ? '' : 's'} recorded
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
              {systemLogs.length > 0 && (
                <button
                  type="button"
                  className="btn-copy-logs"
                  onClick={handleCopyLogs}
                  title="Copy all logs to clipboard to share in chat"
                >
                  {logsCopied ? '✓ Copied!' : '📋 Copy Logs'}
                </button>
              )}
              {systemLogs.length > 0 && typeof onClearLogs === 'function' && (
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
            {systemLogs.length === 0 ? (
              <div className="chat-empty-state">
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-title">No room logs</div>
                <div className="empty-state-subtitle">Room events, playback sync, and voice actions will appear here.</div>
              </div>
            ) : (
              <div className="room-logs-list">
                {systemLogs.map((log) => {
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
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Reactions Bar */}
      <div className="quick-reactions-bar">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className="reaction-chip"
            onClick={() => handleReactionClick(emoji)}
            title={`Send ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Chat Input Footer */}
      <div className="chat-footer">
        <div className="input-card">
          <div className="input-sender-avatar" style={{ background: avatarBg }}>
            {initial}
          </div>
          <div className="input-body">
            <div className="sender-name-label">Chatting as {username}</div>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              rows={1}
              maxLength={200}
              placeholder={isP2PConnected ? `Chat publicly as ${username}...` : 'Waiting for P2P connection...'}
              value={inputText}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              disabled={!isP2PConnected}
            />
          </div>
        </div>

        <div className="chat-footer-bottom">
          <div className="char-count">{inputText.length}/200</div>
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!isP2PConnected || inputText.trim().length === 0}
            title="Send message"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  </>
);
}
