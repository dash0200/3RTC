import { useState, useEffect, useRef } from 'react';
import { speakingActivity } from '../../utils/speakingActivity';

/**
 * Intelligent Dialogue Ducking (Phase 3 Innovation - Alphabet Benchmark):
 * When any peer speaks over loud video playback, smoothly lowers (ducks) media volume
 * by ~18 dB (target ~35% of set volume) with a 200ms smooth curve, returning to 100%
 * when speech ceases. Eliminates the need to manually pause or yell over movies.
 */
export function useAudioDucking(enabled = true) {
  const [duckingFactor, setDuckingFactor] = useState(1.0);
  const targetFactorRef = useRef(1.0);
  const currentFactorRef = useRef(1.0);
  const animFrameRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setDuckingFactor(1.0);
      return undefined;
    }

    const checkSpeaking = () => {
      const snap = speakingActivity.get();
      // True if any remote peer or local user is speaking
      const isSpeaking = Object.values(snap.peers).some((p) => p.isSpeaking) || snap.local.isSpeaking;
      const nextTarget = isSpeaking ? 0.35 : 1.0;

      if (nextTarget !== targetFactorRef.current) {
        targetFactorRef.current = nextTarget;

        const animate = () => {
          const diff = targetFactorRef.current - currentFactorRef.current;
          if (Math.abs(diff) < 0.02) {
            currentFactorRef.current = targetFactorRef.current;
            setDuckingFactor(targetFactorRef.current);
            return;
          }
          // Smooth transition rate: ~200ms ducking, ~350ms restore
          const step = diff > 0 ? 0.08 : 0.15;
          currentFactorRef.current += diff * step;
          setDuckingFactor(+currentFactorRef.current.toFixed(3));
          animFrameRef.current = requestAnimationFrame(animate);
        };

        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = requestAnimationFrame(animate);
      }
    };

    const unsubscribe = speakingActivity.subscribe(checkSpeaking);
    return () => {
      unsubscribe();
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [enabled]);

  return duckingFactor;
}
