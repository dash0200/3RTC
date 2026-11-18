/**
 * Webcam: turn ours on and off, and keep everyone's camera (docs/PROTOCOL.md, "Webcam").
 *
 * The picture travels on each connection's camera line (webrtc/cameraLine.ts); `camera-status
 * { on }` says whether someone's camera is on, sent to everyone when it changes and to each newcomer.
 * A tile shows only when both are there: the status says on, and the picture has arrived.
 * Nothing is opened or sent until you turn yours on.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePeerMessageOn } from '../../core/RoomContext';
import { cameraConstraints } from '../../webrtc/cameraLine';
import { cameraToOpen, listCameras, onCameraListChange, readCameraChoice, saveCameraChoice, type CameraDevice } from './cameraDevices';
import type { RoomBus } from '../../types';

export interface RemoteCamera {
  peerId: string;
  stream: MediaStream;
}

export interface UseCameraReturn {
  /** Our camera is on */
  isOn: boolean;
  /** Opening it (waiting for permission) */
  isStarting: boolean;
  localStream: MediaStream | null;
  /** People whose camera is on and whose picture is here, in the order they turned it on */
  remote: RemoteCamera[];
  toggle: () => void;
  stop: () => void;
  /** The cameras plugged in (named once a camera has been allowed) */
  cameras: CameraDevice[];
  /** The chosen camera's deviceId ('' : the default) */
  deviceId: string;
  /** Choose a camera ('' : the default); while on, the picture switches to it */
  selectDevice: (deviceId: string) => void;
  /** Read the list again (when the picker opens) */
  refreshCameras: () => void;
}

const NOOP_BUS = { on: () => () => {} } as unknown as RoomBus;

/** Why the camera couldn't open, in words for a toast. */
export function cameraErrorText(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera blocked: allow it in your browser’s site settings';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy in another app';
  return 'Couldn’t start the camera';
}

