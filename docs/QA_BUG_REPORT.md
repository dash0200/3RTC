# 3RTC Comprehensive QA Test & Bug Report

**Author Role:** Senior Quality Assurance Engineer / SDET Lead  
**Assessment Date:** October 2026  
**Target Codebase:** [3RTC Application Repository](file:///c:/Users/dvana/Documents/3RTC)  
**Test Coverage:** Frontend Client ([client/](file:///c:/Users/dvana/Documents/3RTC/client)), Signaling Backend ([server/](file:///c:/Users/dvana/Documents/3RTC/server)), WebRTC P2P Mesh Layer ([webrtc/](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc)), Playback Sync & Controls ([features/playback/](file:///c:/Users/dvana/Documents/3RTC/client/src/features/playback)), Live Chat & Soundboard ([features/chat/](file:///c:/Users/dvana/Documents/3RTC/client/src/features/chat)), Shared State & Activities ([features/activities/](file:///c:/Users/dvana/Documents/3RTC/client/src/features/activities)).

---

## 1. Executive Summary

A comprehensive quality assurance and functional assessment of the **3RTC** watch party application was executed. Testing encompassed automated browser-based end-to-end (E2E) flows using headless Chromium, static code inspection, unit test verification across client and server suites, linter output analysis, and edge-case multi-peer synchronization testing.

### Key Quality Metrics:
- **Client Unit Tests:** 127 tests passed across 14 test suites ([client/tests/unit/](file:///c:/Users/dvana/Documents/3RTC/client/tests/unit)).
- **Server Unit Tests:** 23 tests passed across 3 test suites ([server/tests/](file:///c:/Users/dvana/Documents/3RTC/server/tests)) once dependencies were installed.
- **Linter Static Analysis:** 179 warnings flagged by `oxlint` (react purity violations, missing dependency arrays, character class warnings).
- **Automated QA E2E Run:** Identified modal pointer-interception traps and paste truncation defects during live browser execution.

The evaluation identified **12 defects** categorized by severity:
- **4 High Severity:** Critical privacy/memory leak on room transitions, host playback lock bypass, arbitrary shared-state corruption, and unconstrained signaling message broadcast.
- **5 Medium Severity:** Modal Escape/backdrop pointer traps, room code paste truncation, soundboard/reaction sender impersonation, peer count desynchronization, and missing keyboard navigation.
- **3 Low Severity:** React Compiler render impurity violations, regex character class warnings, and missing workspace configuration for server dependencies.

---

## 2. Defects Summary Matrix

| Bug ID | Severity | Title | Affected Component | Category |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-H01** | **HIGH** | Cross-Room Chat & Private Media Leak on Room Switch | [features/chat/useChat.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/chat/useChat.js) | Privacy & Memory Leak |
| **BUG-H02** | **HIGH** | Host Playback Lock Bypass via Unchecked Queue Actions | [features/queue/useQueue.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/queue/useQueue.js) | Access Control Bypass |
| **BUG-H03** | **HIGH** | Shared State Authority Hijack & State Freeze via Unverified `room-state` | [core/sharedState.js](file:///c:/Users/dvana/Documents/3RTC/client/src/core/sharedState.js) | State Sync & DoS |
| **BUG-H04** | **HIGH** | Unchecked Broadcast of Targeted P2P Offers in Multi-User Signaling | [server/signaling.js](file:///c:/Users/dvana/Documents/3RTC/server/signaling.js) | Signaling Protocol Flaw |
| **BUG-M01** | **MEDIUM** | Modal Focus Trap & Missing Escape/Backdrop Click Dismissal | [ServerSettingsModal.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/ServerSettingsModal.jsx), [AudioSettingsModal.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/AudioSettingsModal.jsx) | UI / Accessibility |
| **BUG-M02** | **MEDIUM** | Room Code Input Truncates Pasted Code to 1 Digit on Boxes 2–5 | [hooks/useRoomCodeInput.js](file:///c:/Users/dvana/Documents/3RTC/client/src/hooks/useRoomCodeInput.js) | Usability / Input Defect |
| **BUG-M03** | **MEDIUM** | Unvalidated Sender Identity in Soundboard & Reaction Notifications | [useSoundboard.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/soundboard/useSoundboard.js), [useReactions.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/reactions/useReactions.js) | Integrity / Spoofing |
| **BUG-M04** | **INVALID / DESIGN** | P2P Survival Grace Window on Abrupt Disconnect (Not a Bug) | [signalingMessages.js](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc/signalingMessages.js), [peerRecovery.js](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc/peerRecovery.js) | Working as Designed |
| **BUG-M05** | **MEDIUM** | Missing Arrow Key Left/Right Navigation in 5-Digit Room Code Input | [hooks/useRoomCodeInput.js](file:///c:/Users/dvana/Documents/3RTC/client/src/hooks/useRoomCodeInput.js) | Keyboard UX / A11y |
| **BUG-L01** | **LOW** | Impure `Date.now()` Invocations During LiveChat Render Phase | [LiveChat.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/LiveChat.jsx) | React Performance |
| **BUG-L02** | **LOW** | Combining Enclosing Keycap Sequence in Emoji Regex | [LiveChat.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/LiveChat.jsx) | Regex Correctness |
| **BUG-L03** | **LOW** | Root `package.json` Workspaces Exclude `server` Workspace | [package.json](file:///c:/Users/dvana/Documents/3RTC/package.json) | Build & DX |

---

## 3. High Severity Defects

### BUG-H01: Cross-Room Chat & Private Media Leak on Room Switch
- **Severity:** High
- **Category:** Privacy & Memory Management
- **File:** [client/src/features/chat/useChat.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/chat/useChat.js#L33-L165)
- **Description:**  
  When a user leaves a room via the "Leave room" flow ([App.jsx:347](file:///c:/Users/dvana/Documents/3RTC/client/src/App.jsx#L347)), `mesh.leaveRoom()` emits a local bus event `'room-left'`. While modules like [useQueue.js:50](file:///c:/Users/dvana/Documents/3RTC/client/src/features/queue/useQueue.js#L50), [usePlayback.js:349](file:///c:/Users/dvana/Documents/3RTC/client/src/features/playback/usePlayback.js#L349), and [sharedState.js:147](file:///c:/Users/dvana/Documents/3RTC/client/src/core/sharedState.js#L147) register listeners on `'room-left'` to clear their internal state, [useChat.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/chat/useChat.js) completely lacks an event listener for `'room-left'`.
- **Steps to Reproduce:**
  1. User A creates Room `11111` and sends private chat text messages and uploaded images.
  2. User A clicks "Leave room" (returning to the home screen without refreshing the browser window).
  3. User A joins Room `22222` with a different group of users.
  4. User A opens the chat panel.
- **Expected Result:**  
  The chat panel in Room `22222` must start empty. All previous messages and in-memory image blob URLs from Room `11111` should be cleared and revoked.
- **Actual Result:**  
  All messages, attachments, and unread counts from Room `11111` remain in `messages` state in Room `22222`. Blob URLs created via `URL.createObjectURL()` remain in memory without revocation.
- **Remediation:**  
  Subscribe to `bus.onEvent('room-left')` inside `useChat.js`:
  ```javascript
  useEffect(() => bus.onEvent('room-left', () => {
      setMessages((prev) => {
          for (const m of prev) {
              if (m.image?.url?.startsWith('blob:')) {
                  try { URL.revokeObjectURL(m.image.url); } catch { }
              }
          }
          return [];
      });
      setUnreadChatCount(0);
  }), [bus]);
  ```

---

### BUG-H02: Host Playback Lock Bypass via Unchecked Queue Actions
- **Severity:** High
- **Category:** Access Control & Permissions
- **File:** [client/src/features/queue/useQueue.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/queue/useQueue.js#L103-L109), [useQueue.js:185-187](file:///c:/Users/dvana/Documents/3RTC/client/src/features/queue/useQueue.js#L185-L187)
- **Description:**  
  When host playback lock is enabled (`Only I control playback`), guests are prevented from playing, pausing, seeking, or changing media. However, `useQueue.js` permits consensus skips via `byVote: true`. In the message handler:
  ```javascript
  case 'vote-skip-passed':
      setSkipVotes([]);
      room.log('⏭️ Skip vote passed by consensus');
      break;
  case 'next':
      if (Array.isArray(data.remainingQueue)) setQueue(cleanQueue(data.remainingQueue));
      ...
  ```
  Neither the `vote-skip-passed` nor `next` message types are checked for host authorization or cryptographic tally verification. Any connected guest peer can send `{ type: 'queue-action', action: 'vote-skip-passed' }` or `{ type: 'queue-action', action: 'next', remainingQueue: [...] }` to force the playback to jump to the next item or close playback.
- **Steps to Reproduce:**
  1. Host creates a room, adds 2 videos to the queue, and enables "Only I control playback".
  2. Guest joins the room.
  3. Guest executes in console:
     ```javascript
     const dc = window.__chan.find(c => c.label !== 'bulk' && c.readyState === 'open');
     dc.send(JSON.stringify({ type: 'queue-action', action: 'vote-skip-passed' }));
     dc.send(JSON.stringify({ type: 'queue-action', action: 'next', nextVideoId: 'video2' }));
     ```
  4. Observe host and guest playback.
- **Expected Result:**  
  Guest action should be rejected by host controls with toast notification: `"Only the host can control playback right now"`.
- **Actual Result:**  
  The room immediately skips the video and plays `video2`.
- **Remediation:**  
  Validate that `vote-skip-passed` or `next` actions sent over the bus originate from the room authority or include a verifiable vote count matching connected peers before triggering `playback.playNextInQueue({ byVote: true })`.

---

### BUG-H03: Shared State Authority Hijack & State Freeze via Unverified `room-state`
- **Severity:** High
- **Category:** State Synchronization & Denial of Service
- **File:** [client/src/core/sharedState.js](file:///c:/Users/dvana/Documents/3RTC/client/src/core/sharedState.js#L115-L120)
- **Description:**  
  In [sharedState.js](file:///c:/Users/dvana/Documents/3RTC/client/src/core/sharedState.js#L115-L120), incoming `room-state` wire messages are processed without checking if `fromPeerId` is the recognized authority (`authorityId()`):
  ```javascript
  bus.on('room-state', (msg, fromPeerId) => {
      if (msg.key !== key) return;
      addMember(fromPeerId);
      if (typeof msg.v !== 'number' || msg.v <= version) return;
      set(msg.state, msg.v);
  })
  ```
  A malicious peer can inject a crafted state payload with `v: 2147483647`. All peers in the room (including the actual authority) will overwrite their state and update `version` to `2147483647`. Consequently, all future valid actions computed by the real authority (which increment from the previous valid version, e.g., 3 -> 4) will be rejected by every peer as `msg.v <= version`.
- **Steps to Reproduce:**
  1. Start an activity (e.g. Ludo) in a room with 2 or more participants.
  2. From a guest browser console, transmit:
     ```javascript
     bus.broadcast('room-state', { key: 'activity', v: 99999999, state: { current: null } });
     ```
  3. The activity is instantly terminated on all participants' screens.
  4. Attempt to restart the activity from the Host menu.
- **Expected Result:**  
  Peers reject state broadcast messages from non-authority peers.
- **Actual Result:**  
  All clients apply the non-authority state and will not accept subsequent legitimate states because version 99999999 exceeds all future incremental version numbers.
- **Remediation:**  
  In `bus.on('room-state')`, verify that `fromPeerId` matches `authorityId()`. When a reconnecting host joins with an empty state, it should explicitly request state via `room-state-request`, and only accept `room-state` during the initial catch-up window.

---

### BUG-H04: Unchecked Broadcast of Targeted P2P Offers in Multi-User Signaling
- **Severity:** High
- **Category:** Signaling Protocol Flaw
- **File:** [server/signaling.js](file:///c:/Users/dvana/Documents/3RTC/server/signaling.js#L351-L356)
- **Description:**  
  In the signaling server message router for `offer`, `answer`, and `ice-candidate`, when `targetId` is omitted in a room with 3 or more participants, the server broadcasts the payload to all other peers:
  ```javascript
  // If multi-peer room and no targetId was specified, broadcast to all other peers
  for (const peer of otherPeers) {
    safeSend(peer.ws, outgoingPayload);
  }
  log('SIGNAL', `${normalizedType.toUpperCase()} from ${ws.peerId} broadcast to ${otherPeers.length} peers`);
  ```
  In a mesh WebRTC architecture, offers and answers contain SDP negotiation state specific to a single peer-to-peer RTCPeerConnection instance. Broadcasting an offer to multiple peers simultaneously causes offer collisions, invalid remote SDP descriptions (`have-remote-offer` state conflicts), and WebRTC handshake failure.
- **Steps to Reproduce:**
  1. Open a room with 4 participants.
  2. Send an `offer` message over WebSocket with `targetId: undefined`.
  3. Server relays this single offer to all 3 other peers.
  4. All 3 peers attempt `setRemoteDescription` on their respective local peer connections.
- **Expected Result:**  
  The signaling server must reject offers/answers lacking a valid `targetId` in multi-peer rooms with an error message: `{ type: 'error', message: 'targetId required in multi-peer rooms' }`.
- **Actual Result:**  
  Broadcast causes simultaneous SDP negotiation conflicts and broken P2P channels.
- **Remediation:**  
  Enforce mandatory `targetId` for `offer` and `answer` message types in `server/signaling.js`.

---

## 4. Medium Severity Defects

### BUG-M01: Modal Focus Trap & Missing Escape/Backdrop Click Dismissal
- **Severity:** Medium
- **Category:** UI / Accessibility & Event Trapping
- **Files:**  
  - [client/src/components/ServerSettingsModal.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/ServerSettingsModal.jsx#L24-L29)
  - [client/src/components/AudioSettingsModal.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/AudioSettingsModal.jsx#L41-L53)
- **Description:**  
  While [QrCodeModal.jsx:26-33](file:///c:/Users/dvana/Documents/3RTC/client/src/components/QrCodeModal.jsx#L26-L33) and [NetworkDiagnosticsModal.jsx:17-24](file:///c:/Users/dvana/Documents/3RTC/client/src/components/NetworkDiagnosticsModal.jsx#L17-L24) implement `keydown` listeners for `Escape`, `ServerSettingsModal` and `AudioSettingsModal` do not. Furthermore, their `<div className="modal-backdrop">` wrappers have no `onClick={onClose}` handler.
  During automated Playwright testing, opening `ServerSettingsModal` intercepted pointer events across the entire page, completely blocking subsequent test actions until forced closed.
- **Steps to Reproduce:**
  1. On the home page or inside a room, open Server Settings Modal.
  2. Press the `Escape` key.
  3. Click the dark translucent backdrop area outside the modal card.
- **Expected Result:**  
  Modal closes on Escape keypress and backdrop clicks.
- **Actual Result:**  
  Modal remains open. Focus and clicks are blocked by `<div class="modal-backdrop">`.
- **Remediation:**  
  Add the standard Escape listener and backdrop click handler:
  ```javascript
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);
  ```
  And attach `onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}` to `.modal-backdrop`.

---

### BUG-M02: Room Code Input Truncates Pasted Code to 1 Digit on Boxes 2–5
- **Severity:** Medium
- **Category:** Usability / User Onboarding Flow
- **File:** [client/src/hooks/useRoomCodeInput.js](file:///c:/Users/dvana/Documents/3RTC/client/src/hooks/useRoomCodeInput.js#L48-L60), [DesktopHome.jsx:62](file:///c:/Users/dvana/Documents/3RTC/client/src/components/DesktopHome.jsx#L62)
- **Description:**  
  On the desktop home screen, room codes are entered via 5 individual `<input>` elements generated by `useRoomCodeInput`. In `boxProps(i)`:
  ```javascript
  maxLength: i === 0 ? CODE_LENGTH : 1,
  ```
  Only the 1st box (`i === 0`) has `maxLength: 5`. Boxes 1 through 4 have `maxLength: 1` and do not define an `onPaste` handler.
  - If a user clicks into **Box 0 (the 1st box)** and pastes `98765`, it correctly fills `['9', '8', '7', '6', '5']`.
  - If a user clicks or tabs into **Box 1 (the 2nd box)** and pastes `98765`, the browser truncates the paste to 1 character before firing `onChange`, resulting in `['', '9', '', '', '']`.
  - Pasting on Box 2 yields `['', '', '9', '', '']`.
- **Steps to Reproduce:**
  1. Open [http://localhost:5173/](http://localhost:5173/).
  2. Click into the **2nd box** (or 3rd/4th/5th box) of the room code input.
  3. Paste a copied 5-digit room code: `84920`.
- **Expected Result:**  
  The 5 digits fill the 5 boxes correctly (`8`, `4`, `9`, `2`, `0`).
- **Actual Result:**  
  Only the single digit `8` is inserted into box 2; the remaining digits `4920` are discarded.
- **Remediation:**  
  Add an `onPaste` event handler to `boxProps`:
  ```javascript
  onPaste: (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (pasted) {
      setDigits(Array.from({ length: CODE_LENGTH }, (_, idx) => pasted[idx] || ''));
      boxRefs.current[Math.min(pasted.length, CODE_LENGTH) - 1]?.focus();
    }
  }
  ```

---

### BUG-M03: Unvalidated Sender Identity in Soundboard & Reaction Notifications
- **Severity:** Medium
- **Category:** Integrity / Identity Spoofing
- **Files:**  
  - [client/src/features/soundboard/useSoundboard.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/soundboard/useSoundboard.js#L41-L45)
  - [client/src/features/reactions/useReactions.js](file:///c:/Users/dvana/Documents/3RTC/client/src/features/reactions/useReactions.js#L78)
  - [client/src/core/roomBus.js](file:///c:/Users/dvana/Documents/3RTC/client/src/core/roomBus.js#L48-L51)
- **Description:**  
  When testing via normal UI clicks, the local client automatically sets `sender: self.username`, so the recipient displays the sender's username.
  However, this is an **over-the-wire identity validation defect**. In `useSoundboard.js:44`:
  ```javascript
  room.notify(`🔊 ${data.sender || 'Peer'} played ${data.soundName || 'Sound'} ${data.emoji || ''}`);
  ```
  Unlike `useChat.js` which verifies `sender: room.peerName(from) || data.sender || 'Peer'`, `useSoundboard.js` trusts `data.sender` directly from the payload without checking the connection identity.
- **Steps to Reproduce:**
  1. Connect two peers in a room.
  2. From the guest's console or data channel, transmit:
     ```javascript
     const dc = window.__chan.find(c => c.label !== 'bulk' && c.readyState === 'open');
     dc.send(JSON.stringify({
       type: 'soundboard-sfx',
       soundId: 'airhorn',
       soundName: 'Airhorn',
       emoji: '📢',
       sender: 'System Administrator',
       timestamp: Date.now()
     }));
     ```
  3. Observe the host's toast notification.
- **Expected Result:**  
  Toast displays the sender's authenticated peer name (e.g. `User_492`).
- **Actual Result:**  
  Toast displays: `"🔊 System Administrator played Airhorn 📢"`, allowing arbitrary user impersonation.
- **Remediation:**  
  Always resolve sender names via `room.peerName(from)`:
  ```javascript
  const verifiedSender = room.peerName(from) || 'Peer';
  ```

---

### BUG-M04: Architectural Clarification — P2P Survival Grace Window on Abrupt Tab Close
- **Severity:** Informational / Working as Designed
- **Category:** State Synchronization & Resilience Architecture
- **Files:**  
  - [client/src/webrtc/signalingMessages.js](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc/signalingMessages.js#L235-L245)
  - [client/src/webrtc/peerRecovery.js](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc/peerRecovery.js#L69-L75)
- **Investigation & Finding:**  
  Re-testing confirmed that the peer counter **does not permanently desynchronize**:
  1. When a user clicks **"Leave room"**, `mesh.leaveRoom()` sends `{ type: 'peer-bye' }`, and the peer count immediately updates (0s delay).
  2. When a user **abruptly closes the browser or loses Wi-Fi**, the signaling server immediately sends `peer-left`. However, by architectural design ([signalingMessages.js:239](file:///c:/Users/dvana/Documents/3RTC/client/src/webrtc/signalingMessages.js#L239)), 3RTC deliberately keeps the peer entry alive (`leftEntry.signalingGone = true`) as long as the direct P2P data channel remains open. This prevents dropping a working voice/video call during momentary signaling socket reconnects.
  3. After ~10 seconds, when the underlying WebRTC SCTP layer detects peer loss, `peerRecovery.js` executes cleanup and updates the count back to the exact number.
- **Verdict:** Working as designed. Not a functional defect.

---

### BUG-M05: Missing Arrow Key Left/Right Navigation in 5-Digit Room Code Input
- **Severity:** Medium
- **Category:** Usability & Keyboard Navigation
- **File:** [client/src/hooks/useRoomCodeInput.js](file:///c:/Users/dvana/Documents/3RTC/client/src/hooks/useRoomCodeInput.js#L39-L45)
- **Description:**  
  The `onKeyDown` handler in `useRoomCodeInput` checks for `Backspace` and `Enter`, but ignores `ArrowLeft` and `ArrowRight`. Users navigating between digits using standard arrow keys find their keystrokes ignored.
- **Steps to Reproduce:**
  1. Enter 5 digits into the room code boxes on the home screen.
  2. Press `ArrowLeft` to navigate back to edit a previous digit.
- **Expected Result:**  
  Focus moves to the preceding input box.
- **Actual Result:**  
  Focus remains locked on the current box.
- **Remediation:**  
  Add arrow key handling:
  ```javascript
  if (e.key === 'ArrowLeft' && index > 0) {
    boxRefs.current[index - 1]?.focus();
  } else if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
    boxRefs.current[index + 1]?.focus();
  }
  ```

---

## 5. Low Severity Defects

### BUG-L01: Impure `Date.now()` Invocations During LiveChat Render Phase
- **Severity:** Low
- **Category:** React Compiler Optimization & Purity
- **File:** [client/src/components/LiveChat.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/LiveChat.jsx#L682), [LiveChat.jsx:1281](file:///c:/Users/dvana/Documents/3RTC/client/src/components/LiveChat.jsx#L1281)
- **Description:**  
  In `LiveChat.jsx`:
  ```javascript
  const date = new Date(msg.timestamp || Date.now());
  ```
  `Date.now()` is evaluated directly inside the JSX iteration render loop. React 19 and the React Compiler flag this as an impure function call during render, skipping component memoization optimizations.
- **Remediation:**  
  Ensure timestamps are assigned at creation in `useChat.js` and `useNotices.js`, falling back to `msg.timestamp || 0` during rendering.

---

### BUG-L02: Combining Enclosing Keycap Sequence in Emoji Regex
- **Severity:** Low
- **Category:** Regex Correctness
- **File:** [client/src/components/LiveChat.jsx](file:///c:/Users/dvana/Documents/3RTC/client/src/components/LiveChat.jsx#L10)
- **Description:**  
  The regex:
  ```javascript
  const EMOJI_ONLY_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]|\s)+$/u;
  ```
  triggers `eslint(no-misleading-character-class)` because `\u20e3` (Combining Enclosing Keycap) is combined inside a character class with single code points.
- **Remediation:**  
  Match grapheme clusters using `Intl.Segmenter` or use explicit sequence alternates (e.g. `[0-9#*]\ufe0f?\u20e3`).

---

### BUG-L03: Root `package.json` Workspaces Exclude `server` Workspace
- **Severity:** Low
- **Category:** Build & Developer Experience
- **File:** [package.json](file:///c:/Users/dvana/Documents/3RTC/package.json#L5-L7)
- **Description:**  
  The root `package.json` defines `"workspaces": ["client"]`. When a developer clones the repository and runs `npm install`, dependencies for `server/` (specifically `ws`) are not installed. Running `npm test` or starting the signaling server fails with `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`.
- **Remediation:**  
  Update root `package.json`:
  ```json
  "workspaces": [
    "client",
    "server"
  ]
  ```

---

## 6. Recommendations & Action Plan

1. **Phase 1: Critical Bug Fixes (High Severity)**
   - Implement `room-left` cleanup in `useChat.js` to prevent data leakage between rooms and free image memory.
   - Enforce sender authority verification in `core/sharedState.js` for `room-state` messages.
   - Enforce strict host-only permission checks in `features/queue/useQueue.js` for skip-passed and next events.
   - Mandate `targetId` routing in `server/signaling.js` for P2P offers.

2. **Phase 2: UX & Accessibility Improvements (Medium Severity)**
   - Add global `Escape` listeners and backdrop click handlers to `ServerSettingsModal` and `AudioSettingsModal`.
   - Implement `onPaste` and arrow key navigation in `useRoomCodeInput.js`.
   - Update `useSoundboard.js` and `useReactions.js` to look up sender names via `room.peerName(from)`.

3. **Phase 3: Codebase Cleanliness (Low Severity)**
   - Add `"server"` to root `workspaces`.
   - Resolve React impure function warnings in `LiveChat.jsx`.
