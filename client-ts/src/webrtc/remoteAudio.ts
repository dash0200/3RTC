import { routeMediaElement } from '../utils/audioDevices';

export interface PeerAudioEntry {
  audioElement?: HTMLAudioElement | null;
  screenAudioElement?: HTMLAudioElement | null;
  remoteVideoStream?: MediaStream | null;
  remoteScreenAudioStream?: MediaStream | null;
  webAudioSource?: MediaStreamAudioSourceNode | null;
  webAudioGain?: GainNode | null;
  analyserNode?: AnalyserNode | null;
  [key: string]: unknown;
}

export interface AttachRemoteAudioContext {
  targetPeerId: string;
  peerEntry: PeerAudioEntry;
  peerVolumesRef: { current: Record<string, number> };
  localMutedPeersRef: { current: Record<string, boolean> };
  isAudioBlockedRef: { current: boolean };
  logLocalDebug: (tag: string, detail: string) => void;
  onRemoteVideoStream?: (targetPeerId: string, stream: MediaStream, track: MediaStreamTrack) => void;
  onRemoteVideoStreamEnded?: (targetPeerId: string) => void;
  onRemoteScreenAudioStream?: (targetPeerId: string, stream: MediaStream, track: MediaStreamTrack) => void;
}

/**
 * Remote voice playback for one peer: when the peer's audio track arrives it is played through a
 * hidden <audio> element (the only speaker output) and tapped by an AnalyserNode for the speaking
 * ring / volume meter. Handles autoplay blocking and the track muting/unmuting.
 */
