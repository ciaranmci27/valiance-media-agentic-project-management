import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { getBrand } from '@/lib/brand/server';

/**
 * The favicon when none is uploaded: the name's first letter on the brand
 * color, so a new workspace has its own tab icon from the first visit.
 * `?size=` picks the square's edge (16 to 512, default 64).
 */
export async function GET(request: NextRequest) {
  const brand = await getBrand();
  const requested = Number(request.nextUrl.searchParams.get('size'));
  const size = Number.isFinite(requested) && requested >= 16 && requested <= 512 ? Math.round(requested) : 64;
  const letter = (brand.name.trim()[0] || 'W').toUpperCase();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: brand.colors.brand[600],
          borderRadius: size * 0.22,
          color: '#FFFFFF',
          fontSize: size * 0.62,
          fontWeight: 700,
        }}
      >
        {letter}
      </div>
    ),
    {
      width: size,
      height: size,
      // Short, so a brand change shows soon; the brand read itself is cached.
      headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' },
    },
  );
}