export function useCamera(bus: RoomBus | null | undefined, notify: (text: string) => void): UseCameraReturn {
  const [isOn, setIsOn] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<RemoteCamera[]>([]);
  const localRef = useRef<MediaStream | null>(null);
  // Per peer: the picture (once its track arrived) and whether they say it's on
  const streamsRef = useRef<Map<string, MediaStream>>(new Map());
  const onRef = useRef<Set<string>>(new Set());
  const orderRef = useRef<string[]>([]);
  const startingRef = useRef(false);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => readCameraChoice());
  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;

  const refreshCameras = useCallback(() => {
    void listCameras().then((list) => setCameras(list));
  }, []);
  useEffect(() => {
    refreshCameras();
    return onCameraListChange(refreshCameras);
  }, [refreshCameras]);

  /** Opens the chosen camera (the default when it isn't plugged in, or won't open). */
  const openCamera = useCallback(async (): Promise<MediaStream> => {
    const id = cameraToOpen(deviceIdRef.current, await listCameras());
    try {
      return await navigator.mediaDevices.getUserMedia(cameraConstraints(id || undefined));
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : '';
      if (!id || (name !== 'NotFoundError' && name !== 'OverconstrainedError' && name !== 'NotReadableError')) throw err;
      return navigator.mediaDevices.getUserMedia(cameraConstraints());
    }
  }, []);

  /** Wires a newly opened camera in as ours (the first time, or after switching cameras). */
  const takeStream = useCallback((stream: MediaStream, onEnded: () => void): MediaStreamTrack => {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    try {
      track.contentHint = 'motion';
    } catch {
      // not supported: fine
    }
    // The camera unplugged or taken by the system: treat as off
    track.onended = () => {
      if (localRef.current === stream) onEnded();
    };
    localRef.current = stream;
    setLocalStream(stream);
    return track;
  }, []);

  const refresh = useCallback(() => {
    const list: RemoteCamera[] = [];
    for (const peerId of orderRef.current) {
      const stream = streamsRef.current.get(peerId);
      if (stream && onRef.current.has(peerId)) list.push({ peerId, stream });
    }
    setRemote((prev) =>
      prev.length === list.length && prev.every((p, i) => p.peerId === list[i].peerId && p.stream === list[i].stream)
        ? prev
        : list
    );
  }, []);

  const stop = useCallback(() => {
    const stream = localRef.current;
    localRef.current = null;
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // already stopped
        }
      }
    }
    setLocalStream(null);
    setIsOn(false);
    if (bus && stream) {
      bus.emitEvent('set-camera-track', null);
      bus.broadcast('camera-status', { type: 'camera-status', on: false });
    }
  }, [bus]);

  const start = useCallback(async () => {
    if (!bus || startingRef.current || localRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      notify('This browser can’t use a camera');
      return;
    }
    startingRef.current = true;
    setIsStarting(true);
    try {
      const stream = await openCamera();
      const track = takeStream(stream, stop);
      setIsOn(true);
      bus.emitEvent('set-camera-track', track);
      bus.broadcast('camera-status', { type: 'camera-status', on: true });
      refreshCameras(); // names show once a camera is allowed
    } catch (err: unknown) {
      notify(cameraErrorText(err));
    } finally {
      startingRef.current = false;
      setIsStarting(false);
    }
  }, [bus, notify, stop, openCamera, takeStream, refreshCameras]);

  const selectDevice = useCallback((id: string) => {
    saveCameraChoice(id);
    deviceIdRef.current = id;
    setDeviceId(id);
    const old = localRef.current;
    if (!bus || !old || startingRef.current) return;
    // On now: open the new one, swap the picture on every connection, then close the old one
    // (camera-status stays on; nobody sees it go off)
    startingRef.current = true;
    setIsStarting(true);
    void (async () => {
      try {
        // some cameras can't be open twice at once: close the old one first
        for (const t of old.getTracks()) t.stop();
        const stream = await openCamera();
        if (localRef.current !== old) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        bus.emitEvent('set-camera-track', takeStream(stream, stop));
      } catch (err: unknown) {
        notify(cameraErrorText(err));
        if (localRef.current === old) stop();
      } finally {
        startingRef.current = false;
        setIsStarting(false);
      }
    })();
  }, [bus, notify, stop, openCamera, takeStream]);

  const toggle = useCallback(() => {
    if (localRef.current) stop();
    else void start();
  }, [start, stop]);

  useEffect(() => {
    if (!bus) return undefined;
    const forget = (peerId: string) => {
      streamsRef.current.delete(peerId);
      onRef.current.delete(peerId);
      orderRef.current = orderRef.current.filter((p) => p !== peerId);
      refresh();
    };
    const offStream = bus.onEvent<{ peerId: string; stream: MediaStream }>('remote-camera-stream', ({ peerId, stream }) => {
      streamsRef.current.set(peerId, stream);
      refresh();
    });
    const offClose = bus.onEvent<string>('peer-close', forget);
    // A newcomer learns whether our camera is on
    const offOpen = bus.onEvent<string>('peer-open', (peerId) => {
      if (localRef.current) bus.send(peerId, 'camera-status', { type: 'camera-status', on: true });
    });
    const offLeft = bus.onEvent('room-left', () => {
      stop();
      streamsRef.current.clear();
      onRef.current.clear();
      orderRef.current = [];
      refresh();
    });
    return () => {
      offStream();
      offClose();
      offOpen();
      offLeft();
    };
  }, [bus, refresh, stop]);

  // Stop the camera when this view goes away (leaving the app)
  useEffect(() => () => {
    const stream = localRef.current;
    if (stream) for (const t of stream.getTracks()) t.stop();
  }, []);

  usePeerMessageOn<{ on?: unknown }>(bus ?? NOOP_BUS, 'camera-status', (data, from) => {
    if (!from) return;
    if (data?.on === true) {
      if (!onRef.current.has(from)) {
        onRef.current.add(from);
        orderRef.current = [...orderRef.current.filter((p) => p !== from), from];
      }
    } else {
      onRef.current.delete(from);
    }
    refresh();
  });

  return { isOn, isStarting, localStream, remote, toggle, stop, cameras, deviceId, selectDevice, refreshCameras };
}
