'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { useDemo } from '@/lib/demo-context';
import { DEMO_USER_ID, DEMO_ADMIN_TEAM_MEMBER_ID } from '@/lib/demo-data';

interface AuthContextType {
  user: User | null;
  teamMemberId: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [teamMemberId, setTeamMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();
  const { isDemoMode, isEnvForcedDemo } = useDemo();

  useEffect(() => {
    if (isEnvForcedDemo) {
      setUser({ id: DEMO_USER_ID, email: 'demo@example.com' } as User);
      setTeamMemberId(DEMO_ADMIN_TEAM_MEMBER_ID);
      setLoading(false);
      return;
    }

    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);

      if (user) {
        // Find the team_member linked to this auth user
        // (auto-created by DB trigger on signup)
        const { data: teamMember } = await supabase
          .from('team_members')
          .select('id')
          .eq('auth_user_id', user.id)
          .single();

        if (teamMember) {
          setTeamMemberId(teamMember.id);
        }
      }

      setLoading(false);
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
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [isEnvForcedDemo]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setTeamMemberId(null);
    router.push('/login');
  };

  // When demo mode is admin-toggled (not env-forced), the real user session
  // stays active but we override teamMemberId so task filters, dashboard
  // widgets, etc. reference a demo team member instead of the real one.
  const effectiveTeamMemberId = isDemoMode && !isEnvForcedDemo
    ? DEMO_ADMIN_TEAM_MEMBER_ID
    : teamMemberId;

  return (
    <AuthContext.Provider value={{ user, teamMemberId: effectiveTeamMemberId, loading, signOut }}>
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
