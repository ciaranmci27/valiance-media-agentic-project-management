'use client';

import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AppProvider } from '@/lib/store';
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="animate-spin text-brand-600" size={32} />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}

export function ProtectedShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <AuthProvider>
        <AuthGate>
          <AppProvider>
            <Sidebar />
            <main className="lg:ml-60 min-h-screen">
              <DemoBanner />
              {children}
            </main>
            <KeyboardShortcuts />
            <ToastContainer />
          </AppProvider>
        </AuthGate>
      </AuthProvider>
    </DemoProvider>
  );
}
