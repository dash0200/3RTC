/**
 * A folder offered in chat (`p2p-folder-offer`, sent by the desktop app): its card, and the window
 * with its tree where each file is downloaded on request (then saved from here).
 */

import { useEffect, useMemo, useState } from 'react';
import { formatFileSize } from '../../utils/p2pImageShare';
import { folderRows } from './folderOffer';
import type { ChatFolderFile, ChatMessageFolder } from './chatMessages';

export interface FolderOfferCardProps {
  folder: ChatMessageFolder;
  mine: boolean;
  sender: string;
  onAccept: (transferId: string) => void;
  onCancel: (transferId: string) => void;
}

export default function FolderOfferCard({ folder, mine, sender, onAccept, onCancel }: FolderOfferCardProps) {
  const [open, setOpen] = useState(false);
  const total = folder.files.reduce((a, f) => a + f.fileSize, 0);
  const count = folder.files.length;
  const here = folder.files.filter((f) => f.state === 'done').length;
  const moving = folder.files.filter((f) => f.state === 'receiving').length;
  const missing = folder.files.filter((f) => f.state === 'offered');
  const status = folder.isCancelled
    ? '✕ Cancelled'
    : moving > 0
      ? `Downloading ${moving} • ${here} of ${count} here`
      : here > 0
        ? `${here} of ${count} here`
        : 'Pick the files you want';
  const rows = useMemo(() => folderRows(folder.files), [folder.files]);
  const byId = useMemo(() => new Map(folder.files.map((f) => [f.transferId, f])), [folder.files]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const fileAction = (f: ChatFolderFile) => {
    switch (f.state) {
      case 'offered':
        return (
          <button type="button" className="transfer-action-btn is-accept" onClick={() => onAccept(f.transferId)}>
            ⬇ Download
          </button>
        );
      case 'receiving':
        return (
          <span className="folder-file-progress">
            {f.percent || 0}%
            <button
              type="button"
              className="transfer-action-btn is-cancel"
              onClick={() => onCancel(f.transferId)}
              title="Stop downloading this file"
            >
              ✕
            </button>
          </span>
        );
      case 'done':
        return f.file ? (
          <a className="transfer-action-btn" href={f.file.url} download={f.fileName} title={`Save ${f.fileName}`}>
            Save
          </a>
        ) : (
          <span className="folder-file-note">✓ Here</span>
        );
      default:
        return <span className="folder-file-note">Cancelled</span>;
    }
  };

  return (
    <div className="chat-image-transfer-card folder-offer-card">
      <div className="transfer-header">
        <span className="transfer-icon">📁</span>
        <div className="transfer-details">
          <span className="transfer-filename" title={folder.name}>
            {folder.name}
          </span>
          <span className="transfer-status">
            {count} file{count === 1 ? '' : 's'} • {formatFileSize(total)}
          </span>
          {!mine && <span className="transfer-status">{status}</span>}
        </div>
      </div>
      {!mine && !folder.isCancelled && (
        <div className="transfer-actions">
          <button type="button" className="transfer-action-btn is-accept" onClick={() => setOpen(true)}>
            Open
          </button>
        </div>
      )}

      {open && (
        <div className="folder-offer-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="folder-offer-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Folder ${folder.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="folder-offer-head">
              <span className="folder-offer-icon">📁</span>
              <div className="folder-offer-title">
                <strong title={folder.name}>{folder.name}</strong>
                <span>
                  {sender} • {count} file{count === 1 ? '' : 's'} • {formatFileSize(total)}
                </span>
              </div>
              {missing.length > 0 && !folder.isCancelled && (
                <button
                  type="button"
                  className="transfer-action-btn is-accept"
                  onClick={() => missing.forEach((f) => onAccept(f.transferId))}
                >
                  ⬇ Download all ({missing.length})
                </button>
              )}
              <button type="button" className="folder-offer-close" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="folder-offer-tree">
              {rows.map((row, i) =>
                row.kind === 'dir' ? (
                  <div
                    key={`d-${i}`}
                    className="folder-row is-dir"
                    style={{ paddingLeft: 8 + 18 * row.depth }}
                  >
                    📂 {row.name}
                  </div>
                ) : (
                  <div key={row.file.transferId} className="folder-row" style={{ paddingLeft: 8 + 18 * row.depth }}>
                    <span className="folder-row-name" title={row.file.path}>
                      📄 {row.file.fileName}
                    </span>
                    <span className="folder-row-size">{formatFileSize(row.file.fileSize)}</span>
                    {fileAction(byId.get(row.file.transferId) || { ...row.file, state: 'cancelled', percent: 0 })}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
