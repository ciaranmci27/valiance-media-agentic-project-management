'use client';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AppProvider, useApp } from '@/lib/store';
import { DemoProvider } from '@/lib/demo-context';
import { Sidebar } from '@/components/layout/Sidebar';
import { DemoBanner } from '@/components/layout/DemoBanner';
import { KeyboardShortcuts } from '@/components/layout/KeyboardShortcuts';
import { ToastContainer } from '@/components/ui/Toast';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, access, accessError, loading, refreshAccess, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <Loader2 className="animate-spin text-zinc-300" size={28} />
      </div>
    );
  }

  if (!access) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-zinc-900">Workspace access unavailable</h1>
          <p className="mt-2 text-sm text-zinc-500">{accessError || 'Your account is signed in but its team access could not be loaded.'}</p>
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
  const { loading } = useApp();

  return (
    <>
      <Sidebar />
      <main className="lg:ml-60 min-h-screen bg-zinc-50">
        <DemoBanner />
        {!loading && children}
      </main>
      <KeyboardShortcuts />
      <ToastContainer />
    </>
  );
}

export function ProtectedShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <AuthProvider>
        <AuthGate>
          <AppProvider>
            <StoreGate>{children}</StoreGate>
          </AppProvider>
        </AuthGate>
      </AuthProvider>
    </DemoProvider>
  );
}
