/**
 * Remote voice playback for one peer: when the peer's audio track arrives it is played through a
 * hidden <audio> element (the only speaker output) and tapped by an AnalyserNode for the speaking
 * ring / volume meter. Handles autoplay blocking and the track muting/unmuting.
 */
export function attachRemoteAudio(pc, ctx) {
    const { isAudioBlockedRef, localMutedPeersRef, logLocalDebug, peerEntry, peerVolumesRef, targetPeerId } = ctx;
    // Handle incoming audio stream from remote peer
    pc.ontrack = (event) => {

        // 1. Audio Element Pipeline (Offscreen layout instead of display:none to prevent Chrome background throttling)
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

        const remoteStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        const isLocalMutedInit = Boolean(localMutedPeersRef.current[targetPeerId]);
        const peerVolInit = peerVolumesRef.current[targetPeerId] !== undefined ? peerVolumesRef.current[targetPeerId] : 1.0;
        const effectiveInit = isAudioBlockedRef.current || isLocalMutedInit ? 0 : peerVolInit;

        audioEl.srcObject = remoteStream;
        audioEl.muted = effectiveInit === 0;
        audioEl.volume = Math.min(1.0, effectiveInit);
        if (typeof audioEl.setSinkId === 'function') {
            audioEl.setSinkId('').catch(() => { });
        }

        // 2. Direct Web Audio API Pipeline (Routes directly to system audio hardware, bypassing Chromium MediaElement sink bugs)
        const connectWebAudioPipeline = (stream) => {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;
                if (!window.__webrtcAudioCtx) {
                    window.__webrtcAudioCtx = new AudioContextClass();
                }
                const ctx = window.__webrtcAudioCtx;
                if (ctx.state === 'suspended') {
                    ctx.resume().catch(() => { });
                }

                if (peerEntry.webAudioSource) {
                    try { peerEntry.webAudioSource.disconnect(); } catch { }
                }
                if (peerEntry.webAudioGain) {
                    try { peerEntry.webAudioGain.disconnect(); } catch { }
                }
                if (peerEntry.analyserNode) {
                    try { peerEntry.analyserNode.disconnect(); } catch { }
                }

                const srcNode = ctx.createMediaStreamSource(stream);
                const analyserNode = ctx.createAnalyser();
                analyserNode.fftSize = 256;
                analyserNode.smoothingTimeConstant = 0.5;

                // Connect solely to AnalyserNode for Speaking Rings & VU meter.
                // DO NOT route to ctx.destination: audioEl is the sole speaker output.
                // Playing through both simultaneously caused acoustic comb filtering (hollow room echo).
                srcNode.connect(analyserNode);

                peerEntry.webAudioSource = srcNode;
                peerEntry.analyserNode = analyserNode;
                logLocalDebug('WEBAUDIO_ANALYSER_ROUTED', `Peer: ${targetPeerId} -> Web Audio analyser connected (ctx: ${ctx.state})`);
            } catch (err) {
                logLocalDebug('WEBAUDIO_ERR', `AudioContext route error: ${err.message}`);
            }
        };

        connectWebAudioPipeline(remoteStream);

        // Handle when remote sender un-mutes and RTP packets arrive
        event.track.onunmute = () => {
            if (peerEntry.audioElement && !isAudioBlockedRef.current) {
                const freshStream = new MediaStream([event.track]);
                peerEntry.audioElement.srcObject = freshStream;
                peerEntry.audioElement.play().then(() => {
                    logLocalDebug('PLAY_ON_UNMUTE_OK', `Peer: ${targetPeerId} audio is actively playing!`);
                }).catch((err) => {
                    logLocalDebug('PLAY_ON_UNMUTE_ERR', `Peer: ${targetPeerId} - ${err.name}: ${err.message}`);
                });
                connectWebAudioPipeline(freshStream);
            }
        };

        event.track.onmute = () => {
            logLocalDebug('TRACK_ONMUTE', `Peer: ${targetPeerId} - Incoming audio track muted`);
        };

        const playPromise = audioEl.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                logLocalDebug('INITIAL_PLAY_OK', `Peer: ${targetPeerId} audio element playing (paused: ${audioEl.paused})`);
            }).catch((err) => {
                logLocalDebug('INITIAL_PLAY_BLOCKED', `Peer: ${targetPeerId} Autoplay blocked (${err.name}): ${err.message}`);
                const resumeOnInteraction = () => {
                    if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
                        window.__webrtcAudioCtx.resume().catch(() => { });
                    }
                    if (peerEntry.audioElement && !isAudioBlockedRef.current) {
                        peerEntry.audioElement.play().then(() => {
                            logLocalDebug('RESUME_PLAY_OK', `Peer: ${targetPeerId} audio playback resumed on user gesture!`);
                        }).catch((e) => {
                            logLocalDebug('RESUME_PLAY_ERR', `Peer: ${targetPeerId} resume failed: ${e.name} - ${e.message}`);
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
