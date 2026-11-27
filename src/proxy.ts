import { updateSession } from '@/lib/supabase/middleware';
import { foreignOrigin, needsOriginCheck } from '@/lib/security/origin';
import { NONCE_HEADER, newScriptNonce, pageContentSecurityPolicy, pagePolicyApplies } from '@/lib/security/frame-headers';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The app's request proxy (Next 16's name for middleware): the sign-in wall
 * for pages, the `next` return path, the session refresh, CORS for the
 * public API, and each page's script nonce (Content-Security-Policy).
 * Next loads it only from `proxy.ts` beside the app directory, which is
 * `src/` here (next/dist/build/index.js: rootDir is the parent of src/app,
 * and the file must sit at '/' or '/src' of it). Up to 2.0.49 it sat
 * at the app root as middleware.ts, where Next never loaded it.
 * `npm run test:security-hardening` fails if it moves.
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization, Idempotency-Key, x-act-for',
  'Access-Control-Max-Age': '86400',
};

/**
 * Connect AI's OAuth documents and endpoints are called by AI tools,
 * some from a browser (an MCP inspector, a web client), so they answer any
 * origin. No cookie is read there: the token endpoint trusts only the code,
 * its PKCE verifier or a refresh token.
 */
const OAUTH_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function isOAuthPublic(pathname: string): boolean {
  return pathname.startsWith('/.well-known/oauth-') || pathname === '/api/oauth/register' || pathname === '/api/oauth/token';
}

export async function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith('/api/v1/');
  const isOAuth = isOAuthPublic(request.nextUrl.pathname);
  const cors = isApi ? CORS_HEADERS : isOAuth ? OAUTH_CORS_HEADERS : null;

  // Handle CORS preflight for API routes
  if (cors && request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // A write with the session cookie from another site is refused here, for
  // every session route at once (lib/security/origin.ts).
  if (needsOriginCheck(request) && foreignOrigin(request)) {
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }

  // A page gets a fresh script nonce: in the request's own policy header,
  // where Next reads it and puts it on every script it renders, in
  // NONCE_HEADER for the root layout's inline theme script, and in the
  // answer's policy, which the browser enforces.
  const nonce = pagePolicyApplies(request.nextUrl.pathname) ? newScriptNonce() : null;
  const policy = nonce ? pageContentSecurityPolicy(request.nextUrl.pathname, nonce) : null;
  if (nonce && policy) {
    request.headers.set(NONCE_HEADER, nonce);
    request.headers.set('content-security-policy', policy);
  } else {
    // A nonce is only ever the proxy's own, never one a caller sent.
    request.headers.delete(NONCE_HEADER);
  }

  const response = await updateSession(request);
  if (policy) response.headers.set('Content-Security-Policy', policy);

  // Add CORS headers to API responses
  if (cors) {
    for (const [key, value] of Object.entries(cors)) {
      response.headers.set(key, value);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files (svg, png, jpg, etc.)
     *
     * Fonts and the pdf.js worker (mjs) are listed because the client
     * portal's invoice preview loads them signed out, and a font that
     * redirects to login stops the PDF from ever rendering.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ttf|woff2?|mjs|webmanifest)$).*)',
  ],
};
