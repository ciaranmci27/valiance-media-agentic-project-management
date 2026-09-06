import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

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
    // The brand lockup, served with ETag revalidation. Public by nature (it
    // is on the marketing site), and the sim's fleet board textures from it:
    // behind the login wall, an anonymous visitor's texture load followed
    // the redirect into login-page HTML and crashed the whole scene.
    pathname.startsWith('/api/logo') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/portal') ||
    pathname.startsWith('/api/portal') ||
    pathname.startsWith('/api/v1') ||
    pathname.startsWith('/api/docs')
  );
}

export async function updateSession(request: NextRequest) {
  // These exact server endpoints verify their own dedicated bearer secrets.
  if (request.nextUrl.pathname === '/api/internal/accounting/invoices/snapshot' || request.nextUrl.pathname === '/api/internal/webhooks/scheduled') {
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

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
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
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('auth', 'required');
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from /login
  if (user && request.nextUrl.pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
