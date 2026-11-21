import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AlertTriangle, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { CopyCode } from '@/components/settings/updates/parts';
import { SUPABASE_VARS, supabaseConnected } from '@/lib/setup/checks';

// Reads the host's settings on every request, never at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connect Supabase' };

const WHERE: Record<(typeof SUPABASE_VARS)[number], string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'The Project URL.',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'The anon public key.',
  SUPABASE_SERVICE_ROLE_KEY: 'The service_role key. It is secret: add it on the server only, never in browser code.',
};

/**
 * Shown when the app cannot reach its database: the middleware sends every
 * page here while the Supabase URL or anon key is missing, and the setup
 * wizard does when any of the three is. It reads nothing and needs no
 * sign-in; it says set or not set per setting, never a value.
 */
export default function SetupRequiredPage() {
  if (supabaseConnected(process.env)) redirect('/');
  const vars = SUPABASE_VARS.map((name) => ({ name, set: (process.env[name]?.trim() ?? '') !== '' }));

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-[46rem] items-center px-4 pb-2 pt-5 sm:px-8 sm:pt-8">
        <div className="flex h-8 items-center">
          <Logo className="h-7 w-auto max-w-[180px] dark:hidden" />
          <Logo variant="dark" className="hidden h-7 w-auto max-w-[180px] dark:block" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[46rem] flex-1 px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-[28px] sm:leading-tight">Connect Supabase</h1>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-zinc-400">
            The app can&apos;t reach its database yet. Add these settings in your host, then redeploy.
          </p>

          <section aria-labelledby="supabase-settings" className="mt-8">
            <h2 id="supabase-settings" className="text-xs font-medium text-zinc-400">
              From the Supabase dashboard: Project Settings, API
            </h2>
            <ul className="mt-3 divide-y divide-white/[0.06]">
              {vars.map(({ name, set }) => (
                <li key={name} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 py-4 first:pt-1 last:pb-0">
                  <div className="min-w-0 flex-1 basis-60">
                    <CopyCode text={name} />
                    <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{WHERE[name]}</p>
                  </div>
                  {set ? (
                    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-emerald-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-emerald-200">
                      <Check size={12} aria-hidden="true" />
                      Set
                    </span>
                  ) : (
                    <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-200">
                      <AlertTriangle size={12} aria-hidden="true" />
                      Not set
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <ol className="mt-8 list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-zinc-300">
            <li>
              In your host (on Vercel: Project, Settings, Environment Variables) add each one for Production; running locally, add them to{' '}
              <span className="font-mono text-xs text-zinc-100">.env.local</span>.
            </li>
            <li>Redeploy, or restart the app locally.</li>
            <li>Check again.</li>
          </ol>

          <div className="mt-10 flex justify-end border-t border-white/[0.06] pt-5">
            {/* Going to / runs the middleware and the server again, so they read the settings afresh. */}
            <Button href="/">Check again</Button>
          </div>
        </div>
      </main>
    </div>
  );
}
