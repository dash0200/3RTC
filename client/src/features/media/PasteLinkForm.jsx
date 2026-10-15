/**
 * A compact "paste any link" box: Load (play for everyone) or + Queue. Used in the link player's
 * bar so the next video can be pasted while one plays (the YouTube player has its own).
 */
import { useState } from 'react';
import { resolvePastedLink } from './resolveLink';

export default function PasteLinkForm({ onPlayLink, onPlayYouTube, onQueueLink, onQueueYouTube }) {
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const go = async (mode) => {
        if (!text.trim() || busy) return;
        setBusy(true);
        try {
            const res = await resolvePastedLink(text);
            if (res.error) {
                setError(res.error);
                return;
            }
            setError('');
            setText('');
            if (res.kind === 'media') (mode === 'queue' ? onQueueLink : onPlayLink)?.(res.media);
            else (mode === 'queue' ? onQueueYouTube : onPlayYouTube)?.(res.videoId, res.title);
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="paste-link-form" onSubmit={(e) => { e.preventDefault(); go('play'); }}>
            <input
                type="text"
                className="paste-link-input"
                placeholder="Paste a new link…"
                aria-label="Paste a new video link"
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(''); }}
            />
            <button type="submit" className="link-player-btn" disabled={busy || !text.trim()}>{busy ? '…' : 'Load'}</button>
            {(onQueueLink || onQueueYouTube) && (
                <button type="button" className="link-player-btn" disabled={busy || !text.trim()} onClick={() => go('queue')}>+ Queue</button>
            )}
            {error && <div className="paste-link-error" role="alert">{error}</div>}
        </form>
    );
}
