import React, { useState, useRef, useEffect } from 'react';
import { getAvatarColor } from '../utils/sound';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];

export default function LiveChat({
  messages,
  onSendMessage,
  isP2PConnected,
  username,
  isOpen,
  onClose
}) {
  const [inputText, setInputText] = useState('');
  const [showScrollPill, setShowScrollPill] = useState(false);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const textareaRef = useRef(null);

  const initial = (username[0] || 'U').toUpperCase();
  const avatarBg = getAvatarColor(username);

  // Auto-scroll when messages update if user is near bottom
  useEffect(() => {
    const scroller = containerRef.current;
    if (!scroller) return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    if (isNearBottom) {
      scroller.scrollTop = scroller.scrollHeight;
      setShowScrollPill(false);
    } else {
      setShowScrollPill(true);
    }
  }, [messages]);

  const handleScroll = () => {
    const scroller = containerRef.current;
    if (!scroller) return;

    const isNearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    if (isNearBottom) {
      setShowScrollPill(false);
    }
  };

  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setShowScrollPill(false);
    }
  };

  const handleSend = () => {
    const clean = inputText.trim();
    if (clean && isP2PConnected) {
      onSendMessage(clean);
      setInputText('');
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
    } else {
      setInputText(prev => prev + emoji);
    }
  };

  return (
    <aside className={`chat-section ${isOpen ? '' : 'collapsed'}`}>
      <div className="chat-header">
        <div className="chat-header-title-wrap">
          <span className="chat-header-title">Live chat</span>
          <svg className="dropdown-chevron" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M7 10l5 5 5-5z"/>
          </svg>
        </div>

        <div className="chat-header-actions">
          <button className="header-icon-btn" title="Chat Guidelines">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
          </button>
          <button className="header-icon-btn" onClick={onClose} title="Close Chat">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="pinned-banner">
        <div className="pinned-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="#3ea6ff">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        </div>
        <div className="pinned-text">
          <strong>Welcome to P2P Live Chat!</strong> Messages travel directly between peers through WebRTC data channels with zero server storage.
        </div>
      </div>

      <div className="chat-messages-container" ref={containerRef} onScroll={handleScroll}>
        <div className="chat-messages-inner">
          {messages.map((msg) => {
            if (msg.isSystem) {
              return (
                <div key={msg.id} className="yt-system-msg">
                  <span>{msg.text}</span>
                </div>
              );
            }

            const date = new Date(msg.timestamp || Date.now());
            const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const msgInitial = (msg.sender[0] || '?').toUpperCase();
            const msgAvatarBg = getAvatarColor(msg.sender);
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
          <div ref={messagesEndRef} />
        </div>

        {showScrollPill && (
          <button className="scroll-bottom-pill" onClick={scrollToBottom}>
            <span>New messages</span>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
            </svg>
          </button>
        )}
      </div>

      <div className="quick-reactions-bar">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className="reaction-chip"
            onClick={() => handleReactionClick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>

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
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
