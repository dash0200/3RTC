/**
 * Microphone and speaker selection (like Discord's Input / Output device).
 *
 * Input: the chosen mic's deviceId goes into getUserMedia (see audioSettings.buildMicConstraints);
 * `ideal`, so an unplugged mic falls back to the system default instead of failing.
 *
 * Output: every <audio> / <video> in the page (voices, local and link videos) and the app's sound
 * contexts (chimes, soundboard) play through the chosen speaker (setSinkId). New media elements are
 * picked up as they appear. Embedded players in iframes (YouTube, Vimeo, Twitch) can't be redirected
 * by the page: they follow the system's output. Browsers without setSinkId (Safari, iPhone) have no
 * output choice.
 */

const DEFAULT = '';

let outputId = DEFAULT;
const contexts = new Set();
let observer = null;

export const canPickOutput = () => {
    try {
        return typeof HTMLMediaElement !== 'undefined' && typeof HTMLMediaElement.prototype.setSinkId === 'function';
    } catch {
        return false;
    }
};

/** Firefox lists speakers only after the person picks one in its own prompt. */
export const needsOutputPrompt = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.selectAudioOutput === 'function';

/**
 * The devices: { inputs: [{ id, label }], outputs: [{ id, label }], labelsHidden }
 * Labels are empty until the page may use the mic; then `labelsHidden` is true.
 */
export async function listAudioDevices() {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md?.enumerateDevices) return { inputs: [], outputs: [], labelsHidden: false };
    let devices = [];
    try {
        devices = await md.enumerateDevices();
    } catch {
        return { inputs: [], outputs: [], labelsHidden: false };
    }
    return devicesToLists(devices);
}

/** (pure, for tests) enumerateDevices() result -> lists for the pickers */
export function devicesToLists(devices) {
    const pick = (kind, fallback) => {
        const seen = new Set();
        const out = [];
        let n = 0;
        for (const d of devices) {
            if (d.kind !== kind || !d.deviceId || seen.has(d.deviceId)) continue;
            // Chrome lists the default device twice: as 'default' ("Default - X") and as X itself
            if (d.deviceId === 'communications') continue;
            seen.add(d.deviceId);
            n++;
            out.push({ id: d.deviceId === 'default' ? DEFAULT : d.deviceId, label: d.label || `${fallback} ${n}` });
        }
        if (!out.some((d) => d.id === DEFAULT)) out.unshift({ id: DEFAULT, label: 'System default' });
        // The default first, the rest by name
        return [out.find((d) => d.id === DEFAULT), ...out.filter((d) => d.id !== DEFAULT)];
    };
    const labelsHidden = devices.some((d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && !d.label);
    return { inputs: pick('audioinput', 'Microphone'), outputs: pick('audiooutput', 'Speaker'), labelsHidden };
}

/**
 * The id to use now for a device chosen earlier: the same id if it's there, else the device with
 * the same name (browsers can change ids, e.g. when the site's mic permission isn't kept), else ''
 * (the system default). (pure: `list` is from devicesToLists)
 */
export function matchDevice(list, id, label) {
    if (!id) return '';
    if (list.some((d) => d.id === id)) return id;
    const byName = label ? list.find((d) => d.id && d.label === label) : null;
    return byName ? byName.id : '';
}

/** matchDevice against the devices plugged in now ('audioinput' | 'audiooutput'). */
export async function resolveDevice(kind, id, label) {
    if (!id) return '';
    const lists = await listAudioDevices();
    const list = kind === 'audiooutput' ? lists.outputs : lists.inputs;
    // Nothing listed (no permission to list): try the saved id as it is
    if (list.length <= 1) return id;
    return matchDevice(list, id, label) || id;
}

/** Ask for the mic once so the browser shows device names (the stream is closed right away). */
export async function revealDeviceLabels() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return true;
    } catch {
        return false;
    }
}

/** Firefox: let the person choose a speaker in the browser's prompt. Returns its id, or null. */
export async function promptForOutput() {
    try {
        const device = await navigator.mediaDevices.selectAudioOutput();
        return device?.deviceId || null;
    } catch {
        return null;
    }
}

async function applyTo(target, id) {
    if (!target || typeof target.setSinkId !== 'function') return true;
    if ((target.sinkId || DEFAULT) === id) return true;
    try {
        await target.setSinkId(id);
        return true;
    } catch {
        // Gone (unplugged) or not allowed: play through the default instead
        if (id !== DEFAULT) {
            try { await target.setSinkId(DEFAULT); } catch { /* keep what it had */ }
        }
        return false;
    }
}

const mediaIn = (node) => {
    if (!(node instanceof Element)) return [];
    if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') return [node];
    return node.querySelector?.('audio, video') ? [...node.querySelectorAll('audio, video')] : [];
};

function watchNewMedia() {
    if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    observer = new MutationObserver((records) => {
        if (outputId === DEFAULT) return;
        for (const r of records) for (const node of r.addedNodes) for (const el of mediaIn(node)) applyTo(el, outputId);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

/** The speaker everything plays through ('' = system default). Resolves false if it isn't there. */
export async function setOutputDevice(id = DEFAULT) {
    outputId = id || DEFAULT;
    if (!canPickOutput()) return outputId === DEFAULT;
    watchNewMedia();
    const results = await Promise.all([
        ...[...document.querySelectorAll('audio, video')].map((el) => applyTo(el, outputId)),
        ...[...contexts].map((ctx) => (ctx.state === 'closed' ? (contexts.delete(ctx), true) : applyTo(ctx, outputId)))
    ]);
    return results.every(Boolean);
}

export const getOutputDevice = () => outputId;

/** Play this media element through the chosen speaker (for elements not in the page). */
export const routeMediaElement = (el) => applyTo(el, outputId);

/** Sound effects made with Web Audio: their AudioContext follows the chosen speaker too. */
export function routeAudioContext(ctx) {
    if (!ctx || contexts.has(ctx)) return;
    contexts.add(ctx);
    if (outputId !== DEFAULT) applyTo(ctx, outputId);
}

/** Calls `handler` when a device is plugged in or out. Returns a function to stop. */
export function onDevicesChanged(handler) {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md?.addEventListener) return () => { };
    md.addEventListener('devicechange', handler);
    return () => md.removeEventListener('devicechange', handler);
}
