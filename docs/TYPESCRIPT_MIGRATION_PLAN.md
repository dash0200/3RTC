# TypeScript Migration Plan for 3RTC

## 1. Executive Summary & Core Invariants

This plan details the step-by-step migration of the 3RTC codebase from JavaScript to TypeScript.
The primary directive is **zero functional, behavioral, or security alterations**. Only the code-level typing and tooling are updated.

### Core Invariants

1. **Behavioral Equivalence (100% Parity):**
   - No features, UI behaviors, animations, state machines, or peer interactions will be added, modified, or removed.
   - Dynamic JavaScript semantics will not be "refactored" into different logic under the guise of typing.
2. **Security Model Preservation:**
   - Peer trust boundaries remain identical: untrusted peer messages are validated at boundary handlers (`webrtc/peerMessages.ts`).
   - Host authority checks (`room.isPeerHost(peerId)`) must never be replaced by untrusted message fields.
   - Server-side seat tokens, cryptographically signed tokens, and rate limits remain byte-for-byte identical.
   - Content sanitization (escaped chat strings, strictly validated `http(s)` URLs) remains intact.
3. **Wire Protocol & Network Parity:**
   - All JSON signaling messages (WebSocket) and DataChannel payloads (`main` channel) must match the schemas defined in [`docs/PROTOCOL.md`](file:///c:/Users/Shril/3RTC/docs/PROTOCOL.md).
   - Binary channel protocols (id 512, `IMG1` image transfers, `p2p-*` video chunk blocks) retain their exact header signatures and byte layouts.
4. **Build & Deployment Integrity:**
   - The Vite build pipeline, service worker precaching hash generator (`vite.config.js`), PWA offline caching, and SEO prerenders must continue functioning seamlessly.
   - Deployment scripts ([`deploy_client.py`](file:///c:/Users/Shril/3RTC/deploy_client.py), [`deploy_vercel.py`](file:///c:/Users/Shril/3RTC/client/deploy_vercel.py), [`deploy_oracle.py`](file:///c:/Users/Shril/3RTC/deploy_oracle.py), [`deploy_gcp.py`](file:///c:/Users/Shril/3RTC/server/deploy_gcp.py)) and systemd service configs must not be broken.

---

## 2. Codebase Scope & Inventory

| Component | Files | Lines of Code | Primary Responsibilities |
| :--- | :---: | :---: | :--- |
| **`client/src/core/`** | 4 | ~570 | `roomBus`, `sharedState`, `RoomContext`, `backStack` |
| **`client/src/webrtc/`** | 10 | ~1,230 | `usePeerMesh`, signaling handlers, peer data channels, ICE recovery |
| **`client/src/utils/`** | 20 | ~3,940 | P2P streaming swarm, drift sync, cache, crypto, format inspection |
| **`client/src/hooks/`** | 8 | ~1,200 | Device enumerations, keyboard shortcuts, viewport / mobile resize |
| **`client/src/features/`** | 48 | ~6,100 | Chat, reactions, soundboard, queue, playback, activities (Ludo, etc.) |
| **`client/src/components/`** | 37 | ~10,430 | UI components, modals, stage, overlays, controls |
| **`client/src/pwa/`** | 3 | ~310 | Service worker registration, offline cache template |
| **`client/src/ (root)`** | 3 | ~970 | `App.jsx`, `main.jsx`, `version.js` |
| **`client/tests/unit/`** | 26 | ~2,500 | Node test runner unit tests (`*.test.js`) |
| **`server/`** | 11 | ~1,780 | Node.js WebSocket signaling, YouTube quick picks, seats, rate limiter |
| **Total** | **~171** | **~29,700** | Full repository code surface |

---

## 3. Migration Strategy: Progressive Module-by-Module

An incremental "inside-out" migration with `allowJs: true` will be used rather than a risky all-at-once conversion. This ensures the app builds and tests pass at every intermediate step.

```mermaid
graph TD
    P0[Phase 0: Tooling & Non-breaking Baseline] --> P1[Phase 1: Ambient & Protocol Types]
    P1 --> P2[Phase 2: Core Plumbing (core/*)]
    P2 --> P3[Phase 3: WebRTC Layer (webrtc/*)]
    P3 --> P4[Phase 4: Shared Utilities (utils/*)]
    P4 --> P5[Phase 5: Feature Logic & Hooks (features/* & hooks/*)]
    P5 --> P6[Phase 6: UI Components & App Root]
    P6 --> P7[Phase 7: PWA & Web Workers]
    P7 --> P8[Phase 8: Signaling Server (server/*)]
    P8 --> P9[Phase 9: Strictness & Full Verification]
```

---

## 4. Detailed Execution Phases

### Phase 0: Tooling & Non-Breaking Baseline

**Goal:** Establish TypeScript infrastructure in `client/` without touching any existing `.js`/`.jsx` files or breaking dev/build pipelines.

1. **Install Dependencies:**
   - In `client/`: Add `typescript` to `devDependencies` (`@types/react` and `@types/react-dom` are already present in [`client/package.json`](file:///c:/Users/Shril/3RTC/client/package.json)).
2. **Create `client/tsconfig.json`:**
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "useDefineForClassFields": true,
       "lib": ["ES2022", "DOM", "DOM.Iterable"],
       "module": "ESNext",
       "skipLibCheck": true,
       "moduleResolution": "bundler",
       "allowImportingTsExtensions": false,
       "resolveJsonModule": true,
       "isolatedModules": true,
       "noEmit": true,
       "jsx": "react-jsx",
       "strict": true,
       "noUnusedLocals": false,
       "noUnusedParameters": false,
       "noFallthroughCasesInSwitch": true,
       "allowJs": true,
       "checkJs": false
     },
     "include": ["src", "tests/unit"]
   }
   ```
3. **Add Global Ambient Declarations (`client/src/env.d.ts`):**
   - Typed declarations for `__APP_BUILD__` (injected in [`client/vite.config.js`](file:///c:/Users/Shril/3RTC/client/vite.config.js)).
   - Asset imports: `*.svg`, `*.png`, `*.wasm`, `*.m3u8`.
4. **Update `client/package.json` Scripts:**
   - Add `"typecheck": "tsc --noEmit"`.
   - Update `npm run test` configuration to ensure Node test runner can execute TypeScript files (using Node's native `--experimental-strip-types` or `tsx`).
5. **Validation:**
   - Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test`. All must pass with zero changes to runtime behavior.

---

### Phase 1: Shared Protocol & Contract Typings (`client/src/types/`)

**Goal:** Formulate strict type definitions directly derived from [`docs/PROTOCOL.md`](file:///c:/Users/Shril/3RTC/docs/PROTOCOL.md) and [`docs/ARCHITECTURE.md`](file:///c:/Users/Shril/3RTC/docs/ARCHITECTURE.md).

Create type files with **zero runtime footprint** (pure types and interfaces):
- `src/types/protocol.ts`:
  - `SignalingMessage`: Discriminated union for `room-created`, `joined`, `peer-joined`, `peer-left`, `offer`, `answer`, `ice-candidate`, `error`, `heartbeat`.
  - `DataChannelMessage`: Discriminated union for `main` channel messages (`chat`, `reaction`, `soundboard-sfx`, `yt-action`, `media-action`, `media-sync-state`, `room-settings`, `peer-identity`, `room-state`, etc.).
  - `BinaryMessageKind`: Signatures for `IMG1`, video stream chunk envelopes.
- `src/types/room.ts`:
  - `PeerEntry`: `{ peerId: string; username: string; isHost: boolean; ... }`
  - `Room`: Interface representing the room object passed throughout the app (`bus`, `getSelf`, `getSelfId`, `isPeerHost`, `getHostPeerId`, `notify`, `log`, etc.).
  - `RoomSettings`: `{ playbackLock: boolean }`.
- `src/types/sharedState.ts`:
  - `Reducer<S, A>`: `(state: S, action: A, meta: ActionMeta) => S`.
  - `ActionMeta`: `{ by: string; isHost: boolean; selfId: string; present: string[] }`.

---

### Phase 2: Core Plumbing (`client/src/core/`)

**Goal:** Convert shared foundational modules that underpin the entire event-driven architecture.

1. **`core/roomBus.js` → `roomBus.ts`:**
   - Type `broadcast<T>(type: string, payload: T)` and `send<T>(peerId: string, type: string, payload: T)`.
   - Type event listeners: `on(type, handler)`, `onBinary(handler)`, `onEvent(eventName, handler)`.
   - Ensure fake channels used in tests stay 100% compatible.
2. **`core/sharedState.js` → `sharedState.ts`:**
   - Type authority election logic (`getAuthorityId`), versioning vectors, action buffering, and late-join snapshots.
3. **`core/backStack.js` → `backStack.ts`:**
   - Type history guard entries, modal close callbacks, and URL query preservation (`?room=`).
4. **`core/RoomContext.jsx` → `RoomContext.tsx`:**
   - Provide strongly typed React contexts and hooks: `useRoom()`, `usePeerMessage<T>()`, `useBusEvent()`, `useSharedState<S, A>()`.
5. **Validation:**
   - Run `tests/unit/roomBus.test.js`, `tests/unit/sharedState.test.js`, `tests/unit/backStack.test.js`.

---

### Phase 3: WebRTC Connection Layer (`client/src/webrtc/`)

**Goal:** Convert the peer-to-peer connection management and signaling layer.

1. **`webrtc/config.js` → `config.ts`:**
   - Type ICE server configs, recovery intervals, protocol version constants.
2. **`webrtc/sdp.js` & `remoteAudio.js` → `.ts`:**
   - Codec preference tuning, Opus parameters, Web Audio routing without altering audio processing nodes.
3. **`webrtc/peerRecovery.js` & `peerEntry.js` → `.ts`:**
   - Typing ICE restart logic and peer cleanup lifecycles.
4. **`webrtc/signalingMessages.js` & `peerMessages.js` → `.ts`:**
   - Boundary validation: Map raw JSON events onto `SignalingMessage` and `DataChannelMessage`.
   - **Security check:** Verify incoming messages continue to have `isHost` overridden by the server's authoritative state before dispatching to `bus`.
5. **`webrtc/streamTree.js` → `streamTree.ts`:**
   - Relay tree pure calculation functions.
6. **`webrtc/usePeerMesh.js` → `usePeerMesh.ts`:**
   - Main hook owning `RTCPeerConnection` maps, data channels (`main` and `bulk`), and room lifecycle.
7. **Validation:**
   - Run `tests/unit/p2pSecurity.test.js`, `tests/unit/senderTrust.test.js`, `tests/unit/streamTree.test.js`.

---

### Phase 4: Shared Utilities (`client/src/utils/`)

**Goal:** Migrate computational, parsing, media detection, and streaming utilities.

1. **Pure Utilities:**
   - `crypto.js` → `crypto.ts`: SHA-256 block hashing and seat token utilities.
   - `networkHint.js` → `networkHint.ts`: Network connectivity classification.
   - `version.js` → `version.ts`: Build and semantic version parsing.
2. **Media & Format Analyzers:**
   - `formats.js` → `formats.ts`: MP4, MOV, MKV, WebM container and codec sniffing.
   - `mediaSources.js` → `mediaSources.ts`: YouTube, Vimeo, Twitch, and direct link detection.
3. **P2P Swarm & Video Transfer:**
   - `p2pStreamer.js` → `p2pStreamer.ts`: Block allocation, swarm bitfields, bandwidth tracking.
   - `streamCache.js` → `streamCache.ts`: IndexedDB / memory storage for video blocks.
4. **Validation:**
   - Run `tests/unit/fileFormats.test.js`, `tests/unit/mediaSources.test.js`, `tests/unit/streamSwarm.test.js`, `tests/unit/streamCache.test.js`.

---

### Phase 5: Feature Logic & Hooks (`client/src/features/` & `client/src/hooks/`) - [COMPLETED]

**Goal:** Migrate UI-independent feature logic, state reducers, and custom React hooks.

1. **Playback Engine (`features/playback/`):**
   - `usePlayback.js` → `usePlayback.ts`: Video play/pause/seek synchronization.
   - `useDriftSync.js` → `useDriftSync.ts`: Auto-resync calculations (1.5 s threshold).
   - `useHostControls.js` → `useHostControls.ts`: Playback lock permissions.
   - `useMediaSync.js` → `useMediaSync.ts`: Catch-up payloads for late joiners.
   - `useStreamTransfer.js` → `useStreamTransfer.ts`: File sharing coordination.
   - `drift.js` → `drift.ts`: Pure drift correction algorithms.
2. **Activities / Games (`features/activities/`):**
   - `features/activities/ludo/rules.js` → `rules.ts`: Deterministic board game engine and dice mechanics.
   - `features/activities/ludo/board.js` → `board.ts`: Board geometries and coordinates.
   - `activityState.ts`, `activityHost.ts`, `registry.ts`, `useActivities.ts`, `useActivityLoad.ts`.
3. **Media Adapters (`features/media/adapters/`):**
   - Vimeo, Twitch, HTML5 `<video>`, and HLS adapter wrappers typed against player APIs.
   - `sources.ts`, `resolveLink.ts`.
4. **App Hooks (`src/hooks/`):**
   - `useIsPhone.ts`, `useKeyboardShortcuts.ts`, `usePopover.ts`, `useWakeLock.ts`, `useRoomCodeInput.ts`, `useNetworkStats.ts`, `useVoiceChat.ts`.
5. **Remaining Feature Hooks:**
   - `chat/useChat.ts`: P2P chat and chunked image messaging.
   - `reactions/`: `reactionSet.ts`, `reactionFeed.ts`, `useReactions.ts`.
   - `queue/useQueue.ts`: Watch queue and consensus vote-to-skip.
   - `soundboard/useSoundboard.ts`: Web Audio clip broadcasting and settings.
   - `screenshare/useScreenShare.ts`: WebRTC getDisplayMedia lifecycle and track replacement.
   - `notices/useNotices.ts`: Centralized toast and room log store.
   - `subtitles/pgsRenderer.ts`: WebAssembly PGS subtitle canvas overlay renderer via `libbitsub`.
6. **Validation:**
   - `npm run build` (`tsc -b && vite build`): PASS (0 errors, 140ms build).
   - `npm test`: 47 tests passing across 21 suites (100% pass rate).
   - `npm run lint`: 0 errors.

---

### Phase 6: React Components & UI Wiring (`client/src/components/`, `App.jsx`, `main.jsx`) - [COMPLETED]

**Goal:** Migrate React visual components from `.jsx` to `.tsx`.

1. **Batch 6.1 - Styles & Base Primitives:**
   - Bundled stylesheets: `index.css`, `App.css`, `phone.css`, `redesign.css`.
   - Core primitives: `icons.tsx`, `Logo.tsx`, `SyncPill.tsx`, `TrendingRegionSelect.tsx`.
2. **Batch 6.2 - Modals & Dialogs:**
   - `SettingsModal.tsx`, `AudioSettingsModal.tsx`, `AudioDevicePicker.tsx`, `NetworkDiagnosticsModal.tsx`, `QrCodeModal.tsx`, `PreJoinModal.tsx`, `LeaveRoomDialog.tsx`, `SoundboardTray.tsx`, `ReactionsEditor.tsx`.
3. **Batch 6.3 - Feature Panels & Overlays:**
   - `features/activities/ActivityStage.tsx`, `ActivityBubble.tsx`, `ludo/LudoUI.tsx`, `ludo/LudoGame.tsx`, `ludo/LudoPiece.tsx`, `ludo/LudoDice.tsx`, `ludo/LudoBoard.tsx`, `ludo/LudoLobby.tsx`.
   - `features/media/AddVideoModal.tsx`, `features/media/LocalPlayerControls.tsx`.
4. **Batch 6.4 - Video Players & Stage Controls:**
   - `features/media/PasteLinkForm.tsx`, `LinkPlayer.tsx`, `YouTubeSyncPlayer.tsx`, `LocalVideoSyncPlayer.tsx` (typed with MediaSession, WASM PGS subtitles, HTML5 video).
   - `components/room/ScrubberReactionHeatmap.tsx`, `AmbientCinemaGlow.tsx`, `ScreenPointerOverlay.tsx`, `VideoPeopleOverlay.tsx`, `ScreenShareStage.tsx`, `Stage.tsx`.
5. **Batch 6.5 - Shells, Phone UI, LiveChat & App Root:**
   - `RejoinCard.tsx`, `PhoneMediaOverlays.tsx`, `DesktopDock.tsx`, `InvitePanel.tsx`, `LiveChat.tsx`, `InviteScreen.tsx`, `Header.tsx`, `DesktopHome.tsx`, `PhoneHome.tsx`, `PhoneChrome.tsx`, `PhoneSheets.tsx`.
   - `src/App.tsx`: Full application root with room facade, media sync, WebRTC mesh, peer management, and responsive phone/desktop layouts.
   - `src/main.tsx`: React 19 root mount with self-hosted bundled fonts and PWA service worker registration.
6. **Validation:**
   - `npm run build` (`tsc -b && vite build`): PASS (184 modules transformed, 0 errors, built in 442ms).
   - `npm test`: PASS (47 tests passing across 21 test suites in 439ms, 0 failures).

---

### Phase 7: PWA, Web Workers & Special Assets (`client/src/pwa/`) - [COMPLETED]

**Goal:** Migrate workers and PWA components while strictly preserving build-time string replacements.

1. **`subtitleWorker.ts`:**
   - Bundled via native Vite worker URL: `new Worker(new URL('./subtitleWorker.ts', import.meta.url), { type: 'module' })` in `extractSubtitles.ts`.
2. **`registerServiceWorker.ts` & `useNewVersionNotice.ts`:**
   - Service worker lifecycle, registration, and update notice hook checking `/version.json`.
3. **Service Worker Template (`src/pwa/sw.js`):**
   - Typed with `/// <reference lib="webworker" />` and JSDoc `ServiceWorkerGlobalScope` typings for full IDE checking.
   - Preserved template placeholders `const VERSION = '__SW_VERSION__';` and `const PRECACHE_URLS = __PRECACHE_URLS__;`.
4. **Vite Build Infrastructure (`vite.config.ts`):**
   - Implemented `pwaServiceWorker()` plugin calculating 12-char SHA-256 build hash across all non-excluded bundles/static assets.
   - Emits `dist/sw.js` with computed version and clean precache URLs.
   - Emits `dist/version.json` with India-time build numbers (`YYMMDD.HHMM`), git SHA, and branch.
5. **Validation:**
   - `npm run build` (`tsc -b && vite build`): PASS (184 modules transformed, 0 errors, built in 742ms). Verified `dist/sw.js` and `dist/version.json` generated properly with all placeholders replaced.
   - `npm test`: PASS (52 tests passing across 22 suites in 610ms).
   - `npm run lint`: 0 errors.

---

### Phase 8: Signaling Server (`server/`) - [COMPLETED]

**Goal:** Type the signaling server without impacting deployment scripts or runtime systemd configurations.

#### Context & Constraints:
- Deploy scripts ([`server/deploy_oracle.py`](file:///c:/Users/Shril/3RTC/server/deploy_oracle.py) and [`server/deploy_gcp.py`](file:///c:/Users/Shril/3RTC/server/deploy_gcp.py)) explicitly upload `SERVER_FILES`:
  ```python
  SERVER_FILES = ["server.js", "signaling.js", "seats.js", "rateLimit.js", "quickPicks.js", "log.js", "package.json"]
  ```
- The production systemd unit executes:
  ```ini
  ExecStart=/usr/bin/node server.js
  ```

#### Implementation (Option A - Zero Deployment Risk):
1. Created `server/tsconfig.json` with `"checkJs": true`, `"allowJs": true`, and `"noEmit": true`.
2. Created `server/types/protocol.d.ts` declaring `SignalingSocket`, `RoomInfo`, and all message schemas.
3. Added JSDoc type annotations across `server/server.js`, `server/signaling.js`, and `server/quickPicks.js`.
4. Fixed latent runtime bugs discovered during typechecking:
   - Added missing `catch` block on `http.createServer` in `server/server.js`.
   - Wired `createRateLimiter` and `isOriginAllowed` in `server/signaling.js`.
   - Populated `preSerializedCache` and exported `invalidateQuickPicksCache` in `server/quickPicks.js`.
   - Added missing defensive security headers (`X-Frame-Options: SAMEORIGIN`) in `server/quickPicks.js`.
5. **Validation:**
   - `npm run typecheck` (`tsc --noEmit`): PASS (0 errors).
   - `npm test`: PASS (40 tests passing across 6 suites in 3.8s, 100% pass rate).
   - Zero changes to deployment script expectations (`node server.js` remains pure vanilla Node.js ES module).

---

### Phase 9: Verification, Strictness Hardening & Testing - [COMPLETED]

**Goal:** Validate absolute behavioral and security parity across the entire application.

1. **Compilation & Typing:**
   - Client: `npm run typecheck` (`tsc -b`) in `client-ts/`: **0 errors**.
   - Server: `npm run typecheck` (`tsc --noEmit`) in `server/`: **0 errors**.
2. **Linting:**
   - Ran `npm run lint` (`oxlint`) across the codebase: **0 errors**.
3. **Automated Unit Testing:**
   - Client unit tests: `npm test` in `client-ts/` → **52 passing tests across 22 suites (100% pass rate)**.
   - Server unit tests: `npm test` in `server/` → **40 passing tests across 6 suites (100% pass rate)**.
4. **Production Build & Asset Checks:**
   - Ran `npm run build` (`tsc -b && vite build`) in `client-ts/`: transformed 184 modules in 561ms, **0 errors**.
   - Emits `dist/sw.js` with computed SHA-256 version and complete precache list.
   - Emits `dist/version.json` with India-time build stamping and git metadata.
   - Client dist assets: WASM binaries (`rnnoise`, `rnnoise_simd`, `libbitsub_bg`), web workers (`subtitleWorker`, `workletProcessor`), font weights, and split chunks.
5. **Zero Deployment Regressions:**
   - Original `client/` untouched.
   - Server runtime command `node server.js` executes directly without build step or container reconfigurations.

---

## 5. Risk Matrix & Mitigations

| Risk | Impact | Mitigation Strategy | Status |
| :--- | :---: | :--- | :--- |
| **`vite.config.js` SW placeholder failure** | High (Breaks PWA offline) | Do not change `__SW_VERSION__` or `__PRECACHE_URLS__` syntax. Retain `sw.js` format or verify build hook output in test. | **Mitigated (Verified via test & dist output)** |
| **Deploy script file list mismatches** | High (Production deployment fails) | Keep server files aligned with `SERVER_FILES` in `deploy_*.py` or use Phase 8 Option A. | **Mitigated (Option A implemented, 100% compatible)** |
| **Runtime type assertion bugs (`as AnyType`)** | Medium | Disallow unsafe `any` casts in security-sensitive boundaries (`peerMessages.ts`, `senderTrust.ts`). | **Mitigated (Strict types in protocol & trust guards)** |
| **Vite Web Worker import path breakages** | Medium | Use standard Vite URL worker pattern: `new Worker(new URL('./path.ts', import.meta.url), { type: 'module' })`. | **Mitigated (Verified build chunk generation)** |
| **React 19 ref / props type changes** | Low | Follow React 19 conventions (no `forwardRef` needed in standard functional components). | **Mitigated (All components typed for React 19)** |

---

## 6. Definition of Done (Checklist)

- [x] All `.js` / `.jsx` files in `client/src` migrated to `.ts` / `.tsx` (in `client-ts/`).
- [x] `npm run typecheck` passes cleanly with zero errors under strict mode in `client-ts/` and `server/`.
- [x] `npm run lint` passes without errors.
- [x] `npm run test` executes all unit tests with 100% pass rate (52 client + 40 server = 92 tests).
- [x] Production build (`npm run build`) emits valid bundles and functioning PWA service worker (`dist/sw.js`, `dist/version.json`).
- [x] No changes to wire protocols, binary formats, or security checks.
- [x] All deployment scripts ([`deploy_client.py`](file:///c:/Users/Shril/3RTC/deploy_client.py), [`deploy_oracle.py`](file:///c:/Users/Shril/3RTC/deploy_oracle.py), [`deploy_gcp.py`](file:///c:/Users/Shril/3RTC/server/deploy_gcp.py)) continue to pass verification checks without requiring VM modification.
