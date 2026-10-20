/**
 * Media link sources and Queue item types.
 * Derives from docs/PROTOCOL.md and features/media/sources.js.
 */

export type MediaProvider = 'vimeo' | 'twitch' | 'file' | 'hls';

export interface BaseMedia {
  provider: MediaProvider;
  url: string;
  title?: string;
}

export interface VimeoMedia extends BaseMedia {
  provider: 'vimeo';
  id?: string;
}

export interface TwitchMedia extends BaseMedia {
  provider: 'twitch';
  video?: string;
  channel?: string;
  live?: boolean;
}

export interface FileMedia extends BaseMedia {
  provider: 'file';
}

export interface HlsMedia extends BaseMedia {
  provider: 'hls';
}

export type MediaItem = VimeoMedia | TwitchMedia | FileMedia | HlsMedia;

export interface QueueItem {
  id: string;
  videoId?: string;
  media?: MediaItem;
  title: string;
  addedBy: string;
  timestamp: number;
}

export type DetectLinkResult =
  | { ok: true; kind: 'youtube'; videoId: string }
  | { ok: true; kind: 'media'; media: MediaItem; guessed?: boolean }
  | { ok: false; message: string };

