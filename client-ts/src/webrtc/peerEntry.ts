/**
 * Helpers for one peer's connection entry (the object kept per peer in peersRef):
 * { pc, dataChannel, bulkChannel, audioElement, webAudioSource, webAudioGain, analyserNode, ... }
 */

export interface PeerEntryRecord {
  pc?: RTCPeerConnection | null;
  dataChannel?: RTCDataChannel | null;
  bulkChannel?: RTCDataChannel | null;
  isConnected?: boolean;
  candidateQueue?: RTCIceCandidateInit[];
  audioElement?: HTMLAudioElement | null;
  screenAudioElement?: HTMLAudioElement | null;
  remoteScreenAudioStream?: MediaStream | null;
  audioTransceiver?: RTCRtpTransceiver | null;
  videoTransceiver?: RTCRtpTransceiver | null;
  isInitiator?: boolean;
  applyingRemote?: boolean;
  recoveryTimer?: ReturnType<typeof setTimeout> | number | null;
  restartAttempts?: number;
  brokenSince?: number;
  wasInterrupted?: boolean;
  signalingGone?: boolean;
  rebuilt?: boolean;
  webAudioSource?: MediaStreamAudioSourceNode | null;
  webAudioGain?: GainNode | null;
  analyserNode?: AnalyserNode | null;
  byeReceived?: boolean;
  reconnecting?: boolean;
  failedCount?: number;
  iceFailedAt?: number;
  localCandidateTypes?: Set<string>;
  /** ICE candidate lines we sent and received, for the connection-failure diagnosis. */
  localCandidates?: string[];
  remoteCandidates?: string[];
  [key: string]: unknown;
}

/** Keeps a candidate line for the diagnosis (deduplicated, at most 40). */
export function rememberCandidate(list: string[], line?: string | null): void {
  if (!line || list.length >= 40 || list.includes(line)) return;
  list.push(line);
}

/**
 * Release everything a peer entry holds: its remote audio playback, Web Audio nodes, the
 * reconnect timer, both data channels and the peer connection.
 * With `sayBye`, first tells the peer we are leaving on purpose (so it doesn't try to reconnect).
 */
export function teardownPeerEntry(
  entry?: PeerEntryRecord | null,
  { sayBye = false }: { sayBye?: boolean } = {}
): void {
  if (!entry) return;
  try {
    if (entry.audioElement) {
      entry.audioElement.pause();
      entry.audioElement.srcObject = null;
      try {
        entry.audioElement.remove();
      } catch {
        // ignore
      }
      entry.audioElement = null;
    }
    if (entry.screenAudioElement) {
      entry.screenAudioElement.pause();
      entry.screenAudioElement.srcObject = null;
      try {
        entry.screenAudioElement.remove();
      } catch {
        // ignore
      }
      entry.screenAudioElement = null;
    }
  } catch {
    // ignore
  }

  const audioNodes: Array<'webAudioSource' | 'webAudioGain' | 'analyserNode'> = [
    'webAudioSource',
    'webAudioGain',
    'analyserNode'
  ];
  for (const key of audioNodes) {
    try {
      const node = entry[key];
      if (node) {
        node.disconnect();
        entry[key] = null;
      }
    } catch {
      // ignore
    }
  }

  if (entry.recoveryTimer) {
    clearTimeout(entry.recoveryTimer);
    entry.recoveryTimer = null;
  }

  if (sayBye) {
    try {
      if (entry.dataChannel?.readyState === 'open') {
        entry.dataChannel.send(JSON.stringify({ type: 'peer-bye' }));
      }
    } catch {
      // ignore
    }
  }

  try {
    entry.dataChannel?.close();
  } catch {
    // ignore
  }
  try {
    entry.bulkChannel?.close();
  } catch {
    // ignore
  }
  try {
    entry.pc?.close();
  } catch {
    // ignore
  }
}

/**
 * Put `track` (or null for silence) on the audio sender of a peer connection, making the audio
 * transceiver send+receive. Resolves when done; failures are passed to `log` and swallowed.
 */
export function replacePeerAudioTrack(
  pc?: RTCPeerConnection | null,
  track?: MediaStreamTrack | null,
  log: (tag: string, detail: string) => void = () => {}
): Promise<void> {
  if (!pc || pc.connectionState === 'closed') return Promise.resolve();
  const promises: Promise<unknown>[] = [];
  const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
  let replaced = false;

  for (const t of transceivers) {
    const isValid = t.mid !== null || transceivers.length === 1;
    if (isValid && t.sender && (!t.sender.track || t.sender.track.kind === 'audio')) {
      if (track) t.direction = 'sendrecv';
      promises.push(
        t.sender
          .replaceTrack(track ?? null)
          .then(() => log('REPLACETRACK_OK', `audio track replaced on transceiver mid: ${t.mid}`))
          .catch((err: Error) => log('REPLACETRACK_ERR', err.message))
      );
      replaced = true;
    }
  }

  if (!replaced && pc.getSenders) {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind === 'audio') {
        promises.push(
          s
            .replaceTrack(track ?? null)
            .then(() => log('SENDER_REPLACETRACK_OK', 'audio track replaced on sender'))
            .catch((err: Error) => log('SENDER_REPLACETRACK_ERR', err.message))
        );
      }
    }
  }

  return Promise.all(promises).then(() => {});
}
