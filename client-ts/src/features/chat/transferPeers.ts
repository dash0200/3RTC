/**
 * Who gets each chat file, and what `p2p-file-control` `accept` and `cancel` do
 * (docs/PROTOCOL.md). The desktop app has the same rules in `desktop/crates/core/src/transfers.rs`.
 *
 * - A file of ACCEPT_MIN_BYTES or more, and every file of a folder offer, is only offered: each
 *   receiver is *waiting* until they accept it; then the sender sends it to them alone. Smaller
 *   files go to everyone straight away (as before).
 * - A cancel from the peer that announced a file (its sender) cancels it for everyone:
 *   receivers stop and show it as cancelled.
 * - A cancel from a receiver (or declining an offer) only takes that receiver out: the sender
 *   stops sending to them. Once no receiver is left waiting or receiving, the transfer is over:
 *   finished if anyone got it, else stopped (nobody wanted it).
 * - Any other cancel or accept (another receiver's, seen by a receiver) is ignored.
 *
 * No I/O here; `useChat.ts` does the sending.
 */

/** Files at least this big wait for each receiver to accept them (8 MB, as the desktop app). */
export const ACCEPT_MIN_BYTES = 8 * 1024 * 1024;

/** Whether a single file of `size` bytes waits for receivers to accept it. */
export const needsAccept = (size: number): boolean => Number.isFinite(size) && size >= ACCEPT_MIN_BYTES;

/** How a transfer of ours ended: someone got it, or nobody did (stop it). */
export type Ended = 'finished' | 'nobody-got-it';

export type CancelOutcome =
  /** Our file: stop sending it to this peer only (others still wait for or get it). */
  | { kind: 'stop-to'; peer: string }
  /** Our file, and that was the last receiver. */
  | { kind: 'over'; ended: Ended }
  /** Their file, cancelled by its sender: stop receiving and show it cancelled. */
  | { kind: 'cancelled' }
  /** Not for us to act on. */
  | { kind: 'ignore' };

/** Where one of our files is with its receivers. */
export interface SendStatus {
  waiting: number;
  sending: number;
  sent: number;
}

interface Out {
  waiting: Set<string>;
  sending: Set<string>;
  sent: Set<string>;
}

const endedOf = (out: Out): Ended | null => {
  if (out.waiting.size > 0 || out.sending.size > 0) return null;
  return out.sent.size > 0 ? 'finished' : 'nobody-got-it';
};

export class TransferPeers {
  private outgoing = new Map<string, Out>();
  /** Theirs (files and folders): who announced each. */
  private incoming = new Map<string, string>();

  /** We announced `transferId` to `peers`: they wait to accept it (`offered`), or get it now. */
  sending(transferId: string, peers: Iterable<string>, offered = false): void {
    const all = new Set(peers);
    this.outgoing.set(transferId, {
      waiting: offered ? all : new Set(),
      sending: offered ? new Set() : all,
      sent: new Set()
    });
  }

  /** `from` announced `transferId` (a file or a folder) to us. */
  receiving(transferId: string, from: string): void {
    this.incoming.set(transferId, from);
  }

  /** Who announced `transferId` to us. */
  senderOf(transferId: string): string | undefined {
    return this.incoming.get(transferId);
  }

  /** It's our file, still offered or being sent. */
  isOurs(transferId: string): boolean {
    return this.outgoing.has(transferId);
  }

  /** It's someone else's file (or folder), still coming in or offered. */
  isTheirs(transferId: string): boolean {
    return this.incoming.has(transferId);
  }

  /** No more of our `transferId` goes to `peer` (they cancelled, left, or never accepted). */
  isDropped(transferId: string, peer: string): boolean {
    const out = this.outgoing.get(transferId);
    return !out || !out.sending.has(peer);
  }

  /** Where our `transferId` is with its receivers. */
  status(transferId: string): SendStatus | null {
    const out = this.outgoing.get(transferId);
    if (!out) return null;
    return { waiting: out.waiting.size, sending: out.sending.size, sent: out.sent.size };
  }

  /** `from` accepted our `transferId`: true when it should now be sent to them. */
  onAccept(transferId: string, from: string): boolean {
    const out = this.outgoing.get(transferId);
    if (!out || !out.waiting.delete(from)) return false;
    out.sending.add(from);
    return true;
  }

  /** A `cancel` for `transferId` came from `from` (or they declined it). */
  onCancel(transferId: string, from: string): CancelOutcome {
    const out = this.outgoing.get(transferId);
    if (out) {
      const was = out.waiting.delete(from);
      const was2 = out.sending.delete(from);
      if (!was && !was2) return { kind: 'ignore' };
      const ended = endedOf(out);
      if (ended) {
        this.finish(transferId);
        return { kind: 'over', ended };
      }
      return { kind: 'stop-to', peer: from };
    }
    if (this.incoming.get(transferId) === from) {
      this.finish(transferId);
      return { kind: 'cancelled' };
    }
    return { kind: 'ignore' };
  }

  /** `peer` has all of our `transferId`. Not null when that was the last receiver (forgotten). */
  delivered(transferId: string, peer: string): Ended | null {
    const out = this.outgoing.get(transferId);
    if (!out || !out.sending.delete(peer)) return null;
    out.sent.add(peer);
    const ended = endedOf(out);
    if (ended) this.finish(transferId);
    return ended;
  }

  /** `peer` is back after a reconnect (`p2p-file-sync`): they receive our file again. */
  rejoin(transferId: string, peer: string): void {
    const out = this.outgoing.get(transferId);
    if (!out || out.sent.has(peer)) return;
    out.waiting.delete(peer);
    out.sending.add(peer);
  }

  /** `peer` left: it no longer waits for or gets anything of ours. Returns our files that are
   * over now (forgotten), in transfer id order. */
  peerGone(peer: string): Array<[string, Ended]> {
    const over: Array<[string, Ended]> = [];
    for (const [transferId, out] of this.outgoing) {
      const was = out.waiting.delete(peer);
      const was2 = out.sending.delete(peer);
      if (!was && !was2) continue;
      const ended = endedOf(out);
      if (ended) over.push([transferId, ended]);
    }
    over.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [transferId] of over) this.outgoing.delete(transferId);
    return over;
  }

  /** Sent, received, or cancelled here: forget it. */
  finish(transferId: string): void {
    this.outgoing.delete(transferId);
    this.incoming.delete(transferId);
  }

  /** Left the room: forget everything. */
  reset(): void {
    this.outgoing.clear();
    this.incoming.clear();
  }
}
