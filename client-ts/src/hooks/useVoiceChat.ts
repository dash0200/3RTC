/**
 * Voice chat: microphone (open / mute / push-to-talk), the send pipeline (in-app noise
 * removal), audio settings, deafen, per-peer volume and local mute, and the speaking indicators.
 * Owns the voice state and the refs that mirror it for the audio and peer-connection code.
 */
import { useState, useRef, useCallback, useEffect, type MutableRefObject } from 'react';
import { sound } from '../utils/sound';
import { speakingActivity } from '../utils/speakingActivity';
import { micPipeline } from '../utils/micPipeline';
import { replacePeerAudioTrack, type PeerEntryRecord } from '../webrtc/peerEntry';
import {
  loadAudioSettings,
  saveAudioSettings,
  buildMicConstraints,
  ensureMicProcessing,
  getOptionalMicConstraints,
  MIC_PROCESSING,
  type AudioSettings
} from '../utils/audioSettings';
import { setOutputDevice, onDevicesChanged, resolveDevice } from '../utils/audioDevices';

export interface UseVoiceChatContext {
  addSystemMessage: (msg: string) => void;
  logLocalDebug: (type: string, detail?: unknown) => void;
  peerMetadata: Record<string, { username?: string }>;
  peersRef: MutableRefObject<Map<string, PeerEntryRecord>>;
  showToast: (msg: string) => void;
  username: string;
}

