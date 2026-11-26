import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Check, ShieldAlert } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ConsentActions } from '@/components/connect-ai/ConsentActions';
import { requireSessionAccess } from '@/lib/api/access';
import { authorizeParamsFrom, checkAuthorizeRequest, connectAiState } from '@/lib/api/connect-ai';
import { CONNECT_NEVER, canOfferMemory, connectAbilities, connectScopesFor, consentWords, redirectHost } from '@/lib/connect-ai';
import { getBrand } from '@/lib/brand/server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connect an AI tool', robots: { index: false } };

/** This request's origin, as the server sees it (the issuer comes from NEXT_PUBLIC_APP_URL first). */
async function requestOrigin(): Promise<string> {
  const list = await headers();
  const host = list.get('x-forwarded-host') ?? list.get('host') ?? 'localhost';
  const proto = list.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * The consent screen an AI tool sends a person to (the OAuth authorization
 * endpoint). Sign-in comes first (the app's own, which returns here). It
 * names the tool, says in plain words what it may do as them and where they
 * go back to, and asks Allow or Deny. A link whose tool or return address is
 * not valid says why and sends nobody anywhere.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(raw)) if (typeof value === 'string') query.set(name, value);
  const params = authorizeParamsFrom(query);
  const brand = await getBrand();

  const auth = await requireSessionAccess({ memberColumns: 'name, email' });
  if (auth.error) {
    return <Notice brandName={brand.name} title="You cannot connect AI tools" message="Your account is suspended or not on this team. Ask an Owner for help." />;
  }
  const { access, service, memberRow } = auth.data;
  const state = await connectAiState(service);
  if (!state.ready) {
    return <Notice brandName={brand.name} title="Connect AI is not ready yet" message="This workspace needs its latest database update before AI tools can connect. Ask an Owner to apply it from Settings > Updates." />;
  }
  const check = await checkAuthorizeRequest(service, params, await requestOrigin());
  if (check.kind === 'page_error') return <Notice brandName={brand.name} title="This link is not valid" message={check.message} />;

  const scopes = connectScopesFor(access);
  const abilities = connectAbilities(scopes);
  const owner = access.role === 'owner';
  const blocked = !state.apiEnabled
    ? (owner
      ? 'API access is turned off for this workspace, so AI tools cannot connect. Turn on API access in Settings > Security, then try again.'
      : 'API access is turned off for this workspace, so AI tools cannot connect. An Owner can turn it on in Settings > Security.')
    : !state.ready || !state.enabled
      ? (owner
        ? 'Connecting AI tools is turned off for this workspace. Turn on "Let people connect AI tools" in Settings > Security, then try again.'
        : 'Connecting AI tools is turned off for this workspace. An Owner can turn it on in Settings > Security.')
      : access.role === 'agent' || scopes.length === 0
        ? 'Your account has no access to share with an AI tool yet. Ask an Owner to give you some in Team > Roles & permissions, on the API tab.'
        : check.kind === 'redirect_error' ? `The tool sent a request this app cannot accept: ${check.description}` : null;
  const name = check.client.client_name;
  const back = redirectHost(check.redirectUri);
  const words = consentWords(name, check.redirectUri);
  const person = memberRow as { name?: string; email?: string } | null;

  return (
    <div className="w-full max-w-md">
      <div className="mb-5 flex justify-center">
        <Logo className="h-10 w-auto dark:hidden" />
        <Logo variant="dark" className="hidden h-10 w-auto dark:block" />
      </div>
      <main className="glass-card rounded-xl p-5 lg:p-6" aria-labelledby="consent-heading">
        {/* Where it returns sits beside the name: the name is the tool's own claim, the address is not. */}
        <h1 id="consent-heading" className="text-lg font-semibold tracking-tight text-zinc-100">
          {name}, returning to <span className="break-all text-brand-200">{back}</span>
        </h1>
        <p className="text-base text-zinc-200">{words.subtitle}</p>
        <p className="mt-2 text-sm text-zinc-400">
          Signed in to {brand.name} as <span className="text-zinc-200">{person?.name ?? 'you'}</span>
          {person?.email ? <span> ({person.email})</span> : null}
        </p>

        {blocked ? (
          <div role="alert" className="mt-5 flex gap-3 rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-amber-100">
            <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p>{blocked}</p>
          </div>
        ) : (
          <>
            <p className="mt-5 text-xs font-medium text-zinc-400">It will be able to</p>
            <ul className="mt-2 space-y-2">
              {abilities.map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-zinc-200">
                  <Check size={15} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-4 rounded-lg bg-white/[0.03] px-3.5 py-2.5 text-xs leading-relaxed text-zinc-400">{CONNECT_NEVER}</p>
          </>
        )}

        <p className="mt-4 flex gap-2.5 rounded-lg bg-amber-500/[0.14] px-3.5 py-2.5 text-sm text-amber-100">
          <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{words.caution}</span>
        </p>

        <ConsentActions params={params} canAllow={!blocked} clientName={name} offerMemory={access.role !== 'agent' && canOfferMemory(access)} />

        <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-zinc-400">
          You can disconnect it any time in Settings, under Account.
        </p>
      </main>
    </div>
  );
}

function Notice({ brandName, title, message }: { brandName: string; title: string; message: string }) {
  return (
    <div className="w-full max-w-md">
      <main className="glass-card rounded-xl p-5 lg:p-6" aria-labelledby="consent-notice-heading">
        <h1 id="consent-notice-heading" className="text-lg font-semibold tracking-tight text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm text-zinc-300">{message}</p>
        <Link href="/dashboard" className="mt-5 inline-flex rounded text-sm font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          Go to {brandName}
        </Link>
      </main>
    </div>
  );
}
