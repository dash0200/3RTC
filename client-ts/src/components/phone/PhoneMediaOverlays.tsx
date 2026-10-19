import { useRef } from 'react';
import FileFormatNotice from '../../features/files/FileFormatNotice';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

export interface PhoneEmptyMediaProps {
  onAddVideo?: () => void;
}

/** Phone video area when nothing is playing. */
export function PhoneEmptyMedia({ onAddVideo }: PhoneEmptyMediaProps) {
  return (
    <div className="phone-media-overlay">
      <span className="phone-media-icon" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
        </svg>
      </span>
      <div className="phone-media-title">Nothing playing yet</div>
      <div className="phone-media-sub">Paste a video link (YouTube, Vimeo, Twitch…) or pick one from your phone.</div>
      <button type="button" className="phone-btn phone-btn-primary phone-btn-sm" onClick={onAddVideo}>
        Add video
      </button>
    </div>
  );
}

export interface PhoneStreamOfferProps {
  meta?: any;
  streamProgress?: any;
  onRequestStream?: () => void;
  onCancelStream?: () => void;
  onPickFile?: (file: File) => void;
  fileFormat?: any;
}

/**
 * Phone video area when a peer loaded a local video file: stream it from them, or use your own
 * copy of the same file.
 */
export function PhoneStreamOffer({
  meta,
  streamProgress,
  onRequestStream,
  onCancelStream,
  onPickFile,
  fileFormat = null
}: PhoneStreamOfferProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sender = meta?.sender || 'A peer';
  const isRequesting = Boolean(streamProgress);

  return (
    <div className="phone-media-overlay phone-stream-offer">
      <div className="phone-offer-head">
        <span className="phone-offer-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" />
          </svg>
        </span>
        <div className="phone-offer-text">
          <span className="phone-offer-kicker">{sender} is playing</span>
          <span className="phone-offer-name" title={meta?.fileName}>{meta?.fileName || 'a video'}</span>
          {meta?.fileSize > 0 && <span className="phone-offer-size">{formatSize(meta.fileSize)}</span>}
        </div>
      </div>
      {fileFormat && <FileFormatNotice info={fileFormat} hasSubtitles compact />}
      <div className="phone-offer-actions">
        {isRequesting ? (
          <button type="button" className="phone-btn phone-btn-ghost" onClick={onCancelStream}>
            Connecting to {sender}… Cancel
          </button>
        ) : (
          <button type="button" className="phone-btn phone-btn-primary" onClick={onRequestStream}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
            Stream from {sender}
          </button>
        )}
        <button type="button" className="phone-btn phone-btn-ghost phone-btn-sm" onClick={() => fileRef.current?.click()}>
          I have this file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,.mkv,.mp4,.webm,.mov,.m4v"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPickFile?.(file);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
