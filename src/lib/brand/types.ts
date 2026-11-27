/**
 * The workspace's brand: what the app, the client portal, emails and invoice
 * PDFs show as "us". An Owner sets it in Settings > Workspace > Brand; it is
 * stored in public.workspace_brand, and anything left unset uses core's
 * defaults (src/lib/brand/defaults.ts).
 */

export const BRAND_SHADES = [50, 100, 200, 300, 400, 500, 600, 700] as const;
export type BrandShade = typeof BRAND_SHADES[number];
export type BrandScale = Record<BrandShade, string>;

/** How the sidebar lists projects: a section of the first few (agencies), or a menu of every active one under Projects (teams, solo). */
export type SidebarProjectsStyle = 'list' | 'menu';

/**
 * The brand's four logo slots: a horizontal logo and a square one, each for
 * the light theme and the dark theme. The stored names are older than the
 * slots: `light` and `dark` are the horizontal logo for light and dark
 * backgrounds, `favicon` is the square logo for light ones (it is the
 * browser tab icon), and `square_dark` the square logo for dark ones.
 */
export const LOGO_KINDS = ['light', 'dark', 'favicon', 'square_dark'] as const;
export type LogoKind = typeof LOGO_KINDS[number];

/** A slot's shape: horizontal (light, dark) or square (favicon, square_dark). */
export function logoKindShape(kind: LogoKind): 'horizontal' | 'square' {
  return kind === 'favicon' || kind === 'square_dark' ? 'square' : 'horizontal';
}

/** A slot's theme: the light or the dark one. */
export function logoKindTheme(kind: LogoKind): 'light' | 'dark' {
  return kind === 'dark' || kind === 'square_dark' ? 'dark' : 'light';
}

/** The slot with this shape and theme. */
export function logoKindFor(shape: 'horizontal' | 'square', theme: 'light' | 'dark'): LogoKind {
  if (shape === 'horizontal') return theme === 'light' ? 'light' : 'dark';
  return theme === 'light' ? 'favicon' : 'square_dark';
}

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
    /** The square logo for light backgrounds: the browser tab icon and the loading screen. */
    favicon: string | null;
    /** The square logo for dark backgrounds: the tab icon in a dark browser, the loading screen in dark mode. Falls back to favicon. */
    squareDark: string | null;
  };
  /** Flips the logo in the dark sidebar, for a mark drawn for light backgrounds only. */
  invertLogoInSidebar: boolean;
  /** Prints the name under the logo in the sidebar. */
  showNameUnderLogo: boolean;
  /** How the Projects item works: 'list' opens the Projects page, 'menu' folds the active projects under it. */
  sidebarProjects: SidebarProjectsStyle;
  /** The sidebar lists the first five active projects in a section of their own. */
  sidebarActiveProjects: boolean;
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
  /** The square logo for dark backgrounds (migration 20261127003100); null falls back to faviconUrl. */
  squareDarkUrl: string | null;
  invertLogoInSidebar: boolean;
  showNameUnderLogo: boolean;
  sidebarProjects: SidebarProjectsStyle;
  sidebarActiveProjects: boolean;
}

/** The fields the settings page saves (logos upload on their own route). */
export type BrandSettingsInput = Omit<BrandSettings, 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl' | 'squareDarkUrl'>;
