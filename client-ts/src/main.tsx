import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled with the app (no Google Fonts request: nothing leaves your devices)
import '@fontsource-variable/figtree';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './index.css';
import App from './App';
import { registerServiceWorker } from './pwa/registerServiceWorker';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
