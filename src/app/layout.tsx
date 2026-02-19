import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans } from 'next/font/google';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
});

export const metadata: Metadata = {
  title: 'ProjectEM | Client Portal',
  description: 'Manage projects, track leads, and collaborate with our team, all in one place. Our internal hub for project and client management.',
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
