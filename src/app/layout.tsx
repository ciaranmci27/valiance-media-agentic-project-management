import type { Metadata } from 'next';
import './globals.css';
// The install's own theme, after core's so it wins (src/custom/theme.css).
import '../custom/theme.css';
import { DM_Sans, DM_Mono } from 'next/font/google';
import { ThemeProvider } from '@/components/ui/ThemeProvider';
import { BrandProvider } from '@/lib/brand/context';
import { getBrand } from '@/lib/brand/server';

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

// Runs before paint: applies the saved theme (or the OS preference on first visit)
// to <html> so there's no flash of the wrong theme. Kept tiny and dependency-free.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const brand = await getBrand();
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
          <ThemeProvider brand={brand}>{children}</ThemeProvider>
        </BrandProvider>
      </body>
    </html>
  );
}
