/**
 * WebRTC Screen Sharing Feature Hook.
 * Manages local and remote screen sharing streams, signaling via roomBus,
 * and seamless track replacement across active peer connections.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';
import type { RoomBus } from '../../types';

export interface ScreenSharer {
  peerId?: string | null;
  username: string;
  hasAudio: boolean;
}

export interface UseScreenShareOptions {
  localUser?: {
    peerId?: string | null;
    username?: string | null;
  } | null;
}

export interface RemoteStreamEntry {
  stream: MediaStream;
  track?: MediaStreamTrack;
}

export interface UseScreenShareReturn {
  isSharingScreen: boolean;
  localScreenStream: MediaStream | null;
  remoteScreenStream: MediaStream | null;
  activeStream: MediaStream | null;
  screenSharer: ScreenSharer | null;
  hasAudio: boolean;
  isDismissed: boolean;
  isScreenShareActive: boolean;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => void;
  dismissScreenShare: () => void;
  resumeScreenShare: () => void;
  toggleScreenShare: () => void;
}

export function useScreenShare(
  bus: RoomBus | null | undefined,
  { localUser }: UseScreenShareOptions = {}
): UseScreenShareReturn {
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const [screenSharer, setScreenSharer] = useState<ScreenSharer | null>(null); // { peerId, username, hasAudio } or null
  const [isDismissed, setIsDismissed] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);

  const localStreamRef = useRef<MediaStream | null>(null);
  const isSharingRef = useRef(false);
  isSharingRef.current = isSharingScreen;

  const remoteStreamsRef = useRef<Map<string, RemoteStreamEntry>>(new Map()); // peerId -> { stream, track }
  const screenSharerRef = useRef<ScreenSharer | null>(null);
  screenSharerRef.current = screenSharer;

  const stopScreenShare = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      localStreamRef.current = null;
    }

    setLocalScreenStream(null);
    setIsSharingScreen(false);
    setHasAudio(false);
    setScreenSharer((prev) => (prev?.peerId === localUser?.peerId ? null : prev));

    // Signal peers to clear video track
    bus?.emitEvent('set-screen-track', null);
    bus?.broadcast('screen-share-status', {
      isSharing: false,
      peerId: localUser?.peerId
    });
  }, [bus, localUser?.peerId]);

  const startScreenShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported by your browser or environment.');
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          frameRate: { ideal: 30, max: 60 }
        } as MediaTrackConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = stream;
      setLocalScreenStream(stream);
      setIsSharingScreen(true);
      setIsDismissed(false);
      const audioTrack = stream.getAudioTracks()[0];
      setHasAudio(Boolean(audioTrack));

      const sharerInfo: ScreenSharer = {
        peerId: localUser?.peerId,
        username: localUser?.username || 'You',
        hasAudio: Boolean(audioTrack)
      };
      setScreenSharer(sharerInfo);

      // Replaces track in all active RTCPeerConnection video transceivers
      bus?.emitEvent('set-screen-track', videoTrack);

      // Notify all peers in the room
      bus?.broadcast('screen-share-status', {
        isSharing: true,
        ...sharerInfo
      });

      // Native browser "Stop sharing" floating bar clicked
      videoTrack.onended = () => {
        stopScreenShare();
      };
    } catch (err: unknown) {
      if (!(err instanceof Error) || err.name !== 'NotAllowedError') {
        console.error('[ScreenShare] Error starting screen share:', err);
        throw err;
      }
    }
  }, [bus, localUser?.peerId, localUser?.username, stopScreenShare]);

  const dismissScreenShare = useCallback(() => {
    setIsDismissed(true);
  }, []);

  const resumeScreenShare = useCallback(() => {
    setIsDismissed(false);
  }, []);

  const toggleScreenShare = useCallback(() => {
    if (isSharingScreen) {
      stopScreenShare();
    } else if (screenSharer && isDismissed) {
      resumeScreenShare();
    } else if (screenSharer && !isDismissed) {
      dismissScreenShare();
    } else {
      startScreenShare();
    }
  }, [
    isSharingScreen,
    screenSharer,
    isDismissed,
    resumeScreenShare,
    dismissScreenShare,
    startScreenShare,
    stopScreenShare
  ]);

  // Handle incoming remote screen stream from WebRTC ontrack
  useEffect(() => {
    if (!bus) return;

    // When a remote video track arrives:
    const offStream = bus.onEvent<{ peerId: string; stream: MediaStream; track?: MediaStreamTrack }>(
      'remote-screen-stream',
      ({ peerId, stream, track }) => {
        remoteStreamsRef.current.set(peerId, { stream, track });

        // CRITICAL FIX: Only attach if this peer is ALREADY verified as sharing by screen-share-status!
        // Never assume a peer is sharing just because WebRTC negotiated a video transceiver!
        if (screenSharerRef.current?.peerId === peerId) {
          setRemoteScreenStream(stream);
          setHasAudio(stream.getAudioTracks().length > 0);
        }
      }
    );

    const offStreamEnded = bus.onEvent<{ peerId: string }>(
      'remote-screen-stream-ended',
      ({ peerId }) => {
        remoteStreamsRef.current.delete(peerId);
        if (screenSharerRef.current?.peerId === peerId) {
          setRemoteScreenStream(null);
          setScreenSharer(null);
        }
      }
    );

    const offPeerClose = bus.onEvent<string>('peer-close', (peerId) => {
      remoteStreamsRef.current.delete(peerId);
      if (screenSharerRef.current?.peerId === peerId) {
        setRemoteScreenStream(null);
        setScreenSharer(null);
      }
    });

    const offRoomLeft = bus.onEvent('room-left', () => {
      stopScreenShare();
      setRemoteScreenStream(null);
      setScreenSharer(null);
      setIsDismissed(false);
      remoteStreamsRef.current.clear();
    });

    // Catch newcomers up if we are currently sharing
    const offPeerOpen = bus.onEvent<string>('peer-open', (peerId) => {
      if (isSharingRef.current && localUser?.peerId) {
        bus.send(peerId, 'screen-share-status', {
          isSharing: true,
          peerId: localUser.peerId,
          username: localUser.username || 'Host',
          hasAudio: Boolean(localStreamRef.current?.getAudioTracks()?.length)
        });
      }
    });

    return () => {
      offStream();
      offStreamEnded();
      offPeerClose();
      offRoomLeft();
      offPeerOpen();
    };
  }, [bus, localUser?.peerId, localUser?.username, stopScreenShare]);

  // Listen for room-wide screen share status changes from peers
  usePeerMessageOn<{
    isSharing?: boolean;
    peerId?: string;
    username?: string;
    hasAudio?: boolean;
  }>(bus ?? ({ on: () => () => {} } as unknown as RoomBus), 'screen-share-status', (data) => {
    if (data?.isSharing) {
      const sharerInfo: ScreenSharer = {
        peerId: data.peerId,
        username: data.username || 'Peer',
        hasAudio: Boolean(data.hasAudio)
      };
      setScreenSharer(sharerInfo);
      setIsDismissed(false);

      // If we already received their media stream, attach it immediately
      const entry = remoteStreamsRef.current.get(data.peerId || '');
      if (entry?.stream) {
        setRemoteScreenStream(entry.stream);
        setHasAudio(entry.stream.getAudioTracks().length > 0 || Boolean(data.hasAudio));
      }
    } else if (screenSharer?.peerId === data?.peerId || !data?.isSharing) {
      if (screenSharer?.peerId === data?.peerId) {
        setScreenSharer(null);
        setRemoteScreenStream(null);
        setIsDismissed(false);
      }
    }
  });

  const activeStream = isSharingScreen ? localScreenStream : remoteScreenStream;
  // CRITICAL: isScreenShareActive is true ONLY if someone is actually sharing AND not dismissed
  const isScreenShareActive = isSharingScreen
    ? Boolean(localScreenStream)
    : Boolean(screenSharer && !isDismissed);

  return {
    isSharingScreen,
    localScreenStream,
    remoteScreenStream,
    activeStream,
    screenSharer,
    hasAudio,
    isDismissed,
    isScreenShareActive,
    startScreenShare,
    stopScreenShare,
    dismissScreenShare,
    resumeScreenShare,
    toggleScreenShare
  };
}
