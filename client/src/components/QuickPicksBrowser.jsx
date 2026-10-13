import React, { useMemo, useState } from 'react';
import { groupQuickPicks, isVideoUnavailable, useQuickPicks, youtubeThumb } from '../utils/quickPicks';

/**
 * Desktop quick picks: group tabs (Trending, Music, Watch, Relax), the categories in the chosen
 * group, and that category's videos as a thumbnail grid. Clicking a video plays it for everyone
 * (cardAction 'play') or adds it to the queue (cardAction 'queue', used while something plays);
 * each card's Queue button adds it to the shared queue without starting it, and "Play queue"
 * starts the lined-up videos. "Shuffle" plays a random one from the category.
 */
export default function QuickPicksBrowser({ onPlay, onQueue, onShuffle, queuedIds = [], onPlayQueue, queueCount = 0, cardAction = 'play' }) {
  const queued = useMemo(() => new Set(queuedIds), [queuedIds]);
  const quickPicks = useQuickPicks();
  const groups = useMemo(() => groupQuickPicks(quickPicks), [quickPicks]);
  const [groupName, setGroupName] = useState(null);
  const [categoryId, setCategoryId] = useState(null);

  const group = groups.find((g) => g.group === groupName) || groups[0];
  const category = group?.categories.find((c) => c.id === categoryId) || group?.categories[0];
  const videos = (category?.videos || []).filter((v) => !isVideoUnavailable(v.id));
  if (!group) return null;

  return (
    <section className="qp-browser" aria-label="Quick picks">
      <div className="qp-head">
        <span className="qp-label">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="#f59e0b" aria-hidden="true"><path d="M7 2v11h3v9l7-12h-4l4-8z" /></svg>
          Quick Watch
        </span>
        {onPlayQueue && queueCount > 0 && (
          <button type="button" className="qp-play-queue" onClick={onPlayQueue} title="Start the videos you lined up">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            Play queue ({queueCount})
          </button>
        )}
        {groups.length > 1 && (
          <div className="qp-groups" role="tablist" aria-label="Quick pick groups">
            {groups.map((g) => (
              <button
                key={g.group}
                type="button"
                role="tab"
                aria-selected={g === group}
                className={`qp-group ${g === group ? 'active' : ''}`}
                onClick={() => { setGroupName(g.group); setCategoryId(null); }}
              >
                {g.group}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="qp-chips">
        {group.categories.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`qp-chip ${c === category ? 'active' : ''}`}
            aria-pressed={c === category}
            onClick={() => setCategoryId(c.id)}
          >
            {c.name}
          </button>
        ))}
        {videos.length > 1 && onShuffle && (
          <button type="button" className="qp-chip qp-shuffle" onClick={() => onShuffle(category)} title="Play a random video from this category">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" /></svg>
            Shuffle
          </button>
        )}
      </div>

      <div className="qp-grid">
        {videos.map((v) => (
          <div key={v.id} className={`qp-card ${queued.has(v.id) ? 'is-queued' : ''}`}>
            <button
              type="button"
              className="qp-card-play"
              onClick={() => (cardAction === 'queue' ? (!queued.has(v.id) && onQueue?.(v)) : onPlay?.(v))}
              title={cardAction === 'queue' ? `Add "${v.title}" to the queue` : `Play "${v.title}" for everyone`}
            >
              <span className="qp-thumb">
                <img src={youtubeThumb(v.id)} alt="" loading="lazy" width="320" height="180" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                <span className="qp-thumb-play" aria-hidden="true">
                  {cardAction === 'queue' ? (
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
                  )}
                </span>
              </span>
              <span className="qp-title">{v.title}</span>
              {v.channel && <span className="qp-channel">{v.channel}</span>}
            </button>
            {onQueue && (
              <button
                type="button"
                className="qp-queue"
                onClick={() => !queued.has(v.id) && onQueue(v)}
                disabled={queued.has(v.id)}
                aria-label={queued.has(v.id) ? `"${v.title}" is in the queue` : `Add "${v.title}" to queue`}
                title={queued.has(v.id) ? 'Already in the queue' : 'Add to queue (doesn\u2019t start it)'}
              >
                {queued.has(v.id) ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M14 10H3v2h11v-2zm0-4H3v2h11V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM3 16h7v-2H3v2z" /></svg>
                )}
                {queued.has(v.id) ? 'Queued' : 'Queue'}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
