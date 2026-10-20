import { routeMediaElement } from '../utils/audioDevices';

export interface PeerAudioEntry {
  audioElement?: HTMLAudioElement | null;
  remoteVideoStream?: MediaStream | null;
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
      ctx.onRemoteVideoStream?.(targetPeerId, videoStream, event.track);
      event.track.onended = () => {
        ctx.onRemoteVideoStreamEnded?.(targetPeerId);
      };
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
