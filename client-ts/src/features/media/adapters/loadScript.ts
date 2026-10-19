/** Load a provider's player script once (resolves when `globalName` exists). */
const pending = new Map<string, Promise<any>>();

export function loadScript<T = any>(src: string, globalName: string, timeoutMs = 15000): Promise<T> {
  if (typeof window !== 'undefined' && (window as any)[globalName]) {
    return Promise.resolve((window as any)[globalName] as T);
  }
  if (pending.has(src)) return pending.get(src)!;
  const p = new Promise<T>((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    const timer = setTimeout(() => reject(new Error(`${globalName} player didn't load`)), timeoutMs);
    tag.onload = () => {
      clearTimeout(timer);
      if ((window as any)[globalName]) resolve((window as any)[globalName] as T);
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
