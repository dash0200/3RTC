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
