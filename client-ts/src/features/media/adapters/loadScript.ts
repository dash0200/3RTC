/** Load a provider's player script once (resolves when `globalName` exists). */
const pending = new Map<string, Promise<unknown>>();

export function loadScript<T = unknown>(src: string, globalName: string, timeoutMs = 15000): Promise<T> {
  const win = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
  if (win && win[globalName]) {
    return Promise.resolve(win[globalName] as T);
  }
  if (pending.has(src)) return pending.get(src)! as Promise<T>;
  const p = new Promise<T>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    const timer = setTimeout(() => reject(new Error(`${globalName} player didn't load`)), timeoutMs);
    tag.onload = () => {
      clearTimeout(timer);
      const currentWin = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
      if (currentWin && currentWin[globalName]) resolve(currentWin[globalName] as T);
      else reject(new Error(`${globalName} player didn't load`));
    };
    tag.onerror = () => {
      clearTimeout(timer);
      pending.delete(src);
      reject(new Error(`${globalName} player couldn't be reached`));
    };
    document.head.appendChild(tag);
  });
  pending.set(src, p as Promise<unknown>);
  return p;
}
