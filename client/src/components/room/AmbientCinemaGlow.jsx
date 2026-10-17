import React, { useEffect, useState, useRef } from 'react';

/**
 * Extracts dominant/edge color from an image or video frame data.
 * Discards pure black letterboxes and pure whites for accurate atmospheric glow.
 */
function extractDominantColor(data) {
  if (!data || data.length === 0) return null;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const alpha = data[i + 3];
    if (alpha < 128) continue;

    // Luminance
    const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
    // Exclude letterbox blacks and extreme white glare
    if (lum > 24 && lum < 235) {
      r += red;
      g += green;
      b += blue;
      count++;
    }
  }

  // If frame is mostly black (e.g., dark scene / fade out), return soft dim glow or transparent
  if (count < 8) return 'transparent';

  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);

  // Boost saturation slightly so ambient aura is rich and vibrant
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta > 8) {
    const avg = (r + g + b) / 3;
    const factor = 1.35;
    r = Math.min(255, Math.max(0, Math.round(avg + (r - avg) * factor)));
    g = Math.min(255, Math.max(0, Math.round(avg + (g - avg) * factor)));
    b = Math.min(255, Math.max(0, Math.round(avg + (b - avg) * factor)));
  }

  return `rgba(${r}, ${g}, ${b}, 0.55)`;
}

/**
 * Ambient Dynamic Cinema Glow:
 * Dynamically samples colors from the playing video (local or YouTube)
 * and radiates an atmospheric aura strictly BEHIND the video canvas.
 * It NEVER overlays or tints the video itself.
 */
export default function AmbientCinemaGlow({ activeVideoId, isMediaActive, localVideoFile, streamVideoUrl }) {
  const [ambientRgb, setAmbientRgb] = useState('transparent');
  const canvasRef = useRef(null);
  const isMediaActiveRef = useRef(isMediaActive);
  isMediaActiveRef.current = isMediaActive;

  // 1. YouTube video color extraction from thumbnail
  useEffect(() => {
    if (!isMediaActive || !activeVideoId) {
      if (!isMediaActive) setAmbientRgb('transparent');
      return;
    }

    let active = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://img.youtube.com/vi/${activeVideoId}/mqdefault.jpg`;

    img.onload = () => {
      if (!active) return;
      try {
        const canvas = canvasRef.current || document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 9;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 16, 9);
        const data = ctx.getImageData(0, 0, 16, 9).data;
        const color = extractDominantColor(data);
        if (color && active) setAmbientRgb(color);
      } catch (err) {
        if (active) setAmbientRgb('rgba(90, 70, 150, 0.4)');
      }
    };

    img.onerror = () => {
      if (active) setAmbientRgb('rgba(90, 70, 150, 0.4)');
    };

    return () => { active = false; };
  }, [activeVideoId, isMediaActive]);

  // 2. Local video / P2P stream dynamic color extraction directly from playing <video>
  useEffect(() => {
    if (!isMediaActive || activeVideoId) return;

    let active = true;
    const sampleFrame = () => {
      if (!active || !isMediaActiveRef.current) return;
      const videoEl = document.querySelector('.stage-canvas video');
      if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;

      try {
        const canvas = canvasRef.current || document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 9;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(videoEl, 0, 0, 16, 9);
        const data = ctx.getImageData(0, 0, 16, 9).data;
        const color = extractDominantColor(data);
        if (color && active) {
          setAmbientRgb(color);
        }
      } catch (e) {
        // Fallback or keep current color
      }
    };

    // Initial check after short mount delay
    const initialTimer = setTimeout(sampleFrame, 600);
    // Periodically sample playing video frame (every 1.8s) for dynamic ambient effect
    const intervalTimer = setInterval(sampleFrame, 1800);

    return () => {
      active = false;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [isMediaActive, activeVideoId, localVideoFile, streamVideoUrl]);

  if (!isMediaActive) return null;

  return (
    <div className="stage-ambient-cinema-layer" aria-hidden="true">
      <div
        className="stage-ambient-glow"
        style={{
          background: `radial-gradient(ellipse 95% 85% at 50% 50%, ${ambientRgb} 0%, rgba(10, 10, 13, 0) 75%)`
        }}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
