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

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
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
