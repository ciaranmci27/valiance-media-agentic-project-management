import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans } from 'next/font/google';
import { siteConfig } from '@/site-config';
import { ThemeProvider } from '@/components/ui/ThemeProvider';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="antialiased bg-[#FAFAFA] font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
