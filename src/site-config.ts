/**
 * ─────────────────────────────────────────────────────────────
 *  SITE CONFIG — the one file to edit when re-skinning this app.
 * ─────────────────────────────────────────────────────────────
 *  Everything brand-specific lives here. Change these values and the
 *  whole UI updates (ThemeProvider injects the colors into CSS variables
 *  that the entire design system references via var(--color-brand-*) /
 *  var(--color-accent)).
 *
 *  Configurable here:
 *    • name / tagline / description  → shown in sidebar, titles, metadata
 *    • colors.brand (50–700)         → primary accent scale: buttons, glows,
 *                                       ambient light, links, active states,
 *                                       progress, focus rings, glass highlights
 *    • colors.accent                 → secondary accent (e.g. dashboard banner gradient)
 *    • logo                          → replace the image served at /api/logo
 *                                       (falls back to the name text if missing)
 *
 *  NOT configured here (intentionally): the dark surface palette + fonts live
 *  in app/globals.css (@theme). They are the base theme, shared across brands,
 *  and are where a future light mode will be defined.
 */
export const siteConfig = {
  name: 'Valiance Media',
  tagline: 'Client Portal',
  description:
    'Manage projects, track leads, and collaborate with our team, all in one place.',

  // Logo: swap the asset served at /api/logo. `invertLogoInSidebar` flips it for
  // dark chrome; `showNameUnderLogo` renders the name beneath the mark.
  invertLogoInSidebar: false,
  showNameUnderLogo: false,

  colors: {
    // Primary brand scale — this is the accent color of the entire app.
    // Generate a full 50→700 ramp of your brand color and drop it in.
    brand: {
      50: '#F0F5F5',
      100: '#D9E6E6',
      200: '#B3CCCC',
      300: '#8DB3B3',
      400: '#749E9E',
      500: '#5B8A8A',
      600: '#4A7171',
      700: '#3A5959',
    } as Record<number, string>,
    // Secondary accent (used sparingly, e.g. the dashboard welcome gradient).
    accent: '#3A5959',
  },
};
