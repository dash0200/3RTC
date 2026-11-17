/**
 * Webcam video on a peer connection (docs/PROTOCOL.md, "Webcam").
 *
 * Every connection has one video line from the start: the shared screen. Between two apps that both
 * say `camera: true` in peer-identity, the side that made the connection adds a second video line
 * once, and sends a new offer for it. Its line order is fixed, so both ends agree: the first video
 * line is the screen, the next one the camera. Turning the camera on or off only swaps the track on
 * that line (nothing is sent while it's off), so there's no new offer each time.
 *
 * Older apps don't say `camera`, never get the line, and work as before (they take any incoming
 * video for the shared screen, which is why the line must never reach them).
 */

/** Sent in peer-identity: "I understand the camera line". */
export const CAMERA_CAPABILITY_FIELD = 'camera';

/** What a camera sends: small and light, so a 4-person room stays easy on phones and uploads. */
export const CAMERA_LIMITS = {
  width: 640,
  height: 360,
  frameRate: 24,
  maxBitrate: 350_000
} as const;

type TransceiverLike = Pick<RTCRtpTransceiver, 'receiver' | 'sender'> & { stopped?: boolean; currentDirection?: string | null };
type PcLike = { getTransceivers?: () => TransceiverLike[] };

/** The video lines in their fixed order (stopped ones left out). */
export function videoTransceivers<T extends TransceiverLike>(pc: { getTransceivers?: () => T[] } | null | undefined): T[] {
  if (!pc?.getTransceivers) return [];
  return pc
    .getTransceivers()
    .filter((t) => t.receiver?.track?.kind === 'video' && !t.stopped && t.currentDirection !== 'stopped');
}

/** The shared screen's line: the first video line. */
export function screenTransceiverOf<T extends TransceiverLike>(pc: { getTransceivers?: () => T[] } | null | undefined): T | null {
  return videoTransceivers(pc)[0] ?? null;
}

/** The camera's line: the second video line, once added. */
export function cameraTransceiverOf<T extends TransceiverLike>(pc: { getTransceivers?: () => T[] } | null | undefined): T | null {
  return videoTransceivers(pc)[1] ?? null;
}

/** Whether `t` is the camera's line on `pc`. */
export function isCameraTransceiver(pc: PcLike | null | undefined, t: TransceiverLike | null | undefined): boolean {
  return Boolean(t) && cameraTransceiverOf(pc) === t;
}

/** The constraints for opening the camera. */
export function cameraConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      width: { ideal: CAMERA_LIMITS.width },
      height: { ideal: CAMERA_LIMITS.height },
      frameRate: { ideal: CAMERA_LIMITS.frameRate, max: CAMERA_LIMITS.frameRate }
    }
  };
}

/** Caps what the camera line sends (bitrate and frame rate). Failures are ignored. */
export async function limitCameraSender(sender: RTCRtpSender | null | undefined): Promise<void> {
  if (!sender?.getParameters || !sender.setParameters) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const enc = params.encodings[0];
    if (enc.maxBitrate === CAMERA_LIMITS.maxBitrate && enc.maxFramerate === CAMERA_LIMITS.frameRate) return;
    enc.maxBitrate = CAMERA_LIMITS.maxBitrate;
    enc.maxFramerate = CAMERA_LIMITS.frameRate;
    await sender.setParameters(params);
  } catch {
    // not supported here: the capture size and frame rate still keep it small
  }
}
