import type { Metadata } from 'next';
import { siteConfig } from '@/site-config';

export const metadata: Metadata = {
  title: `${siteConfig.name} | SMTP Documentation`,
  description: `SMTP email infrastructure documentation for ${siteConfig.name}. Configure accounts, send transactional and relay emails, and manage encryption.`,
};

export default function SmtpDocsLayout({ children }: { children: React.ReactNode }) {
  // Docs are always light and authored against the standard palette. data-theme="dark"
  // pins the subtree to the default token values so the light theme's zinc/ink remaps
  // on <html> can't invert the page (same pattern as the always-dark sidebar).
  return <div data-theme="dark" className="animate-fadeIn min-h-screen bg-zinc-50">{children}</div>;
}
