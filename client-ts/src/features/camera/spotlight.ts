/**
 * A camera on the stage, for this viewer only (features/camera/CameraStage.tsx). Clicking a camera
 * tile puts it in the stage, where videos play; nothing is sent, so nobody else's screen changes.
 * Whatever was on the stage keeps running under it (a video keeps its sound and stays in sync).
 *
 * The key is a peer id, or `SELF_CAMERA` for our own camera.
 */

/** The key of our own camera on the stage. */
export const SELF_CAMERA = 'me';

/** Someone's camera (as `RemoteCamera` in useCamera.ts; kept here so this file needs no React). */
export interface CameraPicture {
  peerId: string;
  stream: MediaStream;
}

/** What a click on a tile does: show that camera on the stage, or take it off if it's already there. */
export function nextSpotlight(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * The picture for the camera on the stage, or null when there's none to show: nothing chosen, or
 * that camera has gone (turned off, or the person left). Then the stage goes back by itself.
 */
export function spotlightStream(
  key: string | null,
  localStream: MediaStream | null,
  remote: readonly CameraPicture[]
): MediaStream | null {
  if (!key) return null;
  if (key === SELF_CAMERA) return localStream;
  return remote.find((c) => c.peerId === key)?.stream ?? null;
}
