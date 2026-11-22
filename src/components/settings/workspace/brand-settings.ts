'use client';

import { setReadData, type Read } from '@/lib/query-cache';
import {
  BRAND_SHADES,
  DEFAULT_BRAND,
  generateShades,
  isHexColor,
  type Brand,
  type BrandScale,
  type BrandSettings,
  type BrandSettingsInput,
  type LogoKind,
  type SidebarProjectsStyle,
} from '@/lib/brand';
import { LOGO_MAX_BYTES } from '@/lib/brand/validate';

/**
 * The Owner's side of the workspace brand, shared by Settings > Workspace >
 * Brand and the setup wizard's first step: one read, one save, and the logo
 * uploads. Every screen else reads the brand from the page render
 * (useBrand), so a successful write is followed by router.refresh().
 */

export interface BrandData {
  /** What the Owner has set; null means "use the default". */
  settings: BrandSettings;
  /** The settings with the defaults filled in, as every screen shows them. */
  brand: Brand;
  defaults: Brand;
}

export type BrandState =
  | { status: 'ready'; data: BrandData }
  /** The brand migration has not run: nothing can be saved yet. */
  | { status: 'migration'; message: string }
  /** The demo workspace has no database: edits stay on this page until a reload. */
  | { status: 'local' };

class BrandRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** What to say when the server's answer carries no message of its own (a proxy's 413, say). */
function fallbackMessage(status: number): string {
  if (status === 413) return 'That file is too big. Use one up to 2 MB.';
  if (status === 415) return 'Use a PNG or JPG file.';
  if (status === 409) return 'Run the latest database migration first.';
  if (status === 403) return 'Only the workspace Owner can change the brand.';
  return 'Something went wrong on the server. Try again.';
}

async function parse(response: Response): Promise<BrandData> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new BrandRequestError(payload.error || fallbackMessage(response.status), response.status);
  return payload.data as BrandData;
}

/** Owner only. The brand changes only through these routes, so it is read once a session. */
export const workspaceBrandRead: Read<BrandState> = {
  key: 'workspace-brand',
  tables: ['workspace_brand'],
  ttlMs: 10 * 60_000,
  load: async () => {
    try {
      return { status: 'ready', data: await parse(await fetch('/api/workspace/brand', { cache: 'no-store' })) };
    } catch (error) {
      if (error instanceof BrandRequestError && error.status === 409) return { status: 'migration', message: error.message };
      if (error instanceof BrandRequestError && error.status === 403) return { status: 'local' };
      throw error;
    }
  },
};

export type BrandResult = { ok: true; data: BrandData } | { ok: false; message: string; migration: boolean };

async function run(request: () => Promise<Response>): Promise<BrandResult> {
  try {
    const data = await parse(await request());
    setReadData<BrandState>(workspaceBrandRead, () => ({ status: 'ready', data }));
    return { ok: true, data };
  } catch (error) {
    if (error instanceof BrandRequestError) {
      const migration = error.status === 409;
      if (migration) setReadData<BrandState>(workspaceBrandRead, () => ({ status: 'migration', message: error.message }));
      return { ok: false, message: error.message, migration };
    }
    return { ok: false, message: 'Could not reach the server. Check your connection and try again.', migration: false };
  }
}

export function saveBrand(input: BrandSettingsInput): Promise<BrandResult> {
  return run(() => fetch('/api/workspace/brand', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
}

/** Sets only how the sidebar shows projects (the setup wizard, from the preset). */
export function saveSidebarProjects(sidebarProjects: SidebarProjectsStyle, sidebarActiveProjects?: boolean): Promise<BrandResult> {
  return run(() => fetch('/api/workspace/brand', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sidebarProjects, sidebarActiveProjects }),
  }));
}

export function uploadLogo(kind: LogoKind, file: File): Promise<BrandResult> {
  const form = new FormData();
  form.append('file', file);
  return run(() => fetch(`/api/workspace/brand/logo?kind=${kind}`, { method: 'POST', body: form }));
}

export function removeLogo(kind: LogoKind): Promise<BrandResult> {
  return run(() => fetch(`/api/workspace/brand/logo?kind=${kind}`, { method: 'DELETE' }));
}

/**
 * The file behind an uploaded logo, fetched before it is removed so Remove
 * can offer Undo (the bucket is public). Null when it cannot be read: the
 * removal still goes ahead, just without Undo.
 */
