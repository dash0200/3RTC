import { memo, useEffect, useState } from 'react';
import { getLinkPreview, type LinkPreviewData } from './linkPreviewClient';

/**
 * A card under a chat message with a link: the page's site, title, description and picture
 * (features/chat/linkPreviewClient). Nothing shows until (or unless) the preview arrives.
 */
function LinkPreviewImpl({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getLinkPreview(url).then((p) => {
      if (alive) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!preview) return null;
  return (
    <a className="chat-link-preview" href={url} target="_blank" rel="noopener noreferrer nofollow" title={url}>
      {preview.image && !imageFailed && (
        <img
          className="chat-link-preview-img"
          src={preview.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      )}
      <span className="chat-link-preview-body">
        {preview.siteName && <span className="chat-link-preview-site">{preview.siteName}</span>}
        <span className="chat-link-preview-title">{preview.title}</span>
        {preview.description && <span className="chat-link-preview-desc">{preview.description}</span>}
      </span>
    </a>
  );
}

export const LinkPreview = memo(LinkPreviewImpl);
