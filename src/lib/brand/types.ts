/**
 * The workspace's brand: what the app, the client portal, emails and invoice
 * PDFs show as "us". An Owner sets it in Settings > Workspace > Brand; it is
 * stored in public.workspace_brand, and anything left unset uses core's
 * defaults (src/lib/brand/defaults.ts).
 */

export const BRAND_SHADES = [50, 100, 200, 300, 400, 500, 600, 700] as const;
export type BrandShade = typeof BRAND_SHADES[number];
export type BrandScale = Record<BrandShade, string>;

export const LOGO_KINDS = ['light', 'dark', 'favicon'] as const;
export type LogoKind = typeof LOGO_KINDS[number];

/** The brand as every screen, email and PDF reads it: complete, no blanks. */
export interface Brand {
  /** Sidebar, page titles, sign-in page, emails, metadata. */
  name: string;
  /** Second half of the browser tab title. */
  tagline: string;
  /** Search and link-preview description. */
  description: string;
  colors: {
    /** The accent of the whole app: buttons, links, active states, focus rings, glows. */
    brand: BrandScale;
    /** The secondary accent, used sparingly (the dashboard welcome gradient). */
    accent: string;
  };
  /**
   * Public URLs of the uploaded files, or null when none is uploaded: the app
   * then shows the name as text, and the favicon is generated from the name
   * and brand color (/api/brand/icon).
   */
  logos: {
    /** For light backgrounds: the sign-in page in light mode, light invoice PDFs. */
    light: string | null;
    /** For dark backgrounds: the sidebar, the client portal, emails, standard invoice PDFs. Falls back to light. */
    dark: string | null;
    favicon: string | null;
  };
  /** Flips the logo in the dark sidebar, for a mark drawn for light backgrounds only. */
  invertLogoInSidebar: boolean;
  /** Prints the name under the logo in the sidebar. */
  showNameUnderLogo: boolean;
}

/**
 * What an Owner has set, exactly as stored: null means "use the default".
 * The settings page edits this; everything else reads the resolved Brand.
 */
export interface BrandSettings {
  name: string | null;
  tagline: string | null;
  description: string | null;
  /** The one color an Owner picks; the 50 to 700 scale is generated from it. */
  brandColor: string | null;
  /** Optional per-shade overrides on top of the generated scale. */
  brandShades: Partial<BrandScale> | null;
  accentColor: string | null;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  invertLogoInSidebar: boolean;
  showNameUnderLogo: boolean;
}

/** The fields the settings page saves (logos upload on their own route). */
export type BrandSettingsInput = Omit<BrandSettings, 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl'>;
