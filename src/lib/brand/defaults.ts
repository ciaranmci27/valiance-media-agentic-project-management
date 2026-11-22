import type { Brand } from './types';

/**
 * Core's brand, for anything an Owner has not set. Deliberately neutral: no
 * company's name or logo (first-run setup asks for them). The teal is the product's own
 * look, tuned with the surfaces in globals.css.
 */
export const DEFAULT_BRAND: Brand = {
  name: 'Workspace',
  tagline: 'Projects',
  description: 'Projects, tasks, clients and the team, in one place.',
  colors: {
    brand: {
      50: '#F0F5F5',
      100: '#D9E6E6',
      200: '#B3CCCC',
      300: '#8DB3B3',
      400: '#749E9E',
      500: '#5B8A8A',
      600: '#4A7171',
      700: '#3A5959',
    },
    accent: '#3A5959',
  },
  logos: { light: null, dark: null, favicon: null },
  invertLogoInSidebar: false,
  showNameUnderLogo: false,
  sidebarProjects: 'list',
  sidebarActiveProjects: true,
};

/**
 * The color new records start with (projects, contacts, portal accents) where
 * code runs outside React and cannot read the live brand. Screens that can
 * read it use useBrand().colors.brand[500] instead.
 */
export const DEFAULT_ITEM_COLOR = DEFAULT_BRAND.colors.brand[500];
