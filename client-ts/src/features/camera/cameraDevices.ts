/**
 * Which camera to use (the picker next to the camera button). The choice is remembered in this
 * browser; '' means the system's default camera. A remembered camera that isn't plugged in falls
 * back to the default, so the button always works.
 */

/** localStorage key of the chosen camera's deviceId ('' or missing: the default). */
export const CAMERA_DEVICE_KEY = '3rtc_camera_device';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/** The remembered camera ('' for the default). */
export function readCameraChoice(): string {
  try {
    return localStorage.getItem(CAMERA_DEVICE_KEY) || '';
  } catch {
    return '';
  }
}

/** Remembers the chosen camera ('' for the default). */
export function saveCameraChoice(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(CAMERA_DEVICE_KEY, deviceId);
    else localStorage.removeItem(CAMERA_DEVICE_KEY);
  } catch {
    // private mode: the choice lasts for this visit only
  }
}

/**
 * The cameras from `enumerateDevices`, named. Browsers hide names until a camera has been
 * allowed once: then they're "Camera 1", "Camera 2"…
 */
export function camerasOf(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): CameraDevice[] {
  return devices
    .filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label?.trim() || `Camera ${i + 1}` }));
}

/** The camera to open: the remembered one if it's plugged in, else the default (''). */
export function cameraToOpen(choice: string, cameras: readonly CameraDevice[]): string {
  return choice && cameras.some((c) => c.deviceId === choice) ? choice : '';
}

/** Lists the cameras now (empty when the browser can't). */
export async function listCameras(): Promise<CameraDevice[]> {
  try {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return [];
    return camerasOf(await md.enumerateDevices());
  } catch {
    return [];
  }
}

/** Calls `handler` when a camera is plugged in or out; returns the unsubscribe. */
export function onCameraListChange(handler: () => void): () => void {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!md?.addEventListener) return () => {};
  md.addEventListener('devicechange', handler);
  return () => md.removeEventListener('devicechange', handler);
}
