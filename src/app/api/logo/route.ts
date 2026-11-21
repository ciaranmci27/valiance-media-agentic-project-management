import { NextResponse, type NextRequest } from 'next/server';
import { getBrand } from '@/lib/brand/server';

/**
 * A stable URL for the workspace's logo: emails and invoices sent before the
 * brand moved to Settings link to core's old /logos and /favicon files, and
 * next.config.ts sends those paths here. Redirects to the
 * uploaded file: `variant=dark` asks for the dark-background logo (the light
 * one when none is uploaded), `type=favicon` for the favicon (the generated
 * one when none is uploaded). 404 with no logo uploaded: callers show the name.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const brand = await getBrand();
  const target = searchParams.get('type') === 'favicon'
    ? (brand.logos.favicon ?? new URL('/api/brand/icon', request.url).toString())
    : searchParams.get('variant') === 'dark' ? brand.logos.dark : brand.logos.light;
  if (!target) return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // Never cached as permanent: the logo behind this URL changes when an Owner uploads a new one.
  return NextResponse.redirect(target, { status: 307, headers: { 'Cache-Control': 'public, max-age=60' } });
}
