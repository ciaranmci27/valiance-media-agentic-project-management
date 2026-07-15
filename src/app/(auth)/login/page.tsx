'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { siteConfig } from '@/site-config';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';

const ENV_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    // Skip the demo auto-redirect when the middleware just bounced us here
    // (auth=required): the public demo flag is set but the server-side
    // DEMO_MODE latch is not, so redirecting again would loop forever.
    const bouncedByAuth = new URLSearchParams(window.location.search).has('auth');
    if (ENV_DEMO && !bouncedByAuth) {
      router.replace('/dashboard');
    }
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push('/dashboard');
  };

  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-4">
        <div className="flex flex-col items-center mb-4">
          <Logo className="h-12 w-auto" />
          {siteConfig.showNameUnderLogo && (
            <span className="text-zinc-900 font-semibold text-[7px] tracking-[0.2em] uppercase">{siteConfig.name}</span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-zinc-900">Welcome back</h1>
        <p className="text-sm text-zinc-500 mt-1">Sign in to {siteConfig.name}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        )}

        <TextInput
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          required
        />

        <PasswordInput
          label="Password"
          value={password}
          onChange={setPassword}
          placeholder="Your password"
          required
          showIcon={false}
        />

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 px-4 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading && <Loader2 size={16} className="animate-spin" />}
          Sign In
        </button>
      </form>

      <p className="text-center text-sm text-zinc-500 mt-4">
        Contact your administrator for access.
      </p>
    </div>
  );
}
