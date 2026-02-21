/**
 * Generate a brand color scale (50–700) from a single hex color.
 * Uses HSL lightness shifts so users can provide just one color.
 */
export function generateBrandScale(hex: string): Record<number, string> {
  const { h, s, l } = hexToHSL(hex);

  // Lightness targets for each shade (Tailwind-ish distribution)
  const scale: Record<number, number> = {
    50: Math.min(l + 40, 97),
    100: Math.min(l + 33, 94),
    200: Math.min(l + 24, 88),
    300: Math.min(l + 14, 78),
    400: Math.min(l + 6, 68),
    500: l,
    600: Math.max(l - 8, 20),
    700: Math.max(l - 15, 14),
  };

  const result: Record<number, string> = {};
  for (const [shade, lightness] of Object.entries(scale)) {
    result[Number(shade)] = hslToHex(h, s, lightness);
  }
  return result;
}

function hexToHSL(hex: string): { h: number; s: number; l: number } {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const a = sN * Math.min(lN, 1 - lN);

  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lN - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}
