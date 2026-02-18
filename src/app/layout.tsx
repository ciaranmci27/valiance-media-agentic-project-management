import type { Metadata } from 'next';
import './globals.css';
import { DM_Sans } from 'next/font/google';

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
});

export const metadata: Metadata = {
  title: 'ProjectEM — Project Management',
  description: 'Project management by ProjectEM',
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
