import { useMemo, useState, useEffect, useRef } from 'react';

export interface ReactionHeatmapItem {
  id?: string;
  emoji: string;
  mediaTime?: number;
}

export interface ReactionFeed {
  subscribe: (callback: (item: ReactionHeatmapItem) => void) => (() => void) | void;
}

export interface ScrubberReactionHeatmapProps {
  durationSec: number;
  currentTimeSec?: number;
  reactions?: ReactionHeatmapItem[] | ReactionFeed | null;
  feed?: ReactionHeatmapItem[] | ReactionFeed | null;
}

interface ReactionCluster {
  id: string;
  mediaTime: number;
  percent: number;
  items: ReactionHeatmapItem[];
  emojis: string[];
}

function isReactionFeed(target: unknown): target is ReactionFeed {
  return typeof target === 'object' && target !== null && 'subscribe' in target && typeof (target as { subscribe: unknown }).subscribe === 'function';
}

/**
 * Synchronized Reaction Heatmap on Scrubber (Phase 3 Innovation - Alphabet Benchmark):
 * Visualizes shared laughter, surprise, and crowd reactions along the media timeline.
 * Plots reaction clusters along the scrubber, turning the progress bar into a social memory lane.
 */
export default function ScrubberReactionHeatmap({
  durationSec,
  currentTimeSec = 0,
  reactions = [],
  feed = null
}: ScrubberReactionHeatmapProps) {
  const [liveReactions, setLiveReactions] = useState<ReactionHeatmapItem[]>([]);
  const currentTimeRef = useRef(currentTimeSec);
  currentTimeRef.current = currentTimeSec;

  // Subscribe to reaction feed if reactions is a feed object or feed prop is provided
  useEffect(() => {
    const targetFeed: ReactionFeed | null = isReactionFeed(reactions)
      ? reactions
      : isReactionFeed(feed)
      ? feed
      : null;

    if (!targetFeed) return;

    const unsubscribe = targetFeed.subscribe((item) => {
      if (!item || !item.emoji) return;
      const mediaTime = typeof item.mediaTime === 'number'
        ? item.mediaTime
        : currentTimeRef.current;

      if (typeof mediaTime === 'number' && mediaTime >= 0) {
        setLiveReactions((prev) => [
          ...prev.slice(-300), // keep latest 300
          {
            id: item.id || `heat-${Date.now()}-${Math.random()}`,
            emoji: item.emoji,
            mediaTime
          }
        ]);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch { }
      }
    };
  }, [reactions, feed]);

  // Combine static reaction list (if array passed) and live reaction items from feed
  const allReactions = useMemo(() => {
    const baseList: ReactionHeatmapItem[] = Array.isArray(reactions) ? reactions : Array.isArray(feed) ? feed : [];
    if (liveReactions.length === 0) return baseList;
    return [...baseList, ...liveReactions];
  }, [reactions, feed, liveReactions]);

  // Cluster reactions within 5-second windows
  const clusters = useMemo(() => {
    if (!durationSec || durationSec <= 0 || !Array.isArray(allReactions) || allReactions.length === 0) {
      return [];
    }

    const validReactions = allReactions.filter(
      (r): r is ReactionHeatmapItem & { mediaTime: number } =>
        Boolean(r && typeof r.mediaTime === 'number' && r.mediaTime >= 0)
    );
    if (validReactions.length === 0) return [];

    const grouped: ReactionCluster[] = [];
    const sorted = [...validReactions].sort((a, b) => a.mediaTime - b.mediaTime);

    for (const r of sorted) {
      const last = grouped[grouped.length - 1];
      if (last && Math.abs(r.mediaTime - last.mediaTime) <= 5) {
        last.items.push(r);
        // Dominant emoji
        if (!last.emojis.includes(r.emoji)) last.emojis.push(r.emoji);
      } else {
        grouped.push({
          id: `cluster-${r.mediaTime}-${grouped.length}`,
          mediaTime: r.mediaTime,
          percent: Math.min(100, Math.max(0, (r.mediaTime / durationSec) * 100)),
          items: [r],
          emojis: [r.emoji]
        });
      }
    }
    return grouped;
  }, [durationSec, allReactions]);

  if (clusters.length === 0) return null;

  return (
    <div className="scrubber-heatmap-layer" aria-hidden="true">
      {clusters.map((c) => {
        const isPassed = currentTimeSec >= c.mediaTime;
        const count = c.items.length;
        const dominant = c.emojis[0] || '🔥';

        return (
          <div
            key={c.id}
            className={`scrubber-heat-dot ${isPassed ? 'is-passed' : ''}`}
            style={{ left: `${c.percent}%` }}
            title={`${count} reaction${count > 1 ? 's' : ''} at ${Math.floor(c.mediaTime / 60)}:${Math.floor(c.mediaTime % 60).toString().padStart(2, '0')}`}
          >
            <span className="heat-dot-glow" />
            <span className="heat-dot-emoji">{dominant}</span>
            {count > 1 && <span className="heat-dot-badge">+{count}</span>}
          </div>
        );
      })}
    </div>
  );
}
