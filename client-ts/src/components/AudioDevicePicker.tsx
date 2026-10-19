/**
 * Input (microphone) and output (speaker / headphones) choice, like Discord's Voice settings.
 * Used in Audio settings and in the quick menu next to the mic button. Lists update when a
 * device is plugged in or out; a chosen device that's gone shows as "(not connected)".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listAudioDevices,
  revealDeviceLabels,
  canPickOutput,
  needsOutputPrompt,
  promptForOutput,
  onDevicesChanged,
  matchDevice,
  type AudioDeviceLists,
  type AudioDeviceInfo
} from '../utils/audioDevices';
import { sound } from '../utils/sound';
import { useSpeakingActivity } from '../utils/speakingActivity';
import type { AudioSettings } from '../utils/audioSettings';

/** The level of the mic as sent in the call (what others hear). */
function LiveMicMeter() {
  const level = useSpeakingActivity().local.level;
  return (
    <div
      className="audio-device-meter"
      aria-label="Microphone level"
      role="meter"
      aria-valuenow={level}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="audio-device-meter-fill" style={{ width: `${level}%` }} />
    </div>
  );
}

/** Live level (0-100) of a microphone while `active`: its own capture, separate from the call. */
function useMicTestLevel(deviceId: string, active: boolean) {
  const [level, setLevel] = useState<number>(0);
  const [error, setError] = useState<string>('');
  useEffect(() => {
    if (!active) {
      setLevel(0);
      return undefined;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {})
          }
        });
        if (stopped) return;
        setError('');
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioCtx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          setLevel(Math.min(100, Math.round(Math.sqrt(rms) * 160)));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!stopped) setError("Couldn't open this microphone.");
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [deviceId, active]);
  return { level, error };
}

export interface AudioDevicePickerProps {
  audioSettings?: AudioSettings | null;
  onUpdateAudioSettings?: (settings: AudioSettings) => void;
  onSelectOutput?: (id: string, label?: string) => unknown;
  isMicLive?: boolean;
  compact?: boolean;
}

export default function AudioDevicePicker({
  audioSettings,
  onUpdateAudioSettings,
  onSelectOutput,
  isMicLive = false,
  compact = false
}: AudioDevicePickerProps) {
  const [devices, setDevices] = useState<AudioDeviceLists>({
    inputs: [],
    outputs: [],
    labelsHidden: false
  });
  const [testing, setTesting] = useState(false);
  // The chosen devices as listed now (ids can change; the name finds them again)
  const savedInput = audioSettings?.inputDeviceId || '';
  const savedOutput = audioSettings?.outputDeviceId || '';
  const inputId =
    matchDevice(devices.inputs, savedInput, audioSettings?.inputDeviceLabel) || savedInput;
  const outputId =
    matchDevice(devices.outputs, savedOutput, audioSettings?.outputDeviceLabel) || savedOutput;
  // While the call's mic is on, its own meter is shown: a second capture of the same mic could
  // upset the browser's echo cancellation for the call
  const { level, error: testError } = useMicTestLevel(inputId, testing && !isMicLive);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const next = await listAudioDevices();
    if (alive.current) setDevices(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const off = onDevicesChanged(refresh);
    return () => {
      alive.current = false;
      off();
    };
  }, [refresh]);

  const showNames = async () => {
    await revealDeviceLabels();
    refresh();
  };

  const labelOf = (list: AudioDeviceInfo[], id: string) =>
    id ? list.find((d) => d.id === id)?.label || '' : '';
  const chooseInput = (id: string) => {
    if (!audioSettings) return;
    onUpdateAudioSettings?.({
      ...audioSettings,
      inputDeviceId: id,
      inputDeviceLabel: labelOf(devices.inputs, id)
    });
  };
  const chooseOutput = (id: string) => onSelectOutput?.(id, labelOf(devices.outputs, id));
  const promptOutput = async () => {
    const id = await promptForOutput();
    if (id) {
      await chooseOutput(id);
      refresh();
    }
  };

  // A chosen device that isn't plugged in now stays in the list, marked
  const withMissing = (list: AudioDeviceInfo[], id: string, kind: string): AudioDeviceInfo[] =>
    id && !list.some((d) => d.id === id)
      ? [...list, { id, label: `${kind} (not connected: using the default)` }]
      : list;
  const inputs = withMissing(devices.inputs, inputId, 'Chosen microphone');
  const outputsListed = devices.outputs.length > 1 || devices.outputs.some((d) => d.id);
  const outputs = withMissing(devices.outputs, outputId, 'Chosen speaker');
  const outputSupported = canPickOutput();

  return (
    <div className={`audio-device-picker ${compact ? 'is-compact' : ''}`}>
      <label className="audio-device-row">
        <span className="audio-device-label">🎙️ Input device</span>
        <select
          className="audio-device-select"
          value={inputId}
          onChange={(e) => chooseInput(e.target.value)}
          aria-label="Input device (microphone)"
        >
          {inputs.map((d) => (
            <option key={d.id || 'default'} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {!compact && isMicLive && (
        <div className="audio-device-test">
          <LiveMicMeter />
          <span className="audio-device-note">Your mic is on: this is the level others hear.</span>
        </div>
      )}
      {!compact && !isMicLive && (
        <div className="audio-device-test">
          <button
            type="button"
            className={`audio-device-test-btn ${testing ? 'is-on' : ''}`}
            onClick={() => setTesting((t) => !t)}
          >
            {testing ? 'Stop test' : 'Test mic'}
          </button>
          <div
            className="audio-device-meter"
            aria-label="Microphone level"
            role="meter"
            aria-valuenow={level}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="audio-device-meter-fill" style={{ width: `${level}%` }} />
          </div>
          {testError && <span className="audio-device-note is-warn">{testError}</span>}
        </div>
      )}

      {outputSupported && (outputsListed || !needsOutputPrompt()) ? (
        <label className="audio-device-row">
          <span className="audio-device-label">🔊 Output device</span>
          <select
            className="audio-device-select"
            value={outputId}
            onChange={(e) => chooseOutput(e.target.value)}
            aria-label="Output device (speaker or headphones)"
          >
            {outputs.map((d) => (
              <option key={d.id || 'default'} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : outputSupported && needsOutputPrompt() ? (
        <div className="audio-device-row">
          <span className="audio-device-label">🔊 Output device</span>
          <button type="button" className="audio-device-test-btn" onClick={promptOutput}>
            Choose speaker…
          </button>
        </div>
      ) : (
        <div className="audio-device-row">
          <span className="audio-device-label">🔊 Output device</span>
          <span className="audio-device-note">
            This browser plays through your device's current speaker; change it in your system's sound settings.
          </span>
        </div>
      )}
      {outputSupported && !compact && (
        <div className="audio-device-test">
          <button type="button" className="audio-device-test-btn" onClick={() => sound.playChime()}>
            Play test sound
          </button>
          <span className="audio-device-note">
            Voices, local videos and app sounds use this. YouTube, Vimeo and Twitch videos follow your system's output.
          </span>
        </div>
      )}

      {devices.labelsHidden && (
        <button type="button" className="audio-device-names-btn" onClick={showNames}>
          Show device names (asks for microphone access)
        </button>
      )}
    </div>
  );
}
