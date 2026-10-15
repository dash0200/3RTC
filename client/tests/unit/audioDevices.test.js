import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicesToLists, matchDevice } from '../../src/utils/audioDevices.js';

const dev = (kind, deviceId, label) => ({ kind, deviceId, label });

test('Chrome: the default device first, then the others; no duplicates, no "communications"', () => {
    const lists = devicesToLists([
        dev('audioinput', 'default', 'Default - Headset Mic'),
        dev('audioinput', 'communications', 'Communications - Headset Mic'),
        dev('audioinput', 'aaa', 'Headset Mic'),
        dev('audioinput', 'bbb', 'Webcam Mic'),
        dev('videoinput', 'cam', 'Webcam'),
        dev('audiooutput', 'default', 'Default - Speakers'),
        dev('audiooutput', 'ccc', 'Speakers'),
        dev('audiooutput', 'ddd', 'Headphones')
    ]);
    assert.deepEqual(lists.inputs, [{ id: '', label: 'Default - Headset Mic' }, { id: 'aaa', label: 'Headset Mic' }, { id: 'bbb', label: 'Webcam Mic' }]);
    assert.deepEqual(lists.outputs.map((d) => d.id), ['', 'ccc', 'ddd']);
    assert.equal(lists.labelsHidden, false);
});

test('Firefox / no permission yet: a "System default" entry, numbered names, labels hidden', () => {
    const lists = devicesToLists([dev('audioinput', 'x1', ''), dev('audioinput', 'x2', '')]);
    assert.deepEqual(lists.inputs, [{ id: '', label: 'System default' }, { id: 'x1', label: 'Microphone 1' }, { id: 'x2', label: 'Microphone 2' }]);
    assert.deepEqual(lists.outputs, [{ id: '', label: 'System default' }]);
    assert.equal(lists.labelsHidden, true);
});

test('a chosen device is found by its id, else by its name, else the default', () => {
    const list = [{ id: '', label: 'Default' }, { id: 'new-id', label: 'Headphones' }];
    assert.equal(matchDevice(list, 'new-id', 'Headphones'), 'new-id');
    assert.equal(matchDevice(list, 'old-id', 'Headphones'), 'new-id');
    assert.equal(matchDevice(list, 'old-id', 'Unplugged thing'), '');
    assert.equal(matchDevice(list, '', 'Headphones'), '');
});
