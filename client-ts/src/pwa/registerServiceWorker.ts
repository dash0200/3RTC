/**
 * Feature 5.1: PWA installability.
 * Registers the service worker (production builds only). Installing is left to the browser's own
 * UI (the install icon in the address bar / "Add to Home Screen"), so `beforeinstallprompt` is
 * intentionally not intercepted.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