export function useVoiceChat(ctx: UseVoiceChatContext) {
  const { addSystemMessage, logLocalDebug, peerMetadata, peersRef, showToast, username } = ctx;

  // WebRTC Voice Chat State
  const [isMicMuted, setIsMicMuted] = useState(true);
  const [isAudioBlocked, setIsAudioBlocked] = useState(false);
  const [peerVoiceStates, setPeerVoiceStates] = useState<Record<string, { isMuted: boolean }>>({});

  // Feature 2.1: Per-Peer Volume Sliders & Speaking Rings State
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({}); // { [peerId]: number (0.0 to 2.0) }
  const [localMutedPeers, setLocalMutedPeers] = useState<Record<string, boolean>>({}); // { [peerId]: boolean }

  // Feature 2.2: Audio Processing Toggles & Push-to-Talk (PTT)
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => loadAudioSettings());
  // Voice isolation on the live mic: null (mic not opened yet) | 'off' | 'active' | 'rnnoise' | 'unavailable'
  const [voiceIsolationStatus, setVoiceIsolationStatus] = useState<string | null>(null);
  const micIsolationRequestedRef = useRef(false);
  const micDeviceRequestedRef = useRef('');
  const [isPttActive, setIsPttActive] = useState(false);
  const audioSettingsRef = useRef<AudioSettings>(audioSettings);
  const isPttActiveRef = useRef(false);
  const pttReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAudioUpdatingRef = useRef(false);

  const localStreamRef = useRef<MediaStream | null>(null);
  const isMicMutedRef = useRef(true);
  const isAudioBlockedRef = useRef(false);
  const peerVolumesRef = useRef<Record<string, number>>({});
  const localMutedPeersRef = useRef<Record<string, boolean>>({});
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const localSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Refs mirror state so callbacks and audio code always read the latest value
  isMicMutedRef.current = isMicMuted;
  isAudioBlockedRef.current = isAudioBlocked;
  peerVolumesRef.current = peerVolumes;
  localMutedPeersRef.current = localMutedPeers;
  audioSettingsRef.current = audioSettings;
  isPttActiveRef.current = isPttActive;

  // Voice Chat: confirm echo cancellation / noise suppression really took effect on a fresh mic track
  const verifyMicProcessing = useCallback(async (track?: MediaStreamTrack | null) => {
    if (!track) return null;
    const status = await ensureMicProcessing(track, getOptionalMicConstraints());
    console.info(
      `[3RTC] AUDIO_DSP_APPLIED AEC: ${status.echoCancellation}, NS: ${status.noiseSuppression}, AGC: ${status.autoGainControl}, Voice isolation: ${status.voiceIsolation} | Mic: "${track.label}"`
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

  const applyVoiceGate = useCallback((): void => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = !isMicMutedRef.current;
  }, []);

  const getSendTrack = useCallback(async (stream: MediaStream | null): Promise<MediaStreamTrack | null> => {
    const rawTrack = stream?.getAudioTracks()[0] || null;
    if (!rawTrack) {
      micPipeline.teardown();
      return null;
    }
    const useRnnoise = micIsolationRequestedRef.current;
    const { track, isolationActive } = await micPipeline.build(stream!, { isolation: useRnnoise });
    setVoiceIsolationStatus(!useRnnoise ? 'off' : isolationActive ? 'rnnoise' : 'unavailable');
    if (useRnnoise) {
      console.info(`[3RTC] VOICE_ISOLATION ${isolationActive ? 'in-app RNNoise active' : 'could not start, sending mic without it'}`);
    }
    return track || rawTrack;
  }, []);

  const connectLocalMeter = useCallback((track: MediaStreamTrack | null): void => {
    const ctx = window.__webrtcAudioCtx;
    const analyser = localAnalyserRef.current;
    if (localSourceNodeRef.current) {
      try { localSourceNodeRef.current.disconnect(); } catch { /* ignore */ }
      localSourceNodeRef.current = null;
    }
    if (!ctx || !analyser || !track) return;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      localSourceNodeRef.current = source;
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logLocalDebug('ANALYSER_CONNECT_ERR', errMessage);
    }
  }, [logLocalDebug]);

  // Voice Chat: Set Microphone Mute/Unmute
  const setMicrophoneMuted = useCallback(async (shouldMute: boolean, isPtt = false): Promise<void> => {
    if (!shouldMute && isAudioBlockedRef.current) {
      setIsAudioBlocked(false);
      isAudioBlockedRef.current = false;
      for (const peer of peersRef.current.values()) {
        if (peer.audioElement) {
          peer.audioElement.muted = false;
        }
        if (peer.screenAudioElement) {
          peer.screenAudioElement.muted = false;
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
          micIsolationRequestedRef.current === Boolean(audioSettingsRef.current?.voiceIsolation) &&
          micDeviceRequestedRef.current === (audioSettingsRef.current?.inputDeviceId || '');

        if (!settingsMatch) {
          micPipeline.teardown();
          if (stream) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
          }
          if (localSourceNodeRef.current) {
            try { localSourceNodeRef.current.disconnect(); } catch { /* ignore */ }
            localSourceNodeRef.current = null;
          }
          await new Promise((r) => setTimeout(r, 60));

          const wantIsolation = Boolean(audioSettingsRef.current?.voiceIsolation);
          const wantDevice = audioSettingsRef.current?.inputDeviceId || '';
          const useDevice = await resolveDevice('audioinput', wantDevice, audioSettingsRef.current?.inputDeviceLabel);
          stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(useDevice || undefined, { voiceIsolation: wantIsolation }));
          localStreamRef.current = stream;
          micIsolationRequestedRef.current = wantIsolation;
          micDeviceRequestedRef.current = wantDevice;
          await verifyMicProcessing(stream.getAudioTracks()[0]);
        }

        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            if (!window.__webrtcAudioCtx) {
              window.__webrtcAudioCtx = new AudioContextClass();
            }
            const audioCtx = window.__webrtcAudioCtx!;
            if (audioCtx.state === 'suspended') {
              audioCtx.resume().catch(() => { });
            }
            if (localSourceNodeRef.current) {
              try { localSourceNodeRef.current.disconnect(); } catch { /* ignore */ }
            }
            if (localAnalyserRef.current) {
              try { localAnalyserRef.current.disconnect(); } catch { /* ignore */ }
            }
            const localAnalyser = audioCtx.createAnalyser();
            localAnalyser.fftSize = 256;
            localAnalyser.smoothingTimeConstant = 0.5;
            localSourceNodeRef.current = null;
            localAnalyserRef.current = localAnalyser;
          }
        } catch { /* ignore audio error */ }

        const audioTrack = stream?.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = true;
          const sendTrack = await getSendTrack(stream);
          connectLocalMeter(sendTrack);
          logLocalDebug('MIC_UNMUTE', `User "${username}" unmuting mic. Track: "${audioTrack.label}", ID: ${audioTrack.id}, state: ${audioTrack.readyState}`);

          for (const peer of peersRef.current.values()) {
            replacePeerAudioTrack(peer.pc, sendTrack, logLocalDebug);
          }
        }

        if ('audioSession' in navigator && (navigator as unknown as { audioSession?: { type: string } }).audioSession) {
          try {
            (navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'play-and-record';
          } catch { /* ignore */ }
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
            try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { /* ignore */ }
          }
        }
      } catch {
        showToast('⚠️ Could not access microphone. Check permissions.');
      }
    } else {
      const isMobile =
        typeof navigator !== 'undefined' &&
        (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
          (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent || '')));

      if (isMobile) {
        // On mobile devices, leaving an active microphone track open forces the mobile OS
        // (Android MODE_IN_COMMUNICATION / iOS PlayAndRecord) into call-mode, ducking all media
        // audio and routing it through telephony speech-band filters.
        // Releasing the hardware tracks completely allows the OS to immediately return to
        // high-fidelity media playback mode for synchronized video and screen audio.
        if (localStreamRef.current) {
          try {
            localStreamRef.current.getTracks().forEach((track) => track.stop());
          } catch { /* ignore */ }
          localStreamRef.current = null;
        }
        if (localSourceNodeRef.current) {
          try { localSourceNodeRef.current.disconnect(); } catch { /* ignore */ }
          localSourceNodeRef.current = null;
        }
        micPipeline.teardown();
        for (const peer of peersRef.current.values()) {
          replacePeerAudioTrack(peer.pc, null, logLocalDebug);
        }
        if ('audioSession' in navigator && (navigator as unknown as { audioSession?: { type: string } }).audioSession) {
          try {
            (navigator as unknown as { audioSession: { type: string } }).audioSession.type = 'playback';
          } catch { /* ignore */ }
        }
      } else {
        if (localStreamRef.current) {
          localStreamRef.current.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
        }
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
          try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { /* ignore */ }
        }
      }
    }
  }, [addSystemMessage, applyVoiceGate, connectLocalMeter, getSendTrack, logLocalDebug, peersRef, showToast, username, verifyMicProcessing]);

  const toggleMicrophone = useCallback((): void => {
    setMicrophoneMuted(!isMicMutedRef.current, false);
  }, [setMicrophoneMuted]);

  const handleUpdateAudioSettings = useCallback(async (newSettings: Partial<AudioSettings>): Promise<void> => {
    const enforcedSettings: AudioSettings = {
      ...audioSettingsRef.current,
      ...newSettings,
      ...MIC_PROCESSING
    };
    setAudioSettings(enforcedSettings);
    audioSettingsRef.current = enforcedSettings;
    saveAudioSettings(enforcedSettings);
    applyVoiceGate();

    if (newSettings.inputMode === 'ptt' && !isMicMutedRef.current) {
      await setMicrophoneMuted(true, true);
      return;
    }

    if (isAudioUpdatingRef.current) {
      return;
    }
    isAudioUpdatingRef.current = true;

    try {
      const wasMuted = isMicMutedRef.current;
      const currentStream = localStreamRef.current;
      const deviceId = enforcedSettings.inputDeviceId || '';

      if (localSourceNodeRef.current) {
        try { localSourceNodeRef.current.disconnect(); } catch { /* ignore */ }
        localSourceNodeRef.current = null;
      }

      micPipeline.teardown();
      if (currentStream) {
        try {
          currentStream.getTracks().forEach((t) => t.stop());
        } catch { /* ignore */ }
        localStreamRef.current = null;
      }

      if (wasMuted) {
        for (const peer of peersRef.current.values()) {
          await replacePeerAudioTrack(peer.pc, null, logLocalDebug);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 80));

      const wantIsolation = Boolean(enforcedSettings.voiceIsolation);
      const useDevice = await resolveDevice('audioinput', deviceId, enforcedSettings.inputDeviceLabel);
      const newStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(useDevice || undefined, { voiceIsolation: wantIsolation }));
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) {
        throw new Error('No audio track returned from microphone');
      }
      newTrack.enabled = true;
      localStreamRef.current = newStream;
      micIsolationRequestedRef.current = wantIsolation;
      micDeviceRequestedRef.current = deviceId;

      await verifyMicProcessing(newTrack);

      const sendTrack = await getSendTrack(newStream);
      connectLocalMeter(sendTrack);

      await Promise.all([...peersRef.current.values()].map((peer) => replacePeerAudioTrack(peer.pc, sendTrack, logLocalDebug)));
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logLocalDebug('AUDIO_SETTINGS_UPDATE_ERR', errMessage);
      showToast('⚠️ Could not update audio settings: ' + errMessage);
    } finally {
      isAudioUpdatingRef.current = false;
    }
  }, [applyVoiceGate, connectLocalMeter, getSendTrack, logLocalDebug, peersRef, setMicrophoneMuted, showToast, verifyMicProcessing]);

  const selectOutputDevice = useCallback(async (deviceId: string, label = ''): Promise<boolean> => {
    const next: AudioSettings = { ...audioSettingsRef.current, outputDeviceId: deviceId || '', outputDeviceLabel: deviceId ? label : '' };
    setAudioSettings(next);
    audioSettingsRef.current = next;
    saveAudioSettings(next);
    const ok = await setOutputDevice(next.outputDeviceId);
    if (!ok) showToast('⚠️ That speaker isn\'t available: playing through the default one.');
    return ok;
  }, [showToast]);

  useEffect(() => {
    const { outputDeviceId, outputDeviceLabel } = audioSettingsRef.current;
    if (outputDeviceId) resolveDevice('audiooutput', outputDeviceId, outputDeviceLabel).then((id) => setOutputDevice(id));
  }, []);

  const reopenMicRef = useRef<(() => void) | null>(null);
  reopenMicRef.current = (): void => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (isMicMutedRef.current || !track || track.readyState !== 'ended') return;
    showToast('🎙️ Microphone changed: using the system default.');
    handleUpdateAudioSettings(audioSettingsRef.current);
  };
  useEffect(() => onDevicesChanged(() => setTimeout(() => reopenMicRef.current?.(), 300)), []);

  const handlePttPressStart = useCallback((): void => {
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

  const handlePttPressEnd = useCallback((): void => {
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

  const toggleBlockAudio = useCallback((): void => {
    setIsAudioBlocked((prev) => {
      const nextVal = !prev;
      isAudioBlockedRef.current = nextVal;

      for (const [pId, peer] of peersRef.current.entries()) {
        const isLocalMuted = Boolean(localMutedPeersRef.current[pId]);
        const vol = peerVolumesRef.current[pId] !== undefined ? peerVolumesRef.current[pId] : 1.0;
        const effective = nextVal || isLocalMuted ? 0 : vol;
        if (peer.audioElement) {
          peer.audioElement.muted = effective === 0;
          peer.audioElement.volume = Math.min(1.0, effective);
        }
        if (peer.screenAudioElement) {
          peer.screenAudioElement.muted = effective === 0;
          peer.screenAudioElement.volume = Math.min(1.0, effective);
        }
        if (peer.webAudioGain) {
          peer.webAudioGain.gain.value = effective;
        }
      }

      if (nextVal) {
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
            try { peer.dataChannel.send(JSON.stringify(voiceMsg)); } catch { /* ignore */ }
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
  }, [addSystemMessage, peersRef, showToast, username]);

  // Real-time Voice Activity Detection (VAD) & Speaking Rings Sampling Loop
  useEffect(() => {
    const buffer = new Uint8Array(128);
    const interval = setInterval(() => {
      const micLive = !isMicMutedRef.current && localAnalyserRef.current;
      if (!micLive && peersRef.current.size === 0 && speakingActivity.isIdle()) return;

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
        } catch { /* ignore */ }
      }

      const activityMap: Record<string, { isSpeaking: boolean; level: number }> = {};
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
  }, [peersRef]);

  const handleSetPeerVolume = useCallback((peerId: string, vol: number): void => {
    const clamped = Math.max(0, Math.min(2.0, Math.round(vol * 100) / 100));
    setPeerVolumes((prev) => ({
      ...prev,
      [peerId]: clamped
    }));
    peerVolumesRef.current[peerId] = clamped;

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
      if (entry.screenAudioElement) {
        entry.screenAudioElement.volume = Math.min(1.0, effective);
        entry.screenAudioElement.muted = effective === 0;
      }
    }
  }, [peersRef]);

  const handleToggleMutePeer = useCallback((peerId: string): void => {
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
        if (entry.screenAudioElement) {
          entry.screenAudioElement.volume = Math.min(1.0, effective);
          entry.screenAudioElement.muted = effective === 0;
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
  }, [addSystemMessage, peerMetadata, peersRef, showToast]);

  const resetVoice = useCallback((): void => {
    micPipeline.teardown();
    try {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    } catch { /* ignore */ }
    localStreamRef.current = null;
    for (const ref of [localSourceNodeRef, localAnalyserRef]) {
      try { ref.current?.disconnect(); } catch { /* ignore */ }
      ref.current = null;
    }
    setIsMicMuted(true);
    setIsAudioBlocked(false);
    setPeerVoiceStates({});
    setPeerVolumes({});
    setLocalMutedPeers({});
    speakingActivity.clearPeers();
    speakingActivity.resetLocal();
  }, []);

  return {
    selectOutputDevice,
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
    handleToggleMutePeer,
    resetVoice
  };
}
