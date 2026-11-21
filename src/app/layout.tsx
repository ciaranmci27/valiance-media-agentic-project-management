import type { Metadata } from 'next';
import './globals.css';
// The install's own theme, after core's so it wins (src/custom/theme.css).
import '../custom/theme.css';
import { DM_Sans, DM_Mono } from 'next/font/google';
import { ThemeProvider } from '@/components/ui/ThemeProvider';
import { BrandProvider } from '@/lib/brand/context';
import { getBrand } from '@/lib/brand/server';
import { RegionProvider } from '@/lib/region/context';
import { getRegion } from '@/lib/region/server';

// Self-hosted via next/font and consumed by --font-sans / --font-mono in
// globals.css. Do not load fonts with a Google Fonts @import url() there:
// Turbopack (Next 16's default bundler for production builds) drops external
// @import rules from bundled CSS, silently breaking the webfont.
const dmSans = DM_Sans({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

/** Title, description and icons from the workspace's brand (Settings > Workspace > Brand). */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  // An uploaded favicon, or one drawn from the name and brand color.
  const icon = brand.logos.favicon ?? '/api/brand/icon';
  return {
    title: `${brand.name} | ${brand.tagline}`,
    description: brand.description,
    icons: { icon, shortcut: icon, apple: brand.logos.favicon ?? '/api/brand/icon?size=180' },
  };
}

// Runs before paint: applies the saved theme (or the OS preference when none is
// saved) to <html>, so there is no flash of the wrong theme, on every page,
// signed in or not. With no saved choice it also follows the OS live: switching
// the device to dark turns the open app dark. A change in one tab reaches the
// others through the storage event. Kept tiny and dependency-free.
const themeInitScript = `(function(){var d=document.documentElement;function saved(){try{var t=localStorage.getItem('theme');return t==='light'||t==='dark'?t:null;}catch(e){return null;}}var m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');function os(){return m&&!m.matches?'light':'dark';}d.setAttribute('data-theme',saved()||os());if(m){var f=function(){if(!saved())d.setAttribute('data-theme',os());};if(m.addEventListener)m.addEventListener('change',f);else if(m.addListener)m.addListener(f);}window.addEventListener('storage',function(e){if(e.key==='theme'||e.key===null)d.setAttribute('data-theme',saved()||os());});})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [brand, region] = await Promise.all([getBrand(), getRegion()]);
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased bg-surface font-sans">
        <BrandProvider brand={brand}>
          <RegionProvider region={region}>
            <ThemeProvider brand={brand}>{children}</ThemeProvider>
          </RegionProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
