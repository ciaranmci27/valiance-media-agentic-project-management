'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { EMAIL_PAGES, useSettingsAccess } from '@/components/settings/settings-groups';

/**
 * A page under Settings > Email: a breadcrumb back to the overview, then the
 * page. Someone without the permission the page needs goes back to the
 * overview, which shows only what they can open.
 */
export function EmailSubpage({
  title,
  need,
  children,
}: {
  title: string;
  /** inbox: inbound_email.manage. smtp: smtp.manage (and not demo mode). */
  need: 'inbox' | 'smtp';
  children: ReactNode;
}) {
  const router = useRouter();
  const { show } = useSettingsAccess();
  const allowed = need === 'inbox' ? show.emailInboxes : show.smtp;

  useEffect(() => {
    if (!allowed) router.replace(EMAIL_PAGES.overview);
  }, [allowed, router]);

  if (!allowed) return null;

  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm">
          <li>
            <Link
              href={EMAIL_PAGES.overview}
              className="inline-flex items-center gap-1 rounded-md py-0.5 pr-1 text-zinc-400 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Email
            </Link>
          </li>
          <li aria-hidden="true" className="text-zinc-600">/</li>
          <li aria-current="page" className="font-medium text-white">{title}</li>
        </ol>
      </nav>
      {children}
    </>
  );
}
