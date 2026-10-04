import React, { useState, useRef, useEffect } from 'react';

export default function JoinRoomModal({ isOpen, onClose, onConfirm, currentUsername, initialPin = '' }) {
  const [name, setName] = useState(currentUsername);
  const [pinDigits, setPinDigits] = useState(['', '', '', '', '']);
  const [errorMessage, setErrorMessage] = useState('');
  const boxRefs = [useRef(null), useRef(null), useRef(null), useRef(null), useRef(null)];

  useEffect(() => {
    if (isOpen) {
      if (initialPin && /^\d{5}$/.test(initialPin)) {
        setPinDigits(initialPin.split(''));
      } else {
        setPinDigits(['', '', '', '', '']);
      }
      setErrorMessage('');
      setTimeout(() => {
        if (boxRefs[0].current) boxRefs[0].current.focus();
      }, 80);
    }
  }, [isOpen, initialPin]);

  if (!isOpen) return null;

  const enteredPin = pinDigits.join('');
  const isValid = /^\d{5}$/.test(enteredPin);

  const handleDigitChange = (index, value) => {
    const clean = value.replace(/\D/g, '');
    const newDigits = [...pinDigits];
    newDigits[index] = clean ? clean[clean.length - 1] : '';
    setPinDigits(newDigits);
    setErrorMessage('');

    if (clean && index < 4 && boxRefs[index + 1].current) {
      boxRefs[index + 1].current.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !pinDigits[index] && index > 0 && boxRefs[index - 1].current) {
      boxRefs[index - 1].current.focus();
    }
    if (e.key === 'Enter' && isValid) {
      handleJoin();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData('text').trim();
    // Check if user pasted a full room invitation link with ?room=12345
    const urlMatch = raw.match(/[?&]room=(\d{5})/i);
    let digits = '';
    if (urlMatch) {
      digits = urlMatch[1];
    } else {
      digits = raw.replace(/\D/g, '').slice(0, 5);
    }

    if (digits.length > 0) {
      const chars = digits.split('');
      const newDigits = ['', '', '', '', ''];
      chars.forEach((c, i) => {
        if (i < 5) newDigits[i] = c;
      });
      setPinDigits(newDigits);
      const nextIdx = Math.min(chars.length, 4);
      if (boxRefs[nextIdx].current) {
        boxRefs[nextIdx].current.focus();
      }
    }
  };

  const handleJoin = () => {
    if (!isValid) {
      setErrorMessage('Please enter all 5 digits');
      return;
    }
    onConfirm(enteredPin, name.trim() || 'Guest');
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        <div className="mobile-modal-pill" onClick={onClose}></div>
        <div className="modal-header">
          <div className="modal-title">Join Existing Room</div>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">
            Enter the 5-digit numeric code provided by your peer to initiate the direct WebRTC handshake.
          </p>

          <div className="form-group">
            <label className="form-label" htmlFor="joinUsernameInput">Your Display Name</label>
            <input
              id="joinUsernameInput"
              type="text"
              className="text-input"
              placeholder="e.g. Guest"
              maxLength={20}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">5-Digit Room Code</label>
            <div className="pin-inputs" onPaste={handlePaste}>
              {pinDigits.map((digit, idx) => (
                <input
                  key={idx}
                  ref={boxRefs[idx]}
                  type="text"
                  maxLength={1}
                  className="pin-box"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={digit}
                  onChange={(e) => handleDigitChange(idx, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(idx, e)}
                />
              ))}
            </div>
            {errorMessage && <div className="pin-error" style={{ display: 'block' }}>{errorMessage}</div>}
          </div>

          <button
            className="btn btn-primary btn-block"
            onClick={handleJoin}
            disabled={!isValid}
          >
            Join Room
          </button>
        </div>
      </div>
    </div>
  );
}
