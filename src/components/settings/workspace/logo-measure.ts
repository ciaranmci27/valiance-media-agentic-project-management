'use client';

import { useEffect, useState } from 'react';
import { logoLuminance } from './logo-checks';

export interface LogoMeasure {
  width: number;
  height: number;
  /** Null when the pixels cannot be read (another host without CORS). */
  tone: { luminance: number; transparent: boolean } | null;
}

/** The edge the pixels are sampled at: enough for an average, cheap to read. */
const SAMPLE = 64;

/** An image's size and how light it is, read in the browser. Null when it does not load (an ICO the browser cannot draw, say). */
export function measureLogo(src: string): Promise<LogoMeasure | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) return resolve(null);
      let tone: LogoMeasure['tone'] = null;
      try {
        const scale = SAMPLE / Math.max(width, height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          tone = logoLuminance(context.getImageData(0, 0, canvas.width, canvas.height).data);
        }
      } catch {
        // A tainted canvas: the size still guards the shape, the tone hint is skipped.
      }
      resolve({ width, height, tone });
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/** A file's size and tone, read before it uploads. */
export async function measureLogoFile(file: File): Promise<LogoMeasure | null> {
  const url = URL.createObjectURL(file);
  try {
    return await measureLogo(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The tone of an uploaded logo, read once per address (null while reading or unreadable). */
export function useLogoTone(src: string | null): LogoMeasure['tone'] {
  const [result, setResult] = useState<{ src: string; tone: LogoMeasure['tone'] } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    void measureLogo(src).then((measure) => { if (live) setResult({ src, tone: measure?.tone ?? null }); });
    return () => { live = false; };
  }, [src]);
  return result && result.src === src ? result.tone : null;
}
