/**
 * Spatial Co-Presence Audio (Directional Voice - Phase 3 Alphabet Innovation):
 * Computes stereo panning (-0.8 to +0.8) based on peer avatar positions across the stage.
 * Solves the "Cocktail Party Effect" by separating multiple voices into distinct stereo channels.
 */

export type SpatialAudioListener = (peerId: string, pan: number) => void;

const peerPans = new Map<string, number>();
const listeners = new Set<SpatialAudioListener>();

export const spatialAudio = {
  getPan(peerId: string): number {
    return peerPans.get(peerId) ?? 0;
  },

  setPan(peerId: string, pan: number): void {
    const clamped = Math.max(-0.8, Math.min(0.8, pan));
    if (peerPans.get(peerId) === clamped) return;
    peerPans.set(peerId, clamped);
    for (const listener of listeners) {
      try {
        listener(peerId, clamped);
      } catch {
        /* ignore */
      }
    }
  },

  removePeer(peerId: string): void {
    peerPans.delete(peerId);
  },

  subscribe(listener: SpatialAudioListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * Calculates stereo pan based on avatar horizontal index in a peer list
   * @param index Index of the peer in the visible roster
   * @param total Total number of peers
   * @returns Pan between -0.75 (left) and +0.75 (right)
   */
  calculateRosterPan(index: number, total: number): number {
    if (total <= 1) return 0;
    // Map index 0..(total - 1) to -0.75..+0.75
    const ratio = index / (total - 1); // 0 to 1
    return +((ratio * 1.5 - 0.75).toFixed(2));
  }
};
