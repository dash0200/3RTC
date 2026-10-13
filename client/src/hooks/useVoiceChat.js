/**
 * Voice chat: microphone (open / mute / push-to-talk), the send pipeline (in-app noise
 * removal), audio settings, deafen, per-peer volume and local mute, and the speaking indicators.
 * Owns the voice state and the refs that mirror it for the audio and peer-connection code.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { sound } from '../utils/sound';
import { speakingActivity } from '../utils/speakingActivity';
import { micPipeline } from '../utils/micPipeline';
import { replacePeerAudioTrack } from '../webrtc/peerEntry';
import {
    loadAudioSettings,
    saveAudioSettings,
    buildMicConstraints,
    ensureMicProcessing,
    getOptionalMicConstraints,
    MIC_PROCESSING
} from '../utils/audioSettings';

export function useVoiceChat(ctx) {
    const { addSystemMessage, logLocalDebug, peerMetadata, peersRef, showToast, username } = ctx;

    // WebRTC Voice Chat State
    const [isMicMuted, setIsMicMuted] = useState(true);
    const [isAudioBlocked, setIsAudioBlocked] = useState(false);
    const [peerVoiceStates, setPeerVoiceStates] = useState({});

    // Feature 2.1: Per-Peer Volume Sliders & Speaking Rings State
    const [peerVolumes, setPeerVolumes] = useState({}); // { [peerId]: number (0.0 to 2.0) }
    const [localMutedPeers, setLocalMutedPeers] = useState({}); // { [peerId]: boolean }
    // Speaking activity (rings / meters) lives in utils/speakingActivity.js, outside React state
    // Feature 2.2: Audio Processing Toggles (Noise Suppression & Echo Cancellation) & Push-to-Talk (PTT)
    const [audioSettings, setAudioSettings] = useState(() => loadAudioSettings());
    // Voice isolation on the live mic: null (mic not opened yet) | 'off' | 'active' (browser/OS)
    // | 'rnnoise' (in-app noise removal) | 'unavailable'
    const [voiceIsolationStatus, setVoiceIsolationStatus] = useState(null);
    // Whether the current mic stream was opened with voice isolation requested
    const micIsolationRequestedRef = useRef(false);
    const [isPttActive, setIsPttActive] = useState(false);
    const audioSettingsRef = useRef(audioSettings);
    const isPttActiveRef = useRef(false);
    const pttReleaseTimerRef = useRef(null);
    const isAudioUpdatingRef = useRef(false);

    const localStreamRef = useRef(null);
    const isMicMutedRef = useRef(true);
    const isAudioBlockedRef = useRef(false);
    const peerVolumesRef = useRef({});
    const localMutedPeersRef = useRef({});
    const localAnalyserRef = useRef(null);
    const localSourceNodeRef = useRef(null);

    // Refs mirror state so callbacks and audio code always read the latest value
    isMicMutedRef.current = isMicMuted;
    isAudioBlockedRef.current = isAudioBlocked;
    peerVolumesRef.current = peerVolumes;
    localMutedPeersRef.current = localMutedPeers;
    audioSettingsRef.current = audioSettings;
    isPttActiveRef.current = isPttActive;

    // Voice Chat: confirm echo cancellation / noise suppression really took effect on a fresh mic track
    const verifyMicProcessing = useCallback(async (track) => {
        const status = await ensureMicProcessing(track, getOptionalMicConstraints());
        // Logged directly (logLocalDebug is a no-op) so the applied mic processing can be checked in DevTools
        console.info(
            `[3RTC] AUDIO_DSP_APPLIED AEC: ${status.echoCancellation}, NS: ${status.noiseSuppression}, AGC: ${status.autoGainControl}, Voice isolation: ${status.voiceIsolation} | Mic: "${track?.label}"`
        );
        if (!status.ok) {
            const missing = [
                status.echoCancellation === false ? 'echo cancellation' : null,
                status.noiseSuppression === false ? 'noise suppression' : null
            ].filter(Boolean).join(' & ');
            showToast(`⚠️ Your browser/mic refused ${missing}. Use headphones to avoid echo.`);
        }
        return status;
    }, [showToast]);

    // Open mic sends continuously (like Teams); background noise is removed by noise suppression /
    // RNNoise rather than by cutting the mic between words. The mic track only follows mute.
    const applyVoiceGate = useCallback(() => {
        const track = localStreamRef.current?.getAudioTracks()[0];
        if (track) track.enabled = !isMicMutedRef.current;
    }, []);

    // Voice Chat: track to send to peers, from the send pipeline (micPipeline.js): voice gate, plus
    // in-app RNNoise noise removal when Voice Isolation is on and the browser/OS has no native one.
    const getSendTrack = useCallback(async (stream) => {
        const rawTrack = stream?.getAudioTracks()[0] || null;
        if (!rawTrack) {
            micPipeline.teardown();
            return null;
        }
        // Voice Isolation = in-app RNNoise on every platform (the browser's own isolation isn't trusted)
        const useRnnoise = micIsolationRequestedRef.current;
        const { track, isolationActive } = await micPipeline.build(stream, { isolation: useRnnoise });
        setVoiceIsolationStatus(!useRnnoise ? 'off' : isolationActive ? 'rnnoise' : 'unavailable');
        if (useRnnoise) {
            console.info(`[3RTC] VOICE_ISOLATION ${isolationActive ? 'in-app RNNoise active' : 'could not start, sending mic without it'}`);
        }
        return track || rawTrack;
    }, []);

    // Speaking ring / level meter for your own mic: reads the track actually sent to peers (after
    // noise removal), so it reflects what others hear rather than the raw room sound
    const connectLocalMeter = useCallback((track) => {
        const ctx = window.__webrtcAudioCtx;
        const analyser = localAnalyserRef.current;
        if (localSourceNodeRef.current) {
            try { localSourceNodeRef.current.disconnect(); } catch { }
            localSourceNodeRef.current = null;
        }
        if (!ctx || !analyser || !track) return;
        try {
            const source = ctx.createMediaStreamSource(new MediaStream([track]));
            source.connect(analyser);
            localSourceNodeRef.current = source;
        } catch (err) {
            logLocalDebug('ANALYSER_CONNECT_ERR', err.message);
        }
    }, [logLocalDebug]);

    // Voice Chat: Set Microphone Mute/Unmute
    const setMicrophoneMuted = useCallback(async (shouldMute, isPtt = false) => {
        // If incoming audio is currently blocked, unmuting microphone also unblocks audio
        if (!shouldMute && isAudioBlockedRef.current) {
            setIsAudioBlocked(false);
            isAudioBlockedRef.current = false;
            for (const peer of peersRef.current.values()) {
                if (peer.audioElement) {
                    peer.audioElement.muted = false;
                }
                if (peer.webAudioGain) {
                    peer.webAudioGain.gain.value = 1.0;
                }
            }
        }

        if (window.__webrtcAudioCtx && window.__webrtcAudioCtx.state === 'suspended') {
            window.__webrtcAudioCtx.resume().catch(() => { });
        }

        if (!shouldMute) {
            try {
                let stream = localStreamRef.current;
                const currentTrack = stream?.getAudioTracks()[0];
                const currentSettings = currentTrack?.getSettings ? currentTrack.getSettings() : {};
                const settingsMatch = currentTrack &&
                    currentTrack.readyState === 'live' &&
                    Boolean(currentSettings.echoCancellation) === MIC_PROCESSING.echoCancellation &&
                    Boolean(currentSettings.noiseSuppression) === MIC_PROCESSING.noiseSuppression &&
                    Boolean(currentSettings.autoGainControl) === MIC_PROCESSING.autoGainControl &&
                    micIsolationRequestedRef.current === Boolean(audioSettingsRef.current?.voiceIsolation);

                if (!settingsMatch) {
                    micPipeline.teardown();
                    if (stream) {
                        try { stream.getTracks().forEach((t) => t.stop()); } catch { }
                    }
                    if (localSourceNodeRef.current) {
                        try { localSourceNodeRef.current.disconnect(); } catch { }
                        localSourceNodeRef.current = null;
                    }
                    await new Promise((r) => setTimeout(r, 60));

                    const wantIsolation = Boolean(audioSettingsRef.current?.voiceIsolation);
                    stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(currentSettings?.deviceId, { voiceIsolation: wantIsolation }));
                    localStreamRef.current = stream;
                    micIsolationRequestedRef.current = wantIsolation;
                    await verifyMicProcessing(stream.getAudioTracks()[0], wantIsolation);
                }

                // Connect local microphone to Web Audio AnalyserNode for Speaking Rings & VU meter
                try {
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    if (AudioContextClass) {
                        if (!window.__webrtcAudioCtx) {
                            window.__webrtcAudioCtx = new AudioContextClass();
                        }
                        const ctx = window.__webrtcAudioCtx;
                        if (ctx.state === 'suspended') {
                            ctx.resume().catch(() => { });
                        }
                        if (localSourceNodeRef.current) {
                            try { localSourceNodeRef.current.disconnect(); } catch { }
                        }
                        if (localAnalyserRef.current) {
                            try { localAnalyserRef.current.disconnect(); } catch { }
                        }
                        const localAnalyser = ctx.createAnalyser();
                        localAnalyser.fftSize = 256;
                        localAnalyser.smoothingTimeConstant = 0.5;
                        localSourceNodeRef.current = null;
                        localAnalyserRef.current = localAnalyser;
                    }
                } catch { }

                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = true;
                    const sendTrack = await getSendTrack(stream);
                    connectLocalMeter(sendTrack);
                    logLocalDebug('MIC_UNMUTE', `User "${username}" unmuting mic. Track: "${audioTrack.label}", ID: ${audioTrack.id}, state: ${audioTrack.readyState}`);

                    for (const peer of peersRef.current.values()) {
                        replacePeerAudioTrack(peer.pc, sendTrack, logLocalDebug);
                    }
                }

                setIsMicMuted(false);
                isMicMutedRef.current = false;
                applyVoiceGate();
                if (!isPtt) {
                    sound.playPop();
                    showToast('🎙️ Microphone unmuted (Live)');
                    addSystemMessage('🎙️ You unmuted your microphone (Voice Chat Active).');
                }

                const voiceMsg = {
                    type: 'peer-voice-status',
                    sender: username,
                    isMuted: false
                };
                for (const peer of peersRef.current.values()) {
                    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                        try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                    }
                }
            } catch (err) {
                showToast('⚠️ Could not access microphone. Check permissions.');
            }
        } else {
            if (localStreamRef.current) {
                localStreamRef.current.getAudioTracks().forEach((track) => {
                    track.enabled = false;
                });
            }
            setIsMicMuted(true);
            isMicMutedRef.current = true;
            speakingActivity.resetLocal();
            if (!isPtt) {
                showToast('🔇 Microphone muted');
                addSystemMessage('🔇 You muted your microphone.');
            }

            const voiceMsg = {
                type: 'peer-voice-status',
                sender: username,
                isMuted: true
            };
            for (const peer of peersRef.current.values()) {
                if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                    try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                }
            }
        }
    }, [addSystemMessage, applyVoiceGate, connectLocalMeter, getSendTrack, logLocalDebug, showToast, username, verifyMicProcessing]);

    // Voice Chat: Toggle Microphone Mute/Unmute
    const toggleMicrophone = useCallback(() => {
        setMicrophoneMuted(!isMicMutedRef.current, false);
    }, [setMicrophoneMuted]);

    // Feature 2.2: Apply Updated Audio Processing Settings & Reconfigure MediaStream
    const handleUpdateAudioSettings = useCallback(async (newSettings) => {
        const enforcedSettings = {
            ...newSettings,
            ...MIC_PROCESSING
        };
        setAudioSettings(enforcedSettings);
        audioSettingsRef.current = enforcedSettings;
        saveAudioSettings(enforcedSettings);
        applyVoiceGate();

        // If switched to PTT mode, immediately mute microphone to be ready for push-to-talk
        if (newSettings.inputMode === 'ptt' && !isMicMutedRef.current) {
            await setMicrophoneMuted(true, true);
            return;
        }

        // Concurrency guard to prevent rapid toggle collisions
        if (isAudioUpdatingRef.current) {
            return;
        }
        isAudioUpdatingRef.current = true;

        try {
            const wasMuted = isMicMutedRef.current;
            const currentStream = localStreamRef.current;
            const currentTrack = currentStream?.getAudioTracks()[0];
            const deviceId = currentTrack?.getSettings?.()?.deviceId;

            // Disconnect old Web Audio node
            if (localSourceNodeRef.current) {
                try { localSourceNodeRef.current.disconnect(); } catch { }
                localSourceNodeRef.current = null;
            }

            // CRITICAL CHROMIUM FIX: Stop existing tracks BEFORE requesting a new stream.
            // In Chromium / WASAPI, calling getUserMedia while an old track is live reuses the
            // existing capture session and corrupts the native WebRTC Audio Processing Module (AEC3).
            micPipeline.teardown();
            if (currentStream) {
                try {
                    currentStream.getTracks().forEach((t) => t.stop());
                } catch { }
                localStreamRef.current = null;
            }

            // If the microphone is currently muted, do not open hardware capture while muted.
            // Null out sender tracks so peers receive silence.
            // When user later un-mutes, setMicrophoneMuted will acquire a fresh stream with newSettings.
            if (wasMuted) {
                for (const peer of peersRef.current.values()) {
                    await replacePeerAudioTrack(peer.pc, null, logLocalDebug);
                }
                return;
            }

            // If microphone is actively unmuted, re-acquire the stream with new DSP constraints.
            // Brief 80ms delay to ensure the OS/browser hardware capture session is fully released.
            await new Promise((resolve) => setTimeout(resolve, 80));

            const wantIsolation = Boolean(enforcedSettings.voiceIsolation);
            const newStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId, { voiceIsolation: wantIsolation }));
            const newTrack = newStream.getAudioTracks()[0];
            if (!newTrack) {
                throw new Error('No audio track returned from microphone');
            }
            newTrack.enabled = true;
            localStreamRef.current = newStream;
            micIsolationRequestedRef.current = wantIsolation;

            await verifyMicProcessing(newTrack, wantIsolation);

            const sendTrack = await getSendTrack(newStream);
            connectLocalMeter(sendTrack);

            // Replace audio track cleanly in each peer connection
            await Promise.all([...peersRef.current.values()].map((peer) => replacePeerAudioTrack(peer.pc, sendTrack, logLocalDebug)));
        } catch (err) {
            logLocalDebug('AUDIO_SETTINGS_UPDATE_ERR', err.message);
            showToast('⚠️ Could not update audio settings: ' + err.message);
        } finally {
            isAudioUpdatingRef.current = false;
        }
    }, [applyVoiceGate, connectLocalMeter, getSendTrack, logLocalDebug, setMicrophoneMuted, showToast, verifyMicProcessing]);

    // Push-to-Talk (PTT) Mouse Handlers for button hold
    const handlePttPressStart = useCallback(() => {
        if (audioSettings.inputMode !== 'ptt') return;
        if (pttReleaseTimerRef.current) {
            clearTimeout(pttReleaseTimerRef.current);
            pttReleaseTimerRef.current = null;
        }
        if (!isPttActiveRef.current) {
            isPttActiveRef.current = true;
            setIsPttActive(true);
            if (audioSettings.pttChime) sound.playPttOn();
            setMicrophoneMuted(false, true);
        }
    }, [audioSettings, setMicrophoneMuted]);

    const handlePttPressEnd = useCallback(() => {
        if (audioSettings.inputMode !== 'ptt') return;
        if (isPttActiveRef.current) {
            const delay = Math.max(0, audioSettings.pttReleaseDelay || 0);
            if (delay > 0) {
                if (pttReleaseTimerRef.current) clearTimeout(pttReleaseTimerRef.current);
                pttReleaseTimerRef.current = setTimeout(() => {
                    isPttActiveRef.current = false;
                    setIsPttActive(false);
                    if (audioSettings.pttChime) sound.playPttOff();
                    setMicrophoneMuted(true, true);
                    pttReleaseTimerRef.current = null;
                }, delay);
            } else {
                isPttActiveRef.current = false;
                setIsPttActive(false);
                if (audioSettings.pttChime) sound.playPttOff();
                setMicrophoneMuted(true, true);
            }
        }
    }, [audioSettings, setMicrophoneMuted]);

    // Feature 2.2: Push-to-Talk (PTT) Global Key Handlers & Hotkeys
    // Voice Chat: Toggle Block Incoming Audio (Deafen) - blocks incoming audio AND microphone
    const toggleBlockAudio = useCallback(() => {
        setIsAudioBlocked((prev) => {
            const nextVal = !prev;
            isAudioBlockedRef.current = nextVal;

            // Mute/unmute all peer audio streams (HTMLMediaElement + Web Audio gain)
            for (const [pId, peer] of peersRef.current.entries()) {
                const isLocalMuted = Boolean(localMutedPeersRef.current[pId]);
                const vol = peerVolumesRef.current[pId] !== undefined ? peerVolumesRef.current[pId] : 1.0;
                const effective = nextVal || isLocalMuted ? 0 : vol;
                if (peer.audioElement) {
                    peer.audioElement.muted = effective === 0;
                    peer.audioElement.volume = Math.min(1.0, effective);
                }
                if (peer.webAudioGain) {
                    peer.webAudioGain.gain.value = effective;
                }
            }

            if (nextVal) {
                // When audio is blocked, the microphone is also blocked (muted)
                if (localStreamRef.current) {
                    localStreamRef.current.getAudioTracks().forEach((track) => {
                        track.enabled = false;
                    });
                }
                setIsMicMuted(true);
                isMicMutedRef.current = true;
                speakingActivity.resetLocal();

                const voiceMsg = {
                    type: 'peer-voice-status',
                    sender: username,
                    isMuted: true
                };
                for (const peer of peersRef.current.values()) {
                    if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                        try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { }
                    }
                }

                showToast('🔇 Audio & microphone blocked (Text Chat only)');
                addSystemMessage('🔇 Audio & microphone blocked (Text Chat only mode).');
            } else {
                showToast('🔊 Incoming audio unblocked');
                addSystemMessage('🔊 You unblocked incoming audio.');
            }
            return nextVal;
        });
    }, [addSystemMessage, showToast, username]);

    // Feature 2.1: Real-time Voice Activity Detection (VAD) & Speaking Rings Sampling Loop
    useEffect(() => {
        const buffer = new Uint8Array(128); // 128 frequency bins (fftSize = 256)
        const interval = setInterval(() => {
            // Nothing to measure (no live mic, no peers) and nothing showing: skip
            const micLive = !isMicMutedRef.current && localAnalyserRef.current;
            if (!micLive && peersRef.current.size === 0 && speakingActivity.isIdle()) return;

            // 1. Local Microphone Activity
            let localSpeaking = false;
            let localLevel = 0;
            if (!isMicMutedRef.current && localAnalyserRef.current) {
                try {
                    localAnalyserRef.current.getByteFrequencyData(buffer);
                    let sum = 0;
                    for (let i = 0; i < buffer.length; i++) {
                        sum += buffer[i];
                    }
                    const avg = sum / buffer.length;
                    localSpeaking = avg > 12;
                    localLevel = Math.min(100, Math.round((avg / 70) * 100));
                } catch { }
            }

            // 2. Remote Peers Voice Activity
            const activityMap = {};
            for (const [peerId, entry] of peersRef.current.entries()) {
                if (entry.analyserNode) {
                    try {
                        entry.analyserNode.getByteFrequencyData(buffer);
                        let sum = 0;
                        for (let i = 0; i < buffer.length; i++) {
                            sum += buffer[i];
                        }
                        const avg = sum / buffer.length;
                        const isSpeaking = avg > 12;
                        const level = Math.min(100, Math.round((avg / 70) * 100));
                        activityMap[peerId] = { isSpeaking, level };
                    } catch {
                        activityMap[peerId] = { isSpeaking: false, level: 0 };
                    }
                } else {
                    activityMap[peerId] = { isSpeaking: false, level: 0 };
                }
            }

            speakingActivity.update({ isSpeaking: localSpeaking, level: localLevel }, activityMap);
        }, 75);

        return () => clearInterval(interval);
    }, []);

    // Feature 2.1: Per-Peer Volume Slider Handler (0% - 200%)
    const handleSetPeerVolume = useCallback((peerId, vol) => {
        const clamped = Math.max(0, Math.min(2.0, Math.round(vol * 100) / 100));
        setPeerVolumes((prev) => ({
            ...prev,
            [peerId]: clamped
        }));
        peerVolumesRef.current[peerId] = clamped;

        // Auto unmute if user adjusts slider while locally muted
        if (localMutedPeersRef.current[peerId] && clamped > 0) {
            setLocalMutedPeers((prev) => ({ ...prev, [peerId]: false }));
            localMutedPeersRef.current[peerId] = false;
        }

        const entry = peersRef.current.get(peerId);
        if (entry) {
            const isLocalMuted = Boolean(localMutedPeersRef.current[peerId]);
            const effective = isAudioBlockedRef.current || isLocalMuted ? 0 : clamped;
            if (entry.webAudioGain) {
                entry.webAudioGain.gain.value = effective;
            }
            if (entry.audioElement) {
                entry.audioElement.volume = Math.min(1.0, effective);
                entry.audioElement.muted = effective === 0;
            }
        }
    }, []);

    // Feature 2.1: One-Click Peer Mute for Me
    const handleToggleMutePeer = useCallback((peerId) => {
        setLocalMutedPeers((prev) => {
            const nextVal = !prev[peerId];
            localMutedPeersRef.current[peerId] = nextVal;

            const entry = peersRef.current.get(peerId);
            if (entry) {
                const vol = peerVolumesRef.current[peerId] !== undefined ? peerVolumesRef.current[peerId] : 1.0;
                const effective = isAudioBlockedRef.current || nextVal ? 0 : vol;
                if (entry.webAudioGain) {
                    entry.webAudioGain.gain.value = effective;
                }
                if (entry.audioElement) {
                    entry.audioElement.volume = Math.min(1.0, effective);
                    entry.audioElement.muted = effective === 0;
                }
            }

            const pName = peerMetadata[peerId]?.username || 'Peer';
            if (nextVal) {
                showToast(`🔇 Muted ${pName} for you`);
                addSystemMessage(`🔇 You muted ${pName} for yourself.`);
            } else {
                showToast(`🔊 Unmuted ${pName}`);
                addSystemMessage(`🔊 You unmuted ${pName}.`);
            }

            return { ...prev, [peerId]: nextVal };
        });
    }, [addSystemMessage, peerMetadata, showToast]);

    // Construct connected peers list with volume, mute, identity & speaking status

    return {
        isMicMuted,
        setIsMicMuted,
        isAudioBlocked,
        setIsAudioBlocked,
        peerVoiceStates,
        setPeerVoiceStates,
        peerVolumes,
        setPeerVolumes,
        localMutedPeers,
        setLocalMutedPeers,
        audioSettings,
        setAudioSettings,
        voiceIsolationStatus,
        setVoiceIsolationStatus,
        isPttActive,
        setIsPttActive,
        micIsolationRequestedRef,
        audioSettingsRef,
        isPttActiveRef,
        pttReleaseTimerRef,
        isAudioUpdatingRef,
        localStreamRef,
        isMicMutedRef,
        isAudioBlockedRef,
        peerVolumesRef,
        localMutedPeersRef,
        localAnalyserRef,
        localSourceNodeRef,
        verifyMicProcessing,
        applyVoiceGate,
        getSendTrack,
        setMicrophoneMuted,
        toggleMicrophone,
        handleUpdateAudioSettings,
        handlePttPressStart,
        handlePttPressEnd,
        toggleBlockAudio,
        handleSetPeerVolume,
        handleToggleMutePeer
    };
}
