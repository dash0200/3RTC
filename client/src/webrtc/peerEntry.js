/**
 * Helpers for one peer's connection entry (the object kept per peer in peersRef):
 * { pc, dataChannel, bulkChannel, audioElement, webAudioSource, webAudioGain, analyserNode, ... }
 */

/**
 * Release everything a peer entry holds: its remote audio playback, Web Audio nodes, the
 * reconnect timer, both data channels and the peer connection.
 * With `sayBye`, first tells the peer we are leaving on purpose (so it doesn't try to reconnect).
 */
export function teardownPeerEntry(entry, { sayBye = false } = {}) {
  if (!entry) return;
  try {
    if (entry.audioElement) {
      entry.audioElement.pause();
      entry.audioElement.srcObject = null;
      try { entry.audioElement.remove(); } catch { }
      entry.audioElement = null;
    }
  } catch { }
  for (const key of ['webAudioSource', 'webAudioGain', 'analyserNode']) {
    try {
      if (entry[key]) {
        entry[key].disconnect();
        entry[key] = null;
      }
    } catch { }
  }
  clearTimeout(entry.recoveryTimer);
  entry.recoveryTimer = null;
  if (sayBye) {
    try {
      if (entry.dataChannel?.readyState === 'open') {
        entry.dataChannel.send(JSON.stringify({ type: 'peer-bye' }));
      }
    } catch { }
  }
  try { entry.dataChannel?.close(); } catch { }
  try { entry.bulkChannel?.close(); } catch { }
  try { entry.pc?.close(); } catch { }
}

/**
 * Put `track` (or null for silence) on the audio sender of a peer connection, making the audio
 * transceiver send+receive. Resolves when done; failures are passed to `log` and swallowed.
 */
export function replacePeerAudioTrack(pc, track, log = () => { }) {
  if (!pc || pc.connectionState === 'closed') return Promise.resolve();
  const promises = [];
  const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
  let replaced = false;
  for (const t of transceivers) {
    const isValid = t.mid !== null || transceivers.length === 1;
    if (isValid && t.sender && (!t.sender.track || t.sender.track.kind === 'audio')) {
      if (track) t.direction = 'sendrecv';
      promises.push(
        t.sender.replaceTrack(track)
          .then(() => log('REPLACETRACK_OK', `audio track replaced on transceiver mid: ${t.mid}`))
          .catch((err) => log('REPLACETRACK_ERR', err.message))
      );
      replaced = true;
    }
  }
  if (!replaced && pc.getSenders) {
    for (const s of pc.getSenders()) {
      if (!s.track || s.track.kind === 'audio') {
        promises.push(
          s.replaceTrack(track)
            .then(() => log('SENDER_REPLACETRACK_OK', 'audio track replaced on sender'))
            .catch((err) => log('SENDER_REPLACETRACK_ERR', err.message))
        );
      }
    }
  }
  return Promise.all(promises);
}
