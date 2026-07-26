import type { Metadata } from 'next';
import { siteConfig } from '@/site-config';

export const metadata: Metadata = {
  title: `${siteConfig.name} | Webhooks Documentation`,
  description: `Webhook documentation for ${siteConfig.name}. Receive signed invoice events on your own server, verify signatures, and reconcile.`,
};

export default function WebhooksDocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="animate-fadeIn min-h-screen bg-zinc-50">{children}</div>;
}
