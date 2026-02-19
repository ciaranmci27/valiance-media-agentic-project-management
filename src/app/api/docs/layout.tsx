import type { Metadata } from 'next';
import { siteConfig } from '@/site-config';

export const metadata: Metadata = {
  title: `${siteConfig.name} | API Documentation`,
  description: `REST API documentation for ${siteConfig.name}. Manage projects, tasks, leads, contacts, and more via authenticated API endpoints.`,
};

export default function ApiDocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="animate-fadeIn min-h-screen bg-zinc-50">{children}</div>;
}
