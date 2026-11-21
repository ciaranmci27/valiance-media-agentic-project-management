import { BRAND_SHADES, type BrandScale, type BrandShade } from './types';

/**
 * The 50 to 700 scale from one color. The picked color is 500; lighter shades
 * mix toward white and darker ones toward black, in the proportions core's
 * own scale uses, so a picked color reads like the default in every place
 * the design system puts a shade (tints, borders, glows, hover states).
 */
const TOWARD_WHITE: Partial<Record<BrandShade, number>> = { 50: 0.91, 100: 0.77, 200: 0.54, 300: 0.3, 400: 0.15 };
const TOWARD_BLACK: Partial<Record<BrandShade, number>> = { 600: 0.19, 700: 0.36 };

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

function toRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function mix(hex: string, target: number, amount: number): string {
  const rgb = toRgb(hex);
  return toHex(rgb.map((c) => c + (target - c) * amount) as [number, number, number]);
}

export function generateShades(base: string): BrandScale {
  const color = base.toUpperCase();
  return Object.fromEntries(BRAND_SHADES.map((shade) => {
    if (shade === 500) return [shade, color];
    const white = TOWARD_WHITE[shade];
    if (white !== undefined) return [shade, mix(color, 255, white)];
    return [shade, mix(color, 0, TOWARD_BLACK[shade] ?? 0)];
  })) as BrandScale;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
