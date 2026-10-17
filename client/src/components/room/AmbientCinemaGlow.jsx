import React, { useEffect, useState, useRef } from 'react';

/**
 * Ambient Dynamic Cinema Glow (Phase 3 Innovation - Alphabet Benchmark):
 * Extracts dominant color palettes from the active video or YouTube thumbnail
 * and diffuses a dynamic, breathing atmosphere into the stage letterboxing and backdrop.
 * Mirrors the luxury cinematic immersion of YouTube Ambient Mode & Apple TV.
 */
export default function AmbientCinemaGlow({ activeVideoId, isMediaActive, localVideoFile }) {
  const [ambientRgb, setAmbientRgb] = useState('rgba(110, 50, 160, 0.28)');
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!isMediaActive) {
      setAmbientRgb('transparent');
      return;
    }

    // Default warm cinema ambient tone
    setAmbientRgb('rgba(140, 30, 60, 0.32)');

    // For YouTube videos, fetch thumbnail and extract dominant color via offscreen canvas
    if (activeVideoId) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = `https://img.youtube.com/vi/${activeVideoId}/mqdefault.jpg`;
      img.onload = () => {
        try {
          const canvas = canvasRef.current || document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 9;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(img, 0, 0, 16, 9);
          const data = ctx.getImageData(0, 0, 16, 9).data;
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < data.length; i += 4) {
            // Filter out near-black or extreme whites for vibrant glow
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum > 20 && lum < 235) {
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              count++;
            }
          }
          if (count > 0) {
            r = Math.round(r / count);
            g = Math.round(g / count);
            b = Math.round(b / count);
            // Boost saturation slightly for ambient lighting effect
            const max = Math.max(r, g, b);
            if (max > 0) {
              r = Math.min(255, Math.round(r * 1.15));
              g = Math.min(255, Math.round(g * 1.15));
              b = Math.min(255, Math.round(b * 1.15));
            }
            setAmbientRgb(`rgba(${r}, ${g}, ${b}, 0.38)`);
          }
        } catch {
          // Fallback to elegant coral ambient
          setAmbientRgb('rgba(229, 20, 61, 0.25)');
        }
      };
      img.onerror = () => {
        setAmbientRgb('rgba(229, 20, 61, 0.25)');
      };
    } else if (localVideoFile) {
      // Local media: use rich deep cinematic indigo glow
      setAmbientRgb('rgba(80, 40, 180, 0.35)');
    }
  }, [activeVideoId, isMediaActive, localVideoFile]);

  if (!isMediaActive) return null;

  return (
    <div className="stage-ambient-cinema-layer" aria-hidden="true">
      <div
        className="stage-ambient-glow"
        style={{
          background: `radial-gradient(ellipse 90% 80% at 50% 50%, ${ambientRgb} 0%, rgba(10, 10, 13, 0) 75%)`
        }}
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
