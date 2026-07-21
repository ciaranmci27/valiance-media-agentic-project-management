'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { useDemo } from '@/lib/demo-context';
import { DEMO_USER_ID, DEMO_ADMIN_TEAM_MEMBER_ID } from '@/lib/demo-data';
import type { AccessContext } from '@/lib/access-control';

interface AuthContextType {
  user: User | null;
  teamMemberId: string | null;
  access: AccessContext | null;
  accessError: string | null;
  loading: boolean;
  refreshAccess: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [teamMemberId, setTeamMemberId] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessContext | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const { isDemoMode, isEnvForcedDemo } = useDemo();

  const loadWorkspaceIdentity = useCallback(async () => {
    const response = await fetch('/api/workspace/me', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) {
      const message = payload.error || 'Failed to load workspace access';
      setAccessError(message);
      throw new Error(message);
    }
    const resolvedAccess = payload.data.access as AccessContext;
    setTeamMemberId(resolvedAccess.member_id);
    setAccess((current) => JSON.stringify(current) === JSON.stringify(resolvedAccess) ? current : resolvedAccess);
    setAccessError(null);
  }, []);

  useEffect(() => {
    if (isEnvForcedDemo) {
      setUser({ id: DEMO_USER_ID, email: 'demo@example.com' } as User);
      setTeamMemberId(DEMO_ADMIN_TEAM_MEMBER_ID);
      setAccess({
        member_id: DEMO_ADMIN_TEAM_MEMBER_ID,
        role: 'owner',
        status: 'active',
        app_permissions: ['*'],
        api_permissions: ['*'],
        project_ids: [],
      });
      setAccessError(null);
      setLoading(false);
      return;
    }

    const getUser = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        setUser(user);

        if (user) {
          try {
            await loadWorkspaceIdentity();
          } catch (error) {
            setTeamMemberId(null);
            setAccess(null);
            setAccessError(error instanceof Error ? error.message : 'Failed to load workspace access');
          }
        } else {
          setTeamMemberId(null);
          setAccess(null);
          setAccessError(null);
        }
      } catch {
        setUser(null);
        setTeamMemberId(null);
        setAccess(null);
        setAccessError(null);
      } finally {
        setLoading(false);
      }
    };

    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        const nextUser = session?.user ?? null;
        // Dedupe by id+updated_at so a no-op TOKEN_REFRESHED (Supabase
        // auto-refreshes the JWT every tab focus) doesn't propagate a new
        // user reference. Without this, every focus cascades through
        // AppProvider's loadData effect and replaces every state array,
        // causing visible re-renders downstream (e.g. the invoice PDF
        // preview regenerating its blob on every tab switch).
        setUser((prev) => {
          if (
            prev?.id === nextUser?.id &&
            prev?.updated_at === nextUser?.updated_at
          ) {
            return prev;
          }
          return nextUser;
        });
        if (!session?.user) {
          setTeamMemberId(null);
          setAccess(null);
          setAccessError(null);
        } else if (_event === 'SIGNED_IN' || _event === 'USER_UPDATED') {
          try {
            await loadWorkspaceIdentity();
          } catch (error) {
            setTeamMemberId(null);
            setAccess(null);
            setAccessError(error instanceof Error ? error.message : 'Failed to load workspace access');
          }
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [isEnvForcedDemo, loadWorkspaceIdentity, supabase]);

  useEffect(() => {
    if (!user || isEnvForcedDemo) return;
    const refreshOnFocus = () => { void loadWorkspaceIdentity().catch(() => {}); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [isEnvForcedDemo, loadWorkspaceIdentity, user]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setTeamMemberId(null);
    setAccess(null);
    setAccessError(null);
    router.push('/login');
  };

  // When demo mode is admin-toggled (not env-forced), the real user session
  // stays active but we override teamMemberId so task filters, dashboard
  // widgets, etc. reference a demo team member instead of the real one.
  const effectiveTeamMemberId = isDemoMode && !isEnvForcedDemo
    ? DEMO_ADMIN_TEAM_MEMBER_ID
    : teamMemberId;

  const effectiveAccess = isDemoMode && !isEnvForcedDemo
    ? {
        member_id: DEMO_ADMIN_TEAM_MEMBER_ID,
        role: 'owner' as const,
        status: 'active' as const,
        app_permissions: ['*' as const],
        api_permissions: ['*' as const],
        project_ids: [],
      }
    : access;

  return (
    <AuthContext.Provider value={{ user, teamMemberId: effectiveTeamMemberId, access: effectiveAccess, accessError, loading, refreshAccess: loadWorkspaceIdentity, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
