/// <reference types="vite/client" />

export interface AppBuildInfo {
  number: string;
  sha: string;
  branch: string;
  time: string;
}

declare global {
  const __APP_BUILD__: AppBuildInfo;

  interface Window {
    __webrtcAudioCtx?: AudioContext;
  }
}
