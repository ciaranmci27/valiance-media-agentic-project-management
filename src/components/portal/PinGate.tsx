'use client';

import type { RefObject } from 'react';
import { Logo } from '@/components/ui/Logo';
import { PinInput, type PinInputRef } from '@/components/ui/PinInput';
import { ClientMark, PortalRoot } from './PortalShell';

/** The one PIN screen, shared by the portal page and the file viewer. */
export function PinGate({
  projectName,
  logoUrl,
  pin,
  onChange,
  onComplete,
  error,
  submitting,
  pinRef,
}: {
  projectName?: string;
  logoUrl?: string;
  pin: string;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  error: boolean;
  submitting: boolean;
  pinRef?: RefObject<PinInputRef | null>;
}) {
  return (
    <PortalRoot>
      <main className="flex flex-1 items-center justify-center px-5 py-16 sm:px-8">
        <div className="vm-glass-strong vm-card vm-rise w-full max-w-[26rem] p-8 sm:p-10">
          {/* The shake lives on an inner wrapper so it never replaces the card's rise-in. */}
          <div className={error ? 'vm-shake' : undefined}>
            <div className="flex items-center gap-3.5">
              <Logo variant="dark" className="h-7 w-auto" />
              {logoUrl && (
                <>
                  <span className="h-5 w-px bg-(--vm-line-strong)" aria-hidden="true" />
                  <ClientMark logoUrl={logoUrl} className="h-7 w-7 rounded-md" />
                </>
              )}
            </div>
            <h1 className="vm-h1 mt-9">{projectName || 'Client portal'}</h1>
            <p className="vm-lede mt-3">
              Enter your PIN to <em className="vm-serif">continue.</em>
            </p>

            <div className="mt-8">
              <PinInput
                ref={pinRef}
                value={pin}
                onChange={onChange}
                onComplete={onComplete}
                size="lg"
                error={error}
                autoFocus
                disabled={submitting}
                className="justify-between"
              />
            </div>

            <div className="mt-4 min-h-6" aria-live="polite">
              {error && (
                <p className="text-[14px]" style={{ color: 'var(--vm-error)' }}>
                  Incorrect PIN. Please try again.
                </p>
              )}
              {submitting && (
                <p className="vm-mono vm-faint flex items-center text-[11px] uppercase tracking-[0.14em]">
                  Checking
                  <span className="vm-dots" aria-hidden="true"><i /><i /><i /></span>
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
    </PortalRoot>
  );
}
