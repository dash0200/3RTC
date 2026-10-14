# Adding a feature

Pick the recipe that matches what you're building. None of them needs changes to the connection
layer (`webrtc/`), and older app versions in the same room keep working.

## A. A game or other activity (chess, Ludo, a poll, a whiteboard)

The room opens one activity at a time over the stage; videos keep playing underneath.

1. **Copy the example:** `client/src/features/activities/sample/` → `features/activities/<id>/`.
   `index.jsx` default-exports the component. It receives `activityId`. For a full game, read
   `features/activities/ludo/`: rules and dice in `rules.js` (tested in `tests/unit/ludo.test.js`),
   board geometry in `board.js`, UI and move animation in `index.jsx`, and the pattern for
   computer players / people who left (the authority's app dispatches an `auto` action that the
   reducer accepts only from the authority: `meta.by === meta.selfId`).
2. **Keep game state in shared state.** All the state everyone must agree on goes in one reducer:

   ```jsx
   import { useSharedState, useRoom } from '../../../core/RoomContext';

   const initial = { fen: START, turn: 'w', players: { w: null, b: null }, result: null };

   // Runs on ONE peer (the authority) for every action. Return the same `state` to reject.
   // meta.by = peer id the action really came from; meta.isHost = whether that peer is the host.
   function reducer(state, action, meta) {
       if (action.kind === 'sit' && !state.players[action.color]) {
           return { ...state, players: { ...state.players, [action.color]: meta.by } };
       }
       if (action.kind === 'move') {
           if (state.players[state.turn] !== meta.by) return state;   // not your turn
           const next = applyMoveIfLegal(state, action.move);          // e.g. chess.js
           return next || state;                                       // illegal: rejected
       }
       if (action.kind === 'reset' && meta.isHost) return initial;
       return state;
   }

   export default function Chess({ activityId }) {
       const room = useRoom();                               // room.getSelfId(), room.peers, ...
       const [game, dispatch] = useSharedState(`act:${activityId}`, { initial, reducer });
       // render from `game`; on a move: dispatch({ kind: 'move', move: { from, to, promotion } })
   }
   ```

   Rules for the reducer: no side effects, don't mutate `state`, plain JSON in and out.
   `meta.present` (who is connected) and `meta.hostId` let it handle people who left.
   Randomness (dice, shuffles) is fine inside the reducer: only the authority runs it and
   everyone receives the result.
3. **Register it** in `features/activities/registry.js`:

   ```js
   { id: 'chess', name: 'Chess', icon: '♟️', description: 'Two players, everyone else watches',
     minPeople: 2, load: () => import('./chess/index.jsx') },
   ```

   The menus (desktop ⋮ and phone More) list it; starting it opens it for everyone; people who
   join later get the activity and its state; leaving resets it; its code downloads only when
   someone opens it; a crash shows "This activity stopped working" instead of breaking the app.
4. **Styles** go in a CSS file next to the component (`import './chess.css'`), so they load with
   it. Use the theme variables from `index.css` (`--bg-surface`, `--text-primary`, ...). Check
   it at phone width (390 px).
5. **Libraries:** prefer MIT / BSD / Apache. Avoid GPL ones (for chess: `chess.js` and
   `react-chessboard` are fine; `chessground` and `stockfish` are GPL).
6. **Test:** add reducer cases to `client/tests/unit/` (use `fakeRoom.js` for multi-peer tests,
   see `sharedState.test.js`), and a browser test next to `client/tests/e2e/activities_test.py`.

Need fast, frequent messages that aren't state (a cursor position, a "thinking…" hint)? Use the
bus directly: `room.bus.broadcast('chess-cursor', { square })` and
`usePeerMessage('chess-cursor', (msg, fromPeerId) => …)`.

## B. A room-wide feature that isn't an activity (polls in chat, a timer, room themes)

1. Create `client/src/features/<name>/use<Name>.js`, a hook taking `{ room, ... }`.
2. Send with `room.bus.broadcast('<name>-<what>', payload)` / `room.bus.send(peerId, ...)`.
   Receive with `usePeerMessageOn(room.bus, '<name>-<what>', (msg, fromPeerId) => ...)`.
3. State that must match for everyone and that late joiners need: use
   `useSharedStateOn(room, '<name>', { initial, reducer })` instead of hand-made sync.
4. Reset on leave: `useEffect(() => room.bus.onEvent('room-left', reset), [room.bus])`.
5. Call the hook in `App.jsx` next to the others and pass what it returns to the components that
   show it.
6. Document the new message types in `docs/PROTOCOL.md`.

## C. A UI-only change (a new modal, a setting)

Components get data and callbacks as props. Something deep in the tree that needs room data can
use `useRoom()` instead of threading new props through every level.

## Don'ts

- Don't send on `peer.dataChannel` yourself, or read `peersRef`: use the bus.
- Don't add new `if (data.type === ...)` branches to `webrtc/peerMessages.js`; subscribe with
  `usePeerMessage` in your feature.
- Don't rename or reuse a shipped message type or field (people on older versions are in the
  same rooms). Add new ones.
- Don't store per-session lists without a cap.
- Don't make one feature reach into another's state; pass what's needed explicitly or use a bus
  event.

## Checklist before shipping

- `npm run lint`, `npm test` and `npm run build` in `client/`
- `python client/tests/e2e/run_all.py` (all browser suites)
- Phone layout checked
- New message types listed in `docs/PROTOCOL.md`
