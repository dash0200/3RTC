/**
 * How loud a soundboard clip plays here, ours or someone else's: nothing when muted or at 0%,
 * else the soundboard volume. The desktop app's `sounds::clip_gain` is the same rule.
 */
export function soundboardGain(settings: { muted?: boolean; volume?: number } | null | undefined): number {
  if (!settings || settings.muted) return 0;
  const volume = settings.volume ?? 0.75;
  if (!(volume > 0)) return 0;
  return Math.min(1, volume);
}
