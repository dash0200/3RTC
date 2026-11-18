import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraConstraints,
  cameraTransceiverOf,
  isCameraTransceiver,
  limitCameraSender,
  screenTransceiverOf,
  videoTransceivers,
  CAMERA_LIMITS
} from '../../src/webrtc/cameraLine.ts';
import { SELF_CAMERA, nextSpotlight, spotlightStream } from '../../src/features/camera/spotlight.ts';
import { camerasOf, cameraToOpen } from '../../src/features/camera/cameraDevices.ts';

// Just enough of RTCRtpTransceiver for the line rules
const line = (kind: 'audio' | 'video', stopped = false) =>
  ({ receiver: { track: { kind } }, sender: {}, stopped }) as unknown as RTCRtpTransceiver;
const pcWith = (lines: RTCRtpTransceiver[]) => ({ getTransceivers: () => lines });

describe('camera line', () => {
  it('the first video line is the screen, the second the camera', () => {
    const voice = line('audio');
    const screen = line('video');
    const screenSound = line('audio');
    const camera = line('video');
    const pc = pcWith([voice, screen, screenSound, camera]);
    assert.equal(screenTransceiverOf(pc), screen);
    assert.equal(cameraTransceiverOf(pc), camera);
    assert.equal(isCameraTransceiver(pc, camera), true);
    assert.equal(isCameraTransceiver(pc, screen), false, 'the screen is never taken for the camera');
    assert.equal(isCameraTransceiver(pc, voice), false);
  });

  it('a connection without the camera line (an older app) has no camera', () => {
    const screen = line('video');
    const pc = pcWith([line('audio'), screen]);
    assert.equal(cameraTransceiverOf(pc), null);
    assert.equal(isCameraTransceiver(pc, screen), false);
    assert.equal(cameraTransceiverOf(null), null);
    assert.deepEqual(videoTransceivers({}), []);
  });

  it('stopped lines are left out', () => {
    const screen = line('video');
    const camera = line('video');
    const pc = pcWith([line('video', true), screen, camera]);
    assert.equal(screenTransceiverOf(pc), screen);
    assert.equal(cameraTransceiverOf(pc), camera);
  });

  it('opens a small camera: 640×360 at most 24 frames a second, no sound', () => {
    const c = cameraConstraints();
    assert.equal(c.audio, false);
    const v = c.video as MediaTrackConstraints;
    assert.deepEqual(v.width, { ideal: 640 });
    assert.deepEqual(v.height, { ideal: 360 });
    assert.deepEqual(v.frameRate, { ideal: 24, max: 24 });
    assert.deepEqual(v.facingMode, 'user');
    assert.deepEqual((cameraConstraints('cam-2').video as MediaTrackConstraints).deviceId, { exact: 'cam-2' });
  });

  it('caps what the camera line sends, once', async () => {
    let params: RTCRtpSendParameters = { encodings: [] } as unknown as RTCRtpSendParameters;
    let sets = 0;
    const sender = {
      getParameters: () => params,
      setParameters: async (p: RTCRtpSendParameters) => { params = p; sets++; }
    } as unknown as RTCRtpSender;
    await limitCameraSender(sender);
    assert.equal(params.encodings[0].maxBitrate, CAMERA_LIMITS.maxBitrate);
    assert.equal(params.encodings[0].maxFramerate, CAMERA_LIMITS.frameRate);
    await limitCameraSender(sender);
    assert.equal(sets, 1, 'not set again when already capped');
    await limitCameraSender(null);
    await limitCameraSender({ getParameters: () => { throw new Error('closed'); }, setParameters: async () => {} } as unknown as RTCRtpSender);
  });
});

describe('camera on the stage', () => {
  const mine = { id: 'mine' } as unknown as MediaStream;
  const anna = { id: 'anna' } as unknown as MediaStream;
  const remote = [{ peerId: 'p-anna', stream: anna }];

  it('a click shows that camera; a second click on it takes it off; another click swaps', () => {
    assert.equal(nextSpotlight(null, 'p-anna'), 'p-anna');
    assert.equal(nextSpotlight('p-anna', 'p-anna'), null);
    assert.equal(nextSpotlight('p-anna', SELF_CAMERA), SELF_CAMERA);
  });

  it('finds the picture for ours and for theirs', () => {
    assert.equal(spotlightStream(SELF_CAMERA, mine, remote), mine);
    assert.equal(spotlightStream('p-anna', mine, remote), anna);
    assert.equal(spotlightStream(null, mine, remote), null);
  });

  it('nothing to show once that camera is gone (the stage comes back)', () => {
    assert.equal(spotlightStream('p-anna', mine, []), null, 'they turned it off or left');
    assert.equal(spotlightStream(SELF_CAMERA, null, remote), null, 'ours turned off');
  });
});

describe('camera picker', () => {
  it('lists cameras only, named, with a stand-in name until the browser shows names', () => {
    const list = camerasOf([
      { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      { kind: 'videoinput', deviceId: 'cam1', label: 'HD Webcam' },
      { kind: 'videoinput', deviceId: 'cam2', label: '' },
      { kind: 'videoinput', deviceId: '', label: '' }
    ]);
    assert.deepEqual(list, [
      { deviceId: 'cam1', label: 'HD Webcam' },
      { deviceId: 'cam2', label: 'Camera 2' }
    ]);
  });

  it('opens the remembered camera if it is plugged in, else the default', () => {
    const cams = [{ deviceId: 'cam1', label: 'A' }, { deviceId: 'cam2', label: 'B' }];
    assert.equal(cameraToOpen('cam2', cams), 'cam2');
    assert.equal(cameraToOpen('gone', cams), '', 'unplugged: the default');
    assert.equal(cameraToOpen('', cams), '');
  });
});
