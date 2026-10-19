/**
 * Global ambient declarations for browser APIs and external player SDKs.
 * Eliminates need for `as any` casts across media, audio, and device components.
 */

export {};

declare global {
  interface AudioTrack {
    id: string;
    kind: string;
    label: string;
    language: string;
    enabled: boolean;
  }

  interface AudioTrackList {
    readonly length: number;
    [index: number]: AudioTrack;
    [Symbol.iterator](): IterableIterator<AudioTrack>;
  }

  interface HTMLMediaElement {
    setSinkId?(sinkId: string): Promise<void>;
    sinkId?: string;
    playsInline?: boolean;
  }

  interface Document {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?(): Promise<void>;
    mozFullScreenElement?: Element | null;
    msFullscreenElement?: Element | null;
  }

  interface Element {
    webkitRequestFullscreen?(): Promise<void>;
  }

  interface HTMLVideoElement {
    webkitDisplayingFullscreen?: boolean;
    webkitEnterFullscreen?(): void;
    webkitExitFullscreen?(): void;
    audioTracks?: AudioTrackList;
  }

  interface MediaDevices {
    selectAudioOutput?(): Promise<MediaDeviceInfo>;
  }

  interface WakeLockSentinel extends EventTarget {
    released: boolean;
    type: 'screen';
    release(): Promise<void>;
    onrelease: ((this: WakeLockSentinel, ev: Event) => void) | null;
  }

  interface WakeLock {
    request(type: 'screen'): Promise<WakeLockSentinel>;
  }

  interface MediaMetadataInit {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: readonly { src: string; sizes?: string; type?: string }[];
  }

  interface MediaMetadata {
    title: string;
    artist: string;
    album: string;
    artwork: readonly { src: string; sizes?: string; type?: string }[];
  }

  var MediaMetadata: {
    prototype: MediaMetadata;
    new (init?: MediaMetadataInit): MediaMetadata;
  };

  interface MediaSessionActionDetails {
    action: string;
    seekOffset?: number;
    seekTime?: number;
    fastSeek?: boolean;
  }

  interface MediaSession {
    metadata: MediaMetadata | null;
    playbackState: 'none' | 'paused' | 'playing';
    setActionHandler(action: string, handler: ((details: MediaSessionActionDetails) => void) | null): void;
    setPositionState?(state?: { duration?: number; playbackRate?: number; position?: number }): void;
  }

  interface Navigator {
    wakeLock?: WakeLock;
    mediaSession?: MediaSession;
  }

  namespace Intl {
    interface SegmenterOptions {
      granularity?: 'grapheme' | 'word' | 'sentence';
    }
    interface SegmentData {
      segment: string;
      index: number;
      input: string;
    }
    interface Segments {
      [Symbol.iterator](): IterableIterator<SegmentData>;
      containing(index: number): SegmentData;
    }
    interface Segmenter {
      segment(input: string): Segments;
    }
    var Segmenter: {
      prototype: Segmenter;
      new (locales?: string | string[], options?: SegmenterOptions): Segmenter;
    };
  }

  interface AudioContext {
    setSinkId?(sinkId: string): Promise<void>;
    sinkId?: string;
  }

  interface YTPlayerTarget {
    getDuration?(): number;
    getVolume?(): number;
    isMuted?(): boolean;
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead?: boolean): void;
    getCurrentTime?(): number;
    getPlayerState?(): number;
    loadVideoById?(videoId: string): void;
    destroy?(): void;
    [key: string]: unknown;
  }

  interface Window {
    __RTC_ICE_SERVERS__?: RTCIceServer[];
    __webrtcAudioCtx?: AudioContext;
    webkitAudioContext?: typeof AudioContext;
    MediaMetadata?: typeof MediaMetadata;
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        options: {
          videoId?: string;
          playerVars?: Record<string, unknown>;
          events?: {
            onReady?: (event: { target: YTPlayerTarget }) => void;
            onStateChange?: (event: { data: number }) => void;
            onError?: (event: { data: number }) => void;
          };
        }
      ) => YTPlayerTarget;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    Vimeo?: {
      Player: new (
        element: string | HTMLElement,
        options?: Record<string, unknown>
      ) => unknown;
    };
    Twitch?: {
      Player: new (
        element: string | HTMLElement,
        options?: Record<string, unknown>
      ) => unknown;
    };
  }

  interface RTCRtpEncodingParameters {
    networkPriority?: 'very-low' | 'low' | 'medium' | 'high';
  }
}