export async function fetchLogoFile(url: string, kind: LogoKind): Promise<File | null> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
    window.clearTimeout(timer);
    if (!response.ok) return null;
    const blob = await response.blob();
    const ext = url.split('?')[0].split('.').pop() || 'png';
    return new File([blob], `${kind}.${ext}`, { type: blob.type });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const LOGO_ACCEPT: Record<LogoKind, string> = {
  light: 'image/png,image/jpeg',
  dark: 'image/png,image/jpeg',
  favicon: 'image/png,image/jpeg,image/x-icon,image/vnd.microsoft.icon,.ico',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The format and size line under each drop zone. */
export function logoRule(kind: LogoKind): string {
  return `${kind === 'favicon' ? 'PNG, JPG or ICO' : 'PNG or JPG'}, up to ${formatBytes(LOGO_MAX_BYTES[kind])}`;
}

/** The same rules the server applies, checked first so a wrong file fails at once. Null when it is fine. */
export function checkLogoFile(kind: LogoKind, file: File): string | null {
  const name = file.name.toLowerCase();
  const png = file.type === 'image/png' || name.endsWith('.png');
  const jpg = file.type === 'image/jpeg' || /\.jpe?g$/.test(name);
  const ico = file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon' || name.endsWith('.ico');
  if (!(png || jpg || (kind === 'favicon' && ico))) {
    return kind === 'favicon'
      ? 'That file type isn\'t supported. Use a PNG, JPG or ICO file.'
      : 'That file type isn\'t supported. Use a PNG or JPG file (SVG isn\'t supported).';
  }
  if (file.size > LOGO_MAX_BYTES[kind]) {
    return `That file is ${formatBytes(file.size)}. Use one up to ${formatBytes(LOGO_MAX_BYTES[kind])}.`;
  }
  return null;
}

/** "#abc", "abc" or "#AABBCC" as "#AABBCC"; null for anything else. */
export function normalizeHex(text: string): string | null {
  const raw = text.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map((c) => c + c).join('')}`.toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}

export const EMPTY_INPUT: BrandSettingsInput = {
  name: null,
  tagline: null,
  description: null,
  brandColor: null,
  brandShades: null,
  accentColor: null,
  invertLogoInSidebar: false,
  showNameUnderLogo: false,
  sidebarProjects: 'list',
  sidebarActiveProjects: true,
};

/** The fields the form saves, from what is stored. */
export function toInput(settings: BrandSettings): BrandSettingsInput {
  return {
    name: settings.name,
    tagline: settings.tagline,
    description: settings.description,
    brandColor: settings.brandColor,
    brandShades: settings.brandShades,
    accentColor: settings.accentColor,
    invertLogoInSidebar: settings.invertLogoInSidebar,
    showNameUnderLogo: settings.showNameUnderLogo,
    sidebarProjects: settings.sidebarProjects,
    sidebarActiveProjects: settings.sidebarActiveProjects,
  };
}

/** Text as the server stores it: trimmed, blank meaning "use the default". */
function cleanText(value: string | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed || null;
}

/** Shade overrides with the empty ones dropped, null when none are left. */
export function cleanShadeOverrides(shades: Partial<BrandScale> | null): Partial<BrandScale> | null {
  if (!shades) return null;
  const out: Partial<BrandScale> = {};
  for (const shade of BRAND_SHADES) {
    if (isHexColor(shades[shade])) out[shade] = shades[shade]!.toUpperCase();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The body a save sends: what the server would store, so "dirty" means "would change something". */
export function cleanInput(input: BrandSettingsInput): BrandSettingsInput {
  return {
    ...input,
    name: cleanText(input.name),
    tagline: cleanText(input.tagline),
    description: cleanText(input.description),
    brandShades: cleanShadeOverrides(input.brandShades),
  };
}

export function sameInput(a: BrandSettingsInput, b: BrandSettingsInput): boolean {
  const x = cleanInput(a);
  const y = cleanInput(b);
  return x.name === y.name
    && x.tagline === y.tagline
    && x.description === y.description
    && x.brandColor === y.brandColor
    && x.accentColor === y.accentColor
    && x.invertLogoInSidebar === y.invertLogoInSidebar
    && x.showNameUnderLogo === y.showNameUnderLogo
    && x.sidebarProjects === y.sidebarProjects
    && x.sidebarActiveProjects === y.sidebarActiveProjects
    && BRAND_SHADES.every((shade) => (x.brandShades?.[shade] ?? null) === (y.brandShades?.[shade] ?? null));
}

/** True when something differs from the defaults (Reset has something to do). */
export function hasCustomValues(input: BrandSettingsInput): boolean {
  return !sameInput(input, EMPTY_INPUT);
}

/**
 * The live brand read back as settings, for the demo workspace (no database
 * to read them from): anything equal to the default stays unset, so the
 * fields show their placeholders.
 */
export function settingsFromBrand(brand: Brand): BrandSettings {
  const d = DEFAULT_BRAND;
  const base = brand.colors.brand[500];
  const brandColor = base.toUpperCase() === d.colors.brand[500].toUpperCase() ? null : base.toUpperCase();
  const generated = brandColor ? generateShades(brandColor) : d.colors.brand;
  const overrides: Partial<BrandScale> = {};
  for (const shade of BRAND_SHADES) {
    if (brand.colors.brand[shade].toUpperCase() !== generated[shade].toUpperCase()) overrides[shade] = brand.colors.brand[shade].toUpperCase();
  }
  const scale = { ...generated, ...overrides };
  const defaultAccent = brandColor ? scale[700] : d.colors.accent;
  return {
    name: brand.name === d.name ? null : brand.name,
    tagline: brand.tagline === d.tagline ? null : brand.tagline,
    description: brand.description === d.description ? null : brand.description,
    brandColor,
    brandShades: Object.keys(overrides).length > 0 ? overrides : null,
    accentColor: brand.colors.accent.toUpperCase() === defaultAccent.toUpperCase() ? null : brand.colors.accent.toUpperCase(),
    logoLightUrl: brand.logos.light,
    logoDarkUrl: brand.logos.dark && brand.logos.dark !== brand.logos.light ? brand.logos.dark : null,
    faviconUrl: brand.logos.favicon,
    invertLogoInSidebar: brand.invertLogoInSidebar,
    showNameUnderLogo: brand.showNameUnderLogo,
    sidebarProjects: brand.sidebarProjects,
    sidebarActiveProjects: brand.sidebarActiveProjects,
  };
}

/** The first letter the generated favicon draws (src/app/api/brand/icon). */
export function faviconLetter(name: string): string {
  return (name.trim()[0] || 'W').toUpperCase();
}
