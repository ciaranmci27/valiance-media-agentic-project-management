'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AppProvider, useApp } from '@/lib/store';
import { DemoProvider } from '@/lib/demo-context';
import { Sidebar } from '@/components/layout/Sidebar';
import { ThemeSync } from '@/components/layout/ThemeSync';
import { DemoBanner } from '@/components/layout/DemoBanner';
import { KeyboardShortcuts } from '@/components/layout/KeyboardShortcuts';
import { ToastContainer } from '@/components/ui/Toast';
import { BrandLoader } from '@/components/ui/BrandLoader';
import { Button } from '@/components/ui/Button';

/**
 * Booting the shell has two real phases, the session check and the first data
 * load, and the user sees one screen across both: the brand loader, full page,
 * until the sidebar and the page can arrive together. The status line follows
 * the phase that is actually running, and nothing here waits for effect: the
 * screen leaves the instant the shell is ready.
 */
const BOOT_STEPS = ['Verifying your access', 'Syncing workspace data'];

type StoreState = 'pending' | 'loading' | 'ready';

// The store lives inside the auth gate, so its loading flag cannot be read
// from above it. It reports up through this context instead, which lets one
// boot screen outside both gates decide when the whole shell is ready.
const BootContext = createContext<{
  storeState: StoreState;
  setStoreState: (state: StoreState) => void;
}>({ storeState: 'pending', setStoreState: () => {} });

function BootProvider({ children }: { children: React.ReactNode }) {
  const [storeState, setStoreState] = useState<StoreState>('pending');
  return <BootContext.Provider value={{ storeState, setStoreState }}>{children}</BootContext.Provider>;
}

/** Inside the store: keeps the boot context in step with the first load. */
function StoreStateReporter() {
  const { loading } = useApp();
  const { setStoreState } = useContext(BootContext);
  useEffect(() => {
    setStoreState(loading ? 'loading' : 'ready');
    // Signing out unmounts the store; the next sign-in starts from pending
    // again instead of inheriting a stale "ready".
    return () => setStoreState('pending');
  }, [loading, setStoreState]);
  return null;
}

/** The one loading screen: up while the session or the store is still coming, gone the instant both are ready. */
function BootScreen() {
  const { user, loading, access } = useAuth();
  const { storeState } = useContext(BootContext);
  const authPending = loading || !user;
  // A signed-in user without workspace access gets AuthGate's own card.
  if (!authPending && !access) return null;
  if (!authPending && storeState === 'ready') return null;
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <BrandLoader steps={BOOT_STEPS} step={authPending ? 0 : 1} announcement="Loading your workspace" />
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, access, accessError, loading, refreshAccess, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  // The boot screen is on; nothing else should paint yet.
  if (loading || !user) return null;

  if (!access) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass-card w-full max-w-md rounded-xl p-6 text-center">
          <h1 className="text-lg font-semibold text-white">Workspace access unavailable</h1>
          <p className="mt-2 text-sm text-zinc-400">{accessError || 'Your account is signed in but its team access could not be loaded.'}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
            <Button onClick={() => void refreshAccess().catch(() => {})}>Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function StoreGate({ children }: { children: React.ReactNode }) {
  // Gated on the boot context, not on the store's own flag: the boot screen
  // reads the context, so both switch in the same render. Reading the store
  // flag here would mount the sidebar one render before the boot screen heard
  // about it, and both would be on screen for a frame.
  const { storeState } = useContext(BootContext);

  return (
    <>
      {/* Mounted through the load so the saved theme applies the moment the
          team arrives, and any toast raised during boot has a home. */}
      <ThemeSync />
      <ToastContainer />
      {/* The sidebar and the page mount together, once, so nothing shifts. */}
      {storeState === 'ready' && (
        <>
          <Sidebar />
          <main className="lg:ml-60 min-h-screen">
            <DemoBanner />
            {children}
          </main>
          <KeyboardShortcuts />
        </>
      )}
    </>
  );
}

export function ProtectedShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <AuthProvider>
        <BootProvider>
          <BootScreen />
          <AuthGate>
            <AppProvider>
              <StoreStateReporter />
              <StoreGate>{children}</StoreGate>
            </AppProvider>
          </AuthGate>
        </BootProvider>
      </AuthProvider>
    </DemoProvider>
  );
}
