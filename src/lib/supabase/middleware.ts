import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { sessionUser } from './session-user';
import { safeNextPath } from './next-path';
import customPublicPaths from '@/custom/middleware';
import { matchesPublicPath } from '@/lib/extensions/registry';
import { PM_DB } from '@/lib/supabase/schema';

export function isPublicRoute(pathname: string) {
  return (
    // Local-only preview surfaces (visual iteration without a session); the
    // pages themselves also 404 outside development.
    (process.env.NODE_ENV === 'development' && pathname.startsWith('/dev')) ||
    // The workspace's logo and generated favicon. Public by nature: the
    // sign-in page, the client portal and emails show them to visitors who
    // are not signed in, and behind the login wall an image request would
    // follow the redirect into login-page HTML.
    pathname.startsWith('/api/logo') ||
    pathname.startsWith('/api/brand/') ||
    pathname.startsWith('/login') ||
    // An invited person choosing their password: the link's token signs them in.
    pathname === '/welcome/set-password' ||
    pathname === '/api/welcome/set-password' ||
    // A fresh install's first account (the setup wizard's first step). Both
    // answer only while nobody is on the team; after that, never again.
    pathname === '/welcome/create-account' ||
    // Shown when the Supabase settings themselves are missing: it reads nothing.
    pathname === '/setup-required' ||
    pathname === '/api/welcome/owner' ||
    // Before leaving for Google (sign-in, an invite, the first Owner). Linking
    // checks the session itself.
    pathname === '/api/auth/google' ||
    // Forgot password: asking for a link, and where the link lands (its tokens sign them in there).
    pathname === '/api/auth/reset' ||
    pathname === '/welcome/reset-password' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/portal') ||
    pathname.startsWith('/api/portal') ||
    pathname.startsWith('/api/v1') ||
    // The MCP server authenticates an API key or a connected AI tool's token, like /api/v1.
    pathname === '/api/mcp' ||
    // Connect AI (OAuth for the MCP server): the metadata documents, client
    // registration and the token endpoint answer AI tools, never a browser
    // session. The consent page (/oauth/authorize) stays behind sign-in.
    pathname.startsWith('/.well-known/oauth-') ||
    pathname === '/api/oauth/register' ||
    pathname === '/api/oauth/token' ||
    pathname.startsWith('/api/docs') ||
    // The SMTP and webhook guides: static docs, like /api/docs.
    pathname === '/smtp/docs' ||
    pathname === '/webhooks/docs' ||
    // The install's own endpoints: each route checks its declared auth itself
    // (a session by default, an API key, or public by explicit opt-in), so an
    // API key call is answered rather than sent to the login page.
    pathname.startsWith('/api/x/') ||
    // Files an install drops in public/custom. Public by nature, like /api/logo.
    pathname.startsWith('/custom/') ||
    // Paths the install opened in src/custom/middleware.ts.
    matchesPublicPath(customPublicPaths, pathname)
  );
}

export async function updateSession(request: NextRequest) {
  // These exact server endpoints verify their own dedicated bearer secrets.
  // The inbound email webhook verifies Resend's Svix signature; the inbound
  // email and invoice-draft crons verify Vercel's CRON_SECRET bearer.
  if (
    request.nextUrl.pathname === '/api/internal/webhooks/scheduled'
    || request.nextUrl.pathname === '/api/internal/schedules/run'
    || request.nextUrl.pathname === '/api/inbound-email/resend'
    || request.nextUrl.pathname === '/api/internal/inbound-email/retention'
    || request.nextUrl.pathname === '/api/internal/inbound-email/orphan-sweep'
    || request.nextUrl.pathname === '/api/internal/billing/draft-digest'
    // Chat providers (Slack, Telegram): each request is verified by its connection's adapter.
    || request.nextUrl.pathname.startsWith('/api/chat/inbound/')
  ) {
    return NextResponse.next({ request });
  }
  // In env-forced demo mode, skip all auth checks. Requires the server-only
  // DEMO_MODE flag in addition to the public one, so a mis-set public env var
  // can never disable auth on a real deployment.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') {
    return NextResponse.next({ request });
  }

  // Without the Supabase settings nothing can load: every page goes to the
  // static page that names them (it reads nothing and shows no values).
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) {
    // The logo and favicon routes fall back to the default brand without a database.
    if (request.nextUrl.pathname.startsWith('/api/brand/') || request.nextUrl.pathname.startsWith('/api/logo')) return NextResponse.next({ request });
    if (request.nextUrl.pathname === '/setup-required' || request.nextUrl.pathname.startsWith('/_next') || request.nextUrl.pathname.startsWith('/api/')) {
      return request.nextUrl.pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'The app is not connected to Supabase yet.' }, { status: 503 })
        : NextResponse.next({ request });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/setup-required';
    url.search = '';
    return NextResponse.rewrite(url, { request });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: PM_DB,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refreshes an expired session (writing the new cookies through setAll
  // above), then verifies the token (sessionUser: auth.getClaims). With an
  // asymmetric signing key (ES256/RS256, published as JWKS) that check is
  // local, the keys cached per server instance; a project still on the legacy
  // symmetric secret (HS256) asks Supabase Auth instead, one call per request.
  let user = null;
  try {
    user = await sessionUser(supabase as unknown as Parameters<typeof sessionUser>[0]);
  } catch {
    // If auth check fails, treat as unauthenticated
  }

  // An API call is answered by its route, never the login page: every API
  // route checks its own credentials (a session, an API key, a signature or
  // a cron secret) and answers 401 in JSON, which a script or the app's own
  // fetch can read. The session refresh above still applies to them.
  if (!user && request.nextUrl.pathname.startsWith('/api/')) {
    return supabaseResponse;
  }

  // Redirect unauthenticated users to /login (except auth routes). The
  // auth=required marker tells the login page not to auto-redirect back to
  // /dashboard when the public demo flag is set but the server-side DEMO_MODE
  // latch is not (otherwise a mis-set NEXT_PUBLIC_DEMO_MODE causes a loop).
  if (!user && !isPublicRoute(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    // Where they were headed (a task link from Telegram, say), so login can
    // send them there instead of the dashboard.
    const destination = request.nextUrl.pathname + request.nextUrl.search;
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('auth', 'required');
    if (destination !== '/' && destination !== '/dashboard') url.searchParams.set('next', destination);
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from /login
  if (user && request.nextUrl.pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    const next = safeNextPath(request.nextUrl.searchParams.get('next'));
    url.pathname = next ? next.split('?')[0] : '/dashboard';
    url.search = next && next.includes('?') ? next.slice(next.indexOf('?')) : '';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
