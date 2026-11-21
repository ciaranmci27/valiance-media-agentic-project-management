import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { sessionUser } from './session-user';
import { safeNextPath } from './next-path';
import customPublicPaths from '@/custom/middleware';
import { matchesPublicPath } from '@/lib/extensions/registry';

function isPublicRoute(pathname: string) {
  return (
    // Local-only preview surfaces (visual iteration without a session); the
    // pages themselves also 404 outside development.
    (process.env.NODE_ENV === 'development' && pathname.startsWith('/dev')) ||
    // The public agent floor and its read-only data window. The route serves
    // a fixed payload of exactly what the scene renders — no anon database
    // grants stand behind it, and it caches server-side so visitor count
    // never reaches the tables.
    pathname === '/live' ||
    pathname === '/api/live/state' ||
    // The workspace's logo and generated favicon. Public by nature: the
    // sign-in page, the client portal and emails show them to visitors who
    // are not signed in, and behind the login wall an image request would
    // follow the redirect into login-page HTML.
    pathname.startsWith('/api/logo') ||
    pathname.startsWith('/api/brand/') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/portal') ||
    pathname.startsWith('/api/portal') ||
    pathname.startsWith('/api/v1') ||
    // The MCP server authenticates an API key, like /api/v1.
    pathname === '/api/mcp' ||
    pathname.startsWith('/api/docs') ||
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
    || request.nextUrl.pathname === '/api/inbound-email/resend'
    || request.nextUrl.pathname === '/api/internal/inbound-email/retention'
    || request.nextUrl.pathname === '/api/internal/inbound-email/orphan-sweep'
    || request.nextUrl.pathname === '/api/internal/billing/draft-digest'
  ) {
    return NextResponse.next();
  }
  // In env-forced demo mode, skip all auth checks. Requires the server-only
  // DEMO_MODE flag in addition to the public one, so a mis-set public env var
  // can never disable auth on a real deployment.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && process.env.DEMO_MODE === 'true') {
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
  // above), then verifies the token locally rather than asking Supabase Auth
  // on every request.
  let user = null;
  try {
    user = await sessionUser(supabase);
  } catch {
    // If auth check fails, treat as unauthenticated
  }

  // /agent/live is shareable: a member sees the real floor, and anyone else
  // is REWRITTEN (not redirected) to the public simulation, so the address
  // they were sent is the address that works, with no login wall and no URL
  // change. The sim page runs on fixtures alone, so an anonymous visitor
  // reaches no real data — the same guarantee /live makes when hit directly.
  if (!user && request.nextUrl.pathname === '/agent/live') {
    const url = request.nextUrl.clone();
    url.pathname = '/live';
    url.search = '';
    return NextResponse.rewrite(url);
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
