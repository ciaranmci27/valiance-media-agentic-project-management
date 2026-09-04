'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { BrandLoader } from '@/components/ui/BrandLoader';
import { Logo } from '@/components/ui/Logo';
import { PORTAL_STEPS } from './loaderSteps';
import { PortalRoot } from './PortalShell';

/**
 * Waiting for the portal payload: the shared brand loader on the portal's
 * canvas. `leaving` dissolves the stage for the page, and `onLeft` is called
 * once that dissolve has finished playing.
 */
export function PortalLoading({
  leaving = false,
  onLeft,
  steps = PORTAL_STEPS,
  announcement = 'Loading your portal',
}: {
  leaving?: boolean;
  onLeft?: () => void;
  /** The lines the status reads, in order; the last one holds. */
  steps?: readonly string[];
  /** The one thing a screen reader hears, instead of every line. */
  announcement?: string;
}) {
  return (
    <PortalRoot>
      <main className="flex flex-1 items-center justify-center px-5 sm:px-8">
        <BrandLoader steps={steps} announcement={announcement} leaving={leaving} onLeft={onLeft} />
      </main>
    </PortalRoot>
  );
}

/** Full-page: a centred card for a portal or file that cannot be shown. */
export function PortalError({
  title,
  message,
  backHref,
}: {
  title: string;
  message: string;
  /** When set, a "Back to portal" link follows the message. */
  backHref?: string;
}) {
  return (
    <PortalRoot>
      <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
        <div className="vm-glass vm-card vm-rise w-full max-w-[26rem] p-8 sm:p-10">
          <Logo variant="dark" className="h-6 w-auto" />
          <h1 className="vm-h2 mt-8">{title}</h1>
          <p className="vm-muted mt-2.5 text-[15px] leading-relaxed">{message}</p>
          {backHref && (
            <Link href={backHref} className="vm-btn vm-btn-ghost vm-btn-sm mt-7">
              <ArrowLeft size={15} aria-hidden="true" />
              Back to portal
            </Link>
          )}
        </div>
      </main>
    </PortalRoot>
  );
}

/** Inside the shell: the portal is live but no section has anything to show. */
export function PortalEmpty() {
  return (
    <div className="vm-glass vm-card vm-rise p-8 text-center sm:p-12">
      <h2 className="vm-h2">Nothing here yet</h2>
      <p className="vm-muted mt-2.5 text-[15px]">Check back soon for updates.</p>
    </div>
  );
}
