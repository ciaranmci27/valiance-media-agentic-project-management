import { updateSession } from '@/lib/supabase/middleware';
import { type NextRequest, NextResponse } from 'next/server';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
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

export async function middleware(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith('/api/v1/');
  const isOAuth = isOAuthPublic(request.nextUrl.pathname);
  const cors = isApi ? CORS_HEADERS : isOAuth ? OAUTH_CORS_HEADERS : null;

  // Handle CORS preflight for API routes
  if (cors && request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  const response = await updateSession(request);

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
