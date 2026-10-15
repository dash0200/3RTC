/** Load a provider's player script once (resolves when `globalName` exists). */
const pending = new Map();

export function loadScript(src, globalName, timeoutMs = 15000) {
    if (typeof window !== 'undefined' && window[globalName]) return Promise.resolve(window[globalName]);
    if (pending.has(src)) return pending.get(src);
    const p = new Promise((resolve, reject) => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.async = true;
        const timer = setTimeout(() => reject(new Error(`${globalName} player didn't load`)), timeoutMs);
        tag.onload = () => {
            clearTimeout(timer);
            if (window[globalName]) resolve(window[globalName]);
            else reject(new Error(`${globalName} player didn't load`));
        };
        tag.onerror = () => {
            clearTimeout(timer);
            pending.delete(src);
            reject(new Error(`${globalName} player couldn't be reached`));
        };
        document.head.appendChild(tag);
    });
    pending.set(src, p);
    return p;
}
