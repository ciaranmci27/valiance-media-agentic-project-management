import { DEFAULT_BRAND } from './defaults';
import { generateShades, isHexColor } from './shades';
import { BRAND_SHADES, type Brand, type BrandScale, type BrandSettings } from './types';

/** The storage bucket logos and favicons are uploaded to (public read). */
export const BRAND_BUCKET = 'brand';

/** A row of public.workspace_brand, as PostgREST returns it. */
export interface WorkspaceBrandRow {
  name: string | null;
  tagline: string | null;
  description: string | null;
  brand_color: string | null;
  brand_shades: Record<string, unknown> | null;
  accent_color: string | null;
  logo_light_path: string | null;
  logo_dark_path: string | null;
  favicon_path: string | null;
  invert_logo_in_sidebar: boolean | null;
  show_name_under_logo: boolean | null;
}

export const WORKSPACE_BRAND_COLUMNS =
  'name, tagline, description, brand_color, brand_shades, accent_color, logo_light_path, logo_dark_path, favicon_path, invert_logo_in_sidebar, show_name_under_logo';

export const EMPTY_BRAND_SETTINGS: BrandSettings = {
  name: null,
  tagline: null,
  description: null,
  brandColor: null,
  brandShades: null,
  accentColor: null,
  logoLightUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
  invertLogoInSidebar: false,
  showNameUnderLogo: false,
};

/** The public URL of an object in the brand bucket. */
export function brandFileUrl(path: string | null, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL): string | null {
  if (!path || !supabaseUrl) return null;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${BRAND_BUCKET}/${encoded}`;
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/** Only valid hex shades survive, so a hand-edited row can never break the CSS. */
export function cleanShades(value: unknown): Partial<BrandScale> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Partial<BrandScale> = {};
  for (const shade of BRAND_SHADES) {
    const hex = (value as Record<string, unknown>)[String(shade)];
    if (isHexColor(hex)) out[shade] = hex.toUpperCase();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function rowToSettings(row: WorkspaceBrandRow | null, supabaseUrl?: string): BrandSettings {
  if (!row) return { ...EMPTY_BRAND_SETTINGS };
  return {
    name: text(row.name),
    tagline: text(row.tagline),
    description: text(row.description),
    brandColor: isHexColor(row.brand_color) ? row.brand_color.toUpperCase() : null,
    brandShades: cleanShades(row.brand_shades),
    accentColor: isHexColor(row.accent_color) ? row.accent_color.toUpperCase() : null,
    logoLightUrl: brandFileUrl(row.logo_light_path, supabaseUrl),
    logoDarkUrl: brandFileUrl(row.logo_dark_path, supabaseUrl),
    faviconUrl: brandFileUrl(row.favicon_path, supabaseUrl),
    invertLogoInSidebar: row.invert_logo_in_sidebar === true,
    showNameUnderLogo: row.show_name_under_logo === true,
  };
}

/**
 * The complete brand: what is set, then core's defaults. A picked color generates the scale; per-shade overrides sit on top. With no
 * accent set, a picked color's 700 is the accent, as core's default is.
 */
export function resolveBrand(settings: BrandSettings): Brand {
  const generated = settings.brandColor ? generateShades(settings.brandColor) : DEFAULT_BRAND.colors.brand;
  const brand = { ...generated, ...(settings.brandShades ?? {}) } as BrandScale;
  const accent = settings.accentColor ?? (settings.brandColor ? brand[700] : DEFAULT_BRAND.colors.accent);
  return {
    name: settings.name ?? DEFAULT_BRAND.name,
    tagline: settings.tagline ?? DEFAULT_BRAND.tagline,
    description: settings.description ?? DEFAULT_BRAND.description,
    colors: { brand, accent },
    logos: {
      light: settings.logoLightUrl,
      dark: settings.logoDarkUrl ?? settings.logoLightUrl,
      favicon: settings.faviconUrl,
    },
    invertLogoInSidebar: settings.invertLogoInSidebar,
    showNameUnderLogo: settings.showNameUnderLogo,
  };
}

/** The CSS custom properties ThemeProvider injects for a brand. */
export function brandCssVars(brand: Brand): string {
  return BRAND_SHADES
    .map((shade) => `--color-brand-${shade}:${brand.colors.brand[shade]}`)
    .concat(`--color-accent:${brand.colors.accent}`)
    .join(';');
}
