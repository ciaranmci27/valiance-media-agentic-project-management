import { isHexColor } from './shades';
import { cleanShades } from './resolve';
import { logoKindShape, type BrandSettingsInput, type LogoKind, type SidebarProjectsStyle } from './types';

/** Longest values the brand table accepts (matches its CHECK constraints). */
export const BRAND_LIMITS = { name: 60, tagline: 60, description: 200 } as const;

/** A save body: the sidebar's project options left out keep what is stored (older clients and the setup wizard send no value). */
export type ParsedBrandInput = Omit<BrandSettingsInput, 'sidebarProjects' | 'sidebarActiveProjects'>
  & { sidebarProjects?: SidebarProjectsStyle; sidebarActiveProjects?: boolean };

type Parsed = { data: ParsedBrandInput; error: null } | { data: null; error: string };

function optionalText(value: unknown, label: string, max: number): { value: string | null; error: string | null } {
  if (value === null || value === undefined) return { value: null, error: null };
  if (typeof value !== 'string') return { value: null, error: `${label} must be text` };
  const trimmed = value.trim();
  if (trimmed.length > max) return { value: null, error: `${label} can be at most ${max} characters` };
  return { value: trimmed || null, error: null };
}

function optionalColor(value: unknown, label: string): { value: string | null; error: string | null } {
  if (value === null || value === undefined || value === '') return { value: null, error: null };
  if (!isHexColor(value)) return { value: null, error: `${label} must be a hex color like #5B8A8A` };
  return { value: value.toUpperCase(), error: null };
}

/** The settings page's save body, checked field by field. Blank means "use the default". */
export function parseBrandInput(body: unknown): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { data: null, error: 'Send a JSON body' };
  const b = body as Record<string, unknown>;
  const name = optionalText(b.name, 'Name', BRAND_LIMITS.name);
  const tagline = optionalText(b.tagline, 'Tagline', BRAND_LIMITS.tagline);
  const description = optionalText(b.description, 'Description', BRAND_LIMITS.description);
  const brandColor = optionalColor(b.brandColor, 'Brand color');
  const accentColor = optionalColor(b.accentColor, 'Accent color');
  const firstError = [name, tagline, description, brandColor, accentColor].find((f) => f.error)?.error;
  if (firstError) return { data: null, error: firstError };
  if (b.brandShades !== null && b.brandShades !== undefined && (typeof b.brandShades !== 'object' || Array.isArray(b.brandShades))) {
    return { data: null, error: 'Shades must be an object of shade to hex color' };
  }
  for (const key of ['invertLogoInSidebar', 'showNameUnderLogo', 'sidebarActiveProjects'] as const) {
    if (b[key] !== undefined && typeof b[key] !== 'boolean') return { data: null, error: `${key} must be true or false` };
  }
  if (b.sidebarProjects !== undefined && b.sidebarProjects !== 'list' && b.sidebarProjects !== 'menu') {
    return { data: null, error: 'sidebarProjects must be list or menu' };
  }
  return {
    data: {
      name: name.value,
      tagline: tagline.value,
      description: description.value,
      brandColor: brandColor.value,
      brandShades: cleanShades(b.brandShades),
      accentColor: accentColor.value,
      invertLogoInSidebar: b.invertLogoInSidebar === true,
      showNameUnderLogo: b.showNameUnderLogo === true,
      ...(b.sidebarProjects === undefined ? {} : { sidebarProjects: b.sidebarProjects as SidebarProjectsStyle }),
      ...(b.sidebarActiveProjects === undefined ? {} : { sidebarActiveProjects: b.sidebarActiveProjects === true }),
    },
    error: null,
  };
}

/** Upload limits per logo kind, in bytes. */
export const LOGO_MAX_BYTES: Record<LogoKind, number> = { light: 2 * 1024 * 1024, dark: 2 * 1024 * 1024, favicon: 512 * 1024, square_dark: 512 * 1024 };

export type SniffedImage = { ext: 'png' | 'jpg' | 'ico'; contentType: string };

/**
 * The image type from the file's first bytes, never its name or the browser's
 * claim: PNG and JPEG, plus ICO for the square logos only. Anything else (SVG
 * included) is refused.
 */
export function sniffImage(bytes: Uint8Array, kind: LogoKind): SniffedImage | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (logoKindShape(kind) === 'square' && bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return { ext: 'ico', contentType: 'image/x-icon' };
  }
  return null;
}

/**
 * A PNG's or JPEG's width and height from its bytes (the PNG header, or the
 * first JPEG frame header), or null for anything else. The tab icon uses it
 * to crop a horizontal logo into a square when no square logo is uploaded.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      // Padding bytes between markers.
      if (marker === 0xff) { offset += 1; continue; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      // SOF0 to SOF15, leaving out DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Where a horizontal logo sits when it stands in for a square one: scaled to
 * the square's height and kept to its left edge, where a lockup's mark
 * usually is. A logo narrower than the square is centered instead.
 */
export function squareCrop(image: { width: number; height: number }, edge: number): { width: number; height: number; left: number } {
  const width = Math.round((image.width / image.height) * edge);
  if (width <= edge) {
    const scale = edge / Math.max(image.width, image.height);
    const w = Math.round(image.width * scale);
    return { width: w, height: Math.round(image.height * scale), left: Math.round((edge - w) / 2) };
  }
  return { width, height: edge, left: 0 };
}
