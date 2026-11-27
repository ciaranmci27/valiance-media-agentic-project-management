/**
 * The brand logo slots' soft guards (Settings > Workspace > Brand), pure so
 * they are tested on their own: a square image dropped on a horizontal slot
 * (or a wide one on a square slot) is caught with the slot it belongs in, and
 * a logo that may vanish on its theme's background gets a gentle hint.
 */

export type LogoShape = 'horizontal' | 'square';
export type LogoTheme = 'light' | 'dark';

/** Width over height from here up reads as a horizontal logo; below it, as square. */
export const WIDE_RATIO = 1.3;
/** A square slot takes a little either way (a mark with a shadow, a rounded tile). */
export const SQUARE_RATIO_MAX = 1.25;
export const SQUARE_RATIO_MIN = 0.8;

/**
 * Null when the image fits the slot; otherwise the slot it belongs in and the
 * line that says so. Sizes that cannot be read are let through (the server
 * checks the format either way).
 */
export function logoShapeProblem(slot: LogoShape, size: { width: number; height: number } | null): { belongs: LogoShape; text: string } | null {
  if (!size || size.width <= 0 || size.height <= 0) return null;
  const ratio = size.width / size.height;
  if (slot === 'horizontal' && ratio < WIDE_RATIO) {
    return { belongs: 'square', text: 'This logo is about as tall as it is wide, so it belongs in Square. A horizontal logo is wider than it is tall.' };
  }
  if (slot === 'square' && (ratio > SQUARE_RATIO_MAX || ratio < SQUARE_RATIO_MIN)) {
    return ratio > SQUARE_RATIO_MAX
      ? { belongs: 'horizontal', text: 'This logo is wide, so it belongs in Horizontal. A square logo is about as tall as it is wide.' }
      : { belongs: 'square', text: 'This logo is much taller than it is wide. Use one about as tall as it is wide.' };
  }
  return null;
}

/**
 * How light a logo's drawn pixels are, from 0 (black) to 1 (white), from its
 * RGBA pixels: the average relative luminance of the pixels that are mostly
 * opaque. `transparent` says whether any pixel lets the background through;
 * a logo with none carries its own background, so it shows on any theme.
 * Null when nothing is drawn.
 */
export function logoLuminance(rgba: ArrayLike<number>): { luminance: number; transparent: boolean } | null {
  let sum = 0;
  let count = 0;
  let transparent = false;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha < 250) transparent = true;
    if (alpha < 128) continue;
    const [r, g, b] = [rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    count += 1;
  }
  return count === 0 ? null : { luminance: sum / count, transparent };
}

/** Lighter than this on a light theme, or darker than DARK_LIMIT on a dark one, may not show. */
export const LIGHT_LIMIT = 0.7;
export const DARK_LIMIT = 0.04;

/** The soft hint for a logo on its theme, or null when it should show well. */
export function logoToneHint(theme: LogoTheme, tone: { luminance: number; transparent: boolean } | null): string | null {
  if (!tone || !tone.transparent) return null;
  if (theme === 'light' && tone.luminance >= LIGHT_LIMIT) return 'This logo is light, so it may not show on the light theme. Check the preview, or add a darker version here.';
  if (theme === 'dark' && tone.luminance <= DARK_LIMIT) return 'This logo is dark, so it may not show on the dark theme. Check the preview, or add a lighter version here.';
  return null;
}
