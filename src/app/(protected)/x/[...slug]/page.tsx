'use client';

import { notFound, useParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { useCustomPage } from '@/lib/extensions/hooks';

/**
 * The install's own pages (src/custom/index.ts `pages`), at /x/<slug>, inside
 * the signed-in shell like every core page. An unknown slug, or a page this
 * member may not see, is the app's not-found.
 */
export default function CustomPage() {
  const params = useParams<{ slug: string[] }>();
  const match = useCustomPage(params.slug ?? []);
  if (!match) notFound();

  const { page, rest } = match;
  const Body = page.component;
  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title={page.title} subtitle={page.subtitle} />
      <div className="p-4 lg:p-6 space-y-6">
        <Body rest={rest} />
      </div>
    </div>
  );
}
