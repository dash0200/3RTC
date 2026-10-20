import { useMemo, useState } from 'react';
import {
  groupQuickPicks,
  isVideoUnavailable,
  useQuickPicks,
  youtubeThumb,
  type QuickPickVideo,
  type QuickPickCategory
} from '../utils/quickPicks';
import TrendingRegionSelect from './TrendingRegionSelect';

export interface QuickPicksBrowserProps {
  onPlay?: (video: QuickPickVideo) => void;
  onQueue?: (video: QuickPickVideo) => void;
  onShuffle?: (category: QuickPickCategory) => void;
  queuedIds?: string[];
  onPlayQueue?: () => void;
  queueCount?: number;
  cardAction?: 'play' | 'queue';
}

/** 1:02:31 / 58:40 for the thumbnail badge. */
function formatLength(total: number) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Desktop quick picks: group tabs (Trending, Music, Watch, Relax), the categories in the chosen
 * group, and that category's videos as a thumbnail grid. Clicking a video plays it for everyone
 * (cardAction 'play') or adds it to the queue (cardAction 'queue', used while something plays);
 * each card's Queue button adds it to the shared queue without starting it, and "Play queue"
 * starts the lined-up videos. "Shuffle" plays a random one from the category.
 */
export default function QuickPicksBrowser({
  onPlay,
  onQueue,
  onShuffle,
  queuedIds = [],
  onPlayQueue,
  queueCount = 0,
  cardAction = 'play'
}: QuickPicksBrowserProps) {
  const queued = useMemo(() => new Set(queuedIds), [queuedIds]);
  const quickPicks = useQuickPicks();
  const groups = useMemo(() => groupQuickPicks(quickPicks), [quickPicks]);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const group = groups.find((g) => g.group === groupName) || groups[0];
  const category = group?.categories.find((c) => c.id === categoryId) || group?.categories[0];
  const videos = (category?.videos || []).filter((v) => !isVideoUnavailable(v.id));
  if (!group) return null;

  return (
    <section className="qp-browser" aria-label="Quick picks">
      <div className="qp-head">
        <h2 className="qp-label">Quick picks</h2>
        <div className="qp-head-end">
          {onPlayQueue && queueCount > 0 && (
            <button
              type="button"
              className="qp-play-queue"
              onClick={onPlayQueue}
              title="Start the videos you lined up"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play queue ({queueCount})
            </button>
          )}
          {group.group === 'Trending' && <TrendingRegionSelect />}
          {groups.length > 1 && (
            <div className="qp-groups" role="tablist" aria-label="Quick pick mood">
              {groups.map((g) => (
                <button
                  key={g.group}
                  type="button"
                  role="tab"
                  aria-selected={g === group}
                  className={`qp-group ${g === group ? 'active' : ''}`}
                  onClick={() => {
                    setGroupName(g.group);
                    setCategoryId(null);
                  }}
                >
                  {g.group}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {(group.categories.length > 1 || (videos.length > 1 && onShuffle)) && (
        <div className="qp-chips">
          {group.categories.length > 1 &&
            group.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`qp-chip ${c === category ? 'active' : ''}`}
                aria-pressed={c === category}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name.replace(/^[^\p{L}\p{N}]+/u, '')}
              </button>
            ))}
          {videos.length > 1 && onShuffle && category && (
            <button
              type="button"
              className="qp-chip qp-shuffle"
              onClick={() => onShuffle(category)}
              title="Play a random video from this category"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </svg>
              Shuffle
            </button>
          )}
        </div>
      )}

      <div className="qp-grid">
        {videos.map((v) => (
          <article key={v.id} className={`qp-card ${queued.has(v.id) ? 'is-queued' : ''}`}>
            <button
              type="button"
              className="qp-card-play"
              onClick={() =>
                cardAction === 'queue'
                  ? !queued.has(v.id) && onQueue?.(v)
                  : onPlay?.(v)
              }
              title={
                cardAction === 'queue'
                  ? `Add "${v.title}" to the queue`
                  : `Play "${v.title}" for everyone`
              }
            >
              <span className="qp-thumb">
                <img
                  src={youtubeThumb(v.id)}
                  alt=""
                  loading="lazy"
                  width="320"
                  height="180"
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
                {(v.live || v.seconds) && (
                  <span className={`qp-length ${v.live ? 'is-live' : ''}`}>
                    {v.live ? 'LIVE' : formatLength(v.seconds || 0)}
                  </span>
                )}
                <span className="qp-thumb-play" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </span>
            </button>
            <div className="qp-meta">
              <div className="qp-text">
                <h3 className="qp-title">{v.title}</h3>
                {v.channel && <p className="qp-channel">{v.channel}</p>}
              </div>
              {onQueue && (
                <button
                  type="button"
                  className="qp-queue"
                  onClick={() => !queued.has(v.id) && onQueue(v)}
                  disabled={queued.has(v.id)}
                  aria-label={
                    queued.has(v.id) ? `"${v.title}" is in the queue` : `Add "${v.title}" to queue`
                  }
                  title={queued.has(v.id) ? 'In the queue' : 'Add to queue'}
                >
                  {queued.has(v.id) ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12l5 5 9-10" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
