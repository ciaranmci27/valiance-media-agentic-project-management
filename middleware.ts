import { updateSession } from '@/lib/supabase/middleware';
import { type NextRequest, NextResponse } from 'next/server';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  'Access-Control-Max-Age': '86400',
};

export async function middleware(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith('/api/v1/');

  // Handle CORS preflight for API routes
  if (isApi && request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  const response = await updateSession(request);

  // Add CORS headers to API responses
  if (isApi) {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
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
     * glb is in the list for the public /live simulation: the 3D scene's
     * props are public-folder models, and an anonymous visitor's fetch for
     * one would otherwise be redirected to the login page's HTML, which the
     * GLTF loader chokes on hard enough to take the whole scene down.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|glb)$).*)',
  ],
};
