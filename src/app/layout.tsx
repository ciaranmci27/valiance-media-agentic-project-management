import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans } from 'next/font/google';
import { siteConfig } from '@/site-config';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
});

export const metadata: Metadata = {
  title: `${siteConfig.name} | ${siteConfig.tagline}`,
  description: siteConfig.description,
  icons: { icon: '/logos/logo.svg' },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="antialiased bg-[#FAFAFA] font-sans">
        {children}
      </body>
    </html>
  );
}
