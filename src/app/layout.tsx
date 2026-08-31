import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans, DM_Mono } from 'next/font/google';
import { siteConfig } from '@/site-config';
import { ThemeProvider } from '@/components/ui/ThemeProvider';

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

export const metadata: Metadata = {
  title: `${siteConfig.name} | ${siteConfig.tagline}`,
  description: siteConfig.description,
  icons: {
    icon: [
      { url: '/favicon/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    shortcut: '/favicon/favicon.ico',
    apple: '/favicon/apple-touch-icon.png',
  },
  manifest: '/favicon/site.webmanifest',
};

// Runs before paint: applies the saved theme (or the OS preference on first visit)
// to <html> so there's no flash of the wrong theme. Kept tiny and dependency-free.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
