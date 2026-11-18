/**
 * A folder offered in chat (`p2p-folder-offer`, sent by the desktop app): its files, each
 * downloaded only when this person asks for it (`p2p-file-control` `accept`). Checked the way
 * the desktop app checks it (`clean_folder` in desktop/crates/core/src/room.rs).
 */

/** Most files taken from a folder offer. */
export const FOLDER_MAX_FILES = 1000;
const MAX_SEND_BYTES = 10 * 1024 * 1024 * 1024;

export interface FolderOfferFile {
  transferId: string;
  /** Its path inside the folder, the folder's name first (`Photos/2026/a.jpg`). */
  path: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface FolderOffer {
  folderId: string;
  name: string;
  files: FolderOfferFile[];
}

const okId = (id: unknown): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= 64;

/** A folder path from a peer, made safe: no `..`, no empty or dot parts, `/` between parts. */
export function cleanFolderPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  const parts = raw
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.' && p !== '..')
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '_'));
  return parts.length ? parts.join('/') : null;
}

/** A `p2p-folder-offer` from a peer, checked; null when nothing usable is left. */
export function cleanFolderOffer(msg: Record<string, unknown>): FolderOffer | null {
  const folderId = msg.folderId;
  if (!okId(folderId)) return null;
  const raw = Array.isArray(msg.files) ? msg.files : [];
  const files: FolderOfferFile[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (files.length >= FOLDER_MAX_FILES) break;
    if (!f || typeof f !== 'object') continue;
    const e = f as Record<string, unknown>;
    if (!okId(e.transferId) || e.transferId === folderId || seen.has(e.transferId)) continue;
    const path = cleanFolderPath(e.path);
    if (!path) continue;
    const size = Number(e.fileSize);
    seen.add(e.transferId);
    files.push({
      transferId: e.transferId,
      path,
      fileName: path.split('/').pop() || 'file',
      fileSize: Number.isFinite(size) && size > 0 && size <= MAX_SEND_BYTES ? size : 0,
      mimeType: typeof e.mimeType === 'string' && e.mimeType ? e.mimeType.slice(0, 100) : 'application/octet-stream'
    });
  }
  if (!files.length) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const name =
    typeof msg.name === 'string' && msg.name.trim() ? msg.name.slice(0, 120) : files[0].path.split('/')[0] || 'folder';
  return { folderId, name, files };
}

/** One row of a folder's tree: a folder level as it starts, or a file. */
export type FolderRow =
  | { kind: 'dir'; name: string; depth: number }
  | { kind: 'file'; file: FolderOfferFile; depth: number };

/** The rows of a folder's tree, in path order (folders before their files, indented). */
export function folderRows(files: FolderOfferFile[]): FolderRow[] {
  const rows: FolderRow[] = [];
  let open: string[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    const dirs = parts.slice(0, -1);
    let same = 0;
    while (same < open.length && same < dirs.length && open[same] === dirs[same]) same++;
    open = open.slice(0, same);
    for (let d = same; d < dirs.length; d++) {
      open.push(dirs[d]);
      rows.push({ kind: 'dir', name: dirs[d], depth: d });
    }
    rows.push({ kind: 'file', file, depth: dirs.length });
  }
  return rows;
}
