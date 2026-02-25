import type { Metadata } from 'next';
import { siteConfig } from '@/site-config';

export const metadata: Metadata = {
  title: `${siteConfig.name} | SMTP Documentation`,
  description: `SMTP email infrastructure documentation for ${siteConfig.name}. Configure accounts, send transactional and relay emails, and manage encryption.`,
};

export default function SmtpDocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="animate-fadeIn min-h-screen bg-zinc-50">{children}</div>;
}
