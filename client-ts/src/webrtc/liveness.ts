/**
 * Keeping the signaling socket honest (pure, for tests). Its keep-alive ping must be answered within
 * `answerWithinMs`, or the socket counts as dead (after Wi-Fi <-> mobile data the old one can look
 * open for minutes). Network changes and coming back to the tab ping at once (at most one such probe
 * every `minProbeGapMs`). No extra traffic in a steady room: the keep-alive was already sent every 25 s.
 */
export const SIGNAL_LIVENESS = {
  pingEveryMs: 25000,
  answerWithinMs: 8000,
  minProbeGapMs: 5000
} as const;

export interface LivenessDeps {
  /** Send a ping; false if the socket refused it. */
  sendPing: () => boolean;
  /** The page is in the background (its timers and events can be held back together). */
  isHidden: () => boolean;
  /** The socket is dead: replace it. Called at most once. */
  onDead: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Liveness {
  /** Something arrived on the socket. */
  heard: () => void;
  /** Ping and expect an answer. `regular`: the keep-alive (always sent). */
  probe: (regular?: boolean) => void;
  /** The socket is gone or replaced: stop checking. */
  stop: () => void;
}

export function createLiveness(deps: LivenessDeps, limits: typeof SIGNAL_LIVENESS = SIGNAL_LIVENESS): Liveness {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let heardAt = now();
  let lastProbeAt = -Infinity;
  let timer: unknown = null;
  let dead = false;

  const die = () => {
    if (dead) return;
    dead = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    deps.onDead();
  };

  return {
    heard() {
      heardAt = now();
    },
    probe(regular = false) {
      if (dead) return;
      const sentAt = now();
      if (!regular && sentAt - lastProbeAt < limits.minProbeGapMs) return;
      lastProbeAt = sentAt;
      if (!deps.sendPing()) {
        die();
        return;
      }
      if (timer !== null) clearTimer(timer);
      let waitedHidden = false;
      const check = () => {
        timer = null;
        if (dead || heardAt > sentAt) return;
        if (deps.isHidden() && !waitedHidden) {
          waitedHidden = true;
          timer = setTimer(check, limits.answerWithinMs);
          return;
        }
        die();
      };
      timer = setTimer(check, limits.answerWithinMs);
    },
    stop() {
      dead = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}
