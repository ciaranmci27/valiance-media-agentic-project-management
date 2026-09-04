'use client';

import type { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';
import { siteConfig } from '@/site-config';

/** The stage every band of the portal sits on, as wide as the website's. */
export const STAGE = 'mx-auto w-full max-w-[1320px] px-5 sm:px-8';

/**
 * The element carrying `.vm`. The portal is Valiance teal for every client:
 * the brand is the vibe, the project name is the identity.
 */
export function PortalRoot({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="vm flex flex-col">
      <div className="vm-ambient" aria-hidden="true" />
      <div className="vm-grain" aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * The client's own logo, when the project has one. Decorative: the project
 * name sits beside or under it in every place this is used, so a screen
 * reader would only hear the same thing twice.
 */
export function ClientMark({ logoUrl, className = '' }: { logoUrl?: string; className?: string }) {
  if (!logoUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- client logos are arbitrary remote URLs
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      className={`border border-(--vm-line) object-cover ${className}`}
    />
  );
}

/**
 * Ours and theirs as one lockup: the client's logo is a small mark beside our
 * own, not a hero element. Client logos are arbitrary art, often with a white
 * background baked in, so at this size a stray one reads as a favicon rather
 * than a slab fighting the canvas.
 */
function Lockup({ logoUrl }: { logoUrl?: string }) {
  return (
    <div className="flex items-center gap-3.5">
      <Logo variant="dark" className="h-7 w-auto" />
      {logoUrl && (
        <>
          <span className="h-5 w-px bg-(--vm-line-strong)" aria-hidden="true" />
          <ClientMark logoUrl={logoUrl} className="h-7 w-7 rounded-md" />
        </>
      )}
    </div>
  );
}

/**
 * The lockup, the project name at display scale, one line under it.
 *
 * Deliberately no figures. Every number worth showing is a billing number,
 * and billing has too much shape (hourly work not yet invoiced, partial
 * payments, drafts, reimbursements) to survive as one word in a hero. The
 * money lives in the Invoices card, next to the invoices that prove it.
 */
export function PortalHeader({
  projectName,
  welcomeMessage,
  logoUrl,
}: {
  projectName: string;
  welcomeMessage?: string;
  logoUrl?: string;
}) {
  return (
    <header className={`${STAGE} pt-8 sm:pt-12`}>
      <div className="vm-fade">
        <Lockup logoUrl={logoUrl} />
        <h1 className="vm-display mt-12 text-[clamp(2.6rem,5vw,4.4rem)] sm:mt-16">{projectName}</h1>
        {/* A client's own welcome message is shown as written; only the fallback gets the serif turn. */}
        <p className="vm-lede mt-5 max-w-[60ch] sm:mt-6">
          {welcomeMessage || (
            <>
              Everything about your project, in <em className="vm-serif">one place.</em>
            </>
          )}
        </p>
      </div>
    </header>
  );
}

export function PortalFooter() {
  return (
    <footer className={`${STAGE} pb-10 pt-16 sm:pt-20`}>
      <div className="vm-hr" aria-hidden="true" />
      <div className="mt-6 flex flex-col gap-2 text-[13px] sm:flex-row sm:items-center sm:justify-between">
        <span className="vm-mono vm-faint">Prepared by {siteConfig.name}</span>
        <span className="vm-faint">Questions? Reply to any email from us.</span>
      </div>
    </footer>
  );
}

/** Canvas, hero header, and footer around the portal body. */
export function PortalShell({
  projectName,
  welcomeMessage,
  logoUrl,
  children,
}: {
  projectName: string;
  welcomeMessage?: string;
  logoUrl?: string;
  children: ReactNode;
}) {
  return (
    <PortalRoot>
      <PortalHeader
        projectName={projectName}
        welcomeMessage={welcomeMessage}
        logoUrl={logoUrl}
      />

      <main className={`${STAGE} flex-1 pt-10 sm:pt-14`}>
        {children}
      </main>

      <PortalFooter />
    </PortalRoot>
  );
}