export function attachRemoteAudio(pc: RTCPeerConnection, ctx: AttachRemoteAudioContext): void {
  const {
    isAudioBlockedRef,
    localMutedPeersRef,
    logLocalDebug,
    peerEntry,
    peerVolumesRef,
    targetPeerId
  } = ctx;

  pc.ontrack = (event: RTCTrackEvent) => {
    if (event.track.kind === 'video') {
      const videoStream =
        event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      peerEntry.remoteVideoStream = videoStream;
      if (peerEntry.remoteScreenAudioStream) {
        for (const t of peerEntry.remoteScreenAudioStream.getAudioTracks()) {
          if (!videoStream.getAudioTracks().includes(t)) {
            videoStream.addTrack(t);
          }
        }
      }
      ctx.onRemoteVideoStream?.(targetPeerId, videoStream, event.track);
      event.track.onended = () => {
        ctx.onRemoteVideoStreamEnded?.(targetPeerId);
      };
      return;
    }

    const isScreenAudio = Boolean(
      (event.streams && event.streams.some((s) => s.id === 'screen-audio')) ||
      event.track.id === 'screen-audio' ||
      event.track.id.startsWith('screen-audio')
    );

    if (isScreenAudio) {
      const screenStream =
        event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      peerEntry.remoteScreenAudioStream = screenStream;

      if (peerEntry.remoteVideoStream) {
        if (!peerEntry.remoteVideoStream.getAudioTracks().includes(event.track)) {
          peerEntry.remoteVideoStream.addTrack(event.track);
        }
      }

      ctx.onRemoteScreenAudioStream?.(targetPeerId, screenStream, event.track);

      let screenAudioEl = peerEntry.screenAudioElement;
      if (!screenAudioEl) {
        screenAudioEl = document.createElement('audio');
        screenAudioEl.id = `remote-screen-audio-${targetPeerId}`;
        screenAudioEl.autoplay = true;
        screenAudioEl.playsInline = true;
        screenAudioEl.style.position = 'fixed';
        screenAudioEl.style.left = '-9999px';
        screenAudioEl.style.top = '-9999px';
        screenAudioEl.style.width = '1px';
        screenAudioEl.style.height = '1px';
        screenAudioEl.style.opacity = '0.01';
        document.body.appendChild(screenAudioEl);
        peerEntry.screenAudioElement = screenAudioEl;
      }

      const isLocalMutedInit = Boolean(localMutedPeersRef.current[targetPeerId]);
      const peerVolInit =
        peerVolumesRef.current[targetPeerId] !== undefined ? peerVolumesRef.current[targetPeerId] : 1.0;
      const effectiveInit = isAudioBlockedRef.current || isLocalMutedInit ? 0 : peerVolInit;

      screenAudioEl.srcObject = screenStream;
      screenAudioEl.muted = effectiveInit === 0;
      screenAudioEl.volume = Math.min(1.0, effectiveInit);
      routeMediaElement(screenAudioEl);

      event.track.onunmute = () => {
        if (peerEntry.screenAudioElement && !isAudioBlockedRef.current) {
          const freshScreenStream = new MediaStream([event.track]);
          peerEntry.screenAudioElement.srcObject = freshScreenStream;
          peerEntry.screenAudioElement.play().catch(() => {});
        }
      };

      const screenPlayPromise = screenAudioEl.play();
      if (screenPlayPromise !== undefined) {
        screenPlayPromise
          .then(() => {
            logLocalDebug('SCREEN_AUDIO_PLAY_OK', `Peer: ${targetPeerId} screen audio actively playing!`);
          })
          .catch((err: unknown) => {
            const errStr = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            logLocalDebug('SCREEN_AUDIO_PLAY_BLOCKED', `Peer: ${targetPeerId} screen audio autoplay blocked: ${errStr}`);
            const resumeScreenOnInteraction = () => {
              if (peerEntry.screenAudioElement && !isAudioBlockedRef.current) {
                peerEntry.screenAudioElement.play().catch(() => {});
              }
              window.removeEventListener('click', resumeScreenOnInteraction);
              window.removeEventListener('keydown', resumeScreenOnInteraction);
              window.removeEventListener('touchstart', resumeScreenOnInteraction);
            };
            window.addEventListener('click', resumeScreenOnInteraction);
            window.addEventListener('keydown', resumeScreenOnInteraction);
            window.addEventListener('touchstart', resumeScreenOnInteraction);
          });
      }
      return;
    }

    // 1. Audio Element Pipeline
    let audioEl = peerEntry.audioElement;
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `remote-audio-${targetPeerId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.style.position = 'fixed';
      audioEl.style.left = '-9999px';
      audioEl.style.top = '-9999px';
      audioEl.style.width = '1px';
      audioEl.style.height = '1px';
      audioEl.style.opacity = '0.01';
      document.body.appendChild(audioEl);
      peerEntry.audioElement = audioEl;
    }

    const remoteStream =
      event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    const isLocalMutedInit = Boolean(localMutedPeersRef.current[targetPeerId]);
    const peerVolInit =
      peerVolumesRef.current[targetPeerId] !== undefined ? peerVolumesRef.current[targetPeerId] : 1.0;
    const effectiveInit = isAudioBlockedRef.current || isLocalMutedInit ? 0 : peerVolInit;

    audioEl.srcObject = remoteStream;
    audioEl.muted = effectiveInit === 0;
    audioEl.volume = Math.min(1.0, effectiveInit);
    routeMediaElement(audioEl);

    // 2. Direct Web Audio API Pipeline
    const connectWebAudioPipeline = (stream: MediaStream) => {
      try {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return;
        if (!window.__webrtcAudioCtx) {
          window.__webrtcAudioCtx = new AudioContextClass();
        }
        const audioCtx = window.__webrtcAudioCtx;
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }

        if (peerEntry.webAudioSource) {
          try {
            peerEntry.webAudioSource.disconnect();
          } catch {
            // ignore
          }
        }
        if (peerEntry.webAudioGain) {
          try {
            peerEntry.webAudioGain.disconnect();
          } catch {
            // ignore
          }
        }
        if (peerEntry.analyserNode) {
          try {
            peerEntry.analyserNode.disconnect();
          } catch {
            // ignore
          }
        }

        const srcNode = audioCtx.createMediaStreamSource(stream);
        const analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 256;
        analyserNode.smoothingTimeConstant = 0.5;

        srcNode.connect(analyserNode);

        peerEntry.webAudioSource = srcNode;
        peerEntry.analyserNode = analyserNode;
        logLocalDebug(
          'WEBAUDIO_ANALYSER_ROUTED',
          `Peer: ${targetPeerId} -> Web Audio analyser connected (ctx: ${audioCtx.state})`
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logLocalDebug('WEBAUDIO_ERR', `AudioContext route error: ${message}`);
      }
    };

    connectWebAudioPipeline(remoteStream);

    // Handle when remote sender un-mutes and RTP packets arrive
    event.track.onunmute = () => {
      if (peerEntry.audioElement && !isAudioBlockedRef.current) {
        const freshStream = new MediaStream([event.track]);
        peerEntry.audioElement.srcObject = freshStream;
        peerEntry.audioElement
          .play()
          .then(() => {
            logLocalDebug('PLAY_ON_UNMUTE_OK', `Peer: ${targetPeerId} audio is actively playing!`);
          })
          .catch((err: unknown) => {
            const errStr = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            logLocalDebug(
              'PLAY_ON_UNMUTE_ERR',
              `Peer: ${targetPeerId} - ${errStr}`
            );
          });
        connectWebAudioPipeline(freshStream);
      }
    };

    event.track.onmute = () => {
      logLocalDebug('TRACK_ONMUTE', `Peer: ${targetPeerId} - Incoming audio track muted`);
    };

    const playPromise = audioEl.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          logLocalDebug(
            'INITIAL_PLAY_OK',
            `Peer: ${targetPeerId} audio element playing (paused: ${audioEl!.paused})`
          );
        })
        .catch((err: unknown) => {
          const errStr = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          logLocalDebug(
            'INITIAL_PLAY_BLOCKED',
            `Peer: ${targetPeerId} Autoplay blocked: ${errStr}`
          );
          const resumeOnInteraction = () => {
            if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
              window.__webrtcAudioCtx.resume().catch(() => {});
            }
            if (peerEntry.audioElement && !isAudioBlockedRef.current) {
              peerEntry.audioElement
                .play()
                .then(() => {
                  logLocalDebug(
                    'RESUME_PLAY_OK',
                    `Peer: ${targetPeerId} audio playback resumed on user gesture!`
                  );
                })
                .catch((e: unknown) => {
                  const eStr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                  logLocalDebug(
                    'RESUME_PLAY_ERR',
                    `Peer: ${targetPeerId} resume failed: ${eStr}`
                  );
                });
            }
            window.removeEventListener('click', resumeOnInteraction);
            window.removeEventListener('keydown', resumeOnInteraction);
            window.removeEventListener('touchstart', resumeOnInteraction);
          };
          window.addEventListener('click', resumeOnInteraction);
          window.addEventListener('keydown', resumeOnInteraction);
          window.addEventListener('touchstart', resumeOnInteraction);
        });
    }
  };
}
