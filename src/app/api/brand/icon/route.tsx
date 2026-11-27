import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';
import { getBrand } from '@/lib/brand/server';
import { imageSize, squareCrop } from '@/lib/brand/validate';

/** How long the horizontal logo may take to fetch before the letter stands in. */
const LOGO_FETCH_MS = 2500;

/** The horizontal logo as a data URL with its size, or null when it is missing, slow or not a PNG or JPEG. */
async function horizontalLogo(url: string | null): Promise<{ src: string; width: number; height: number } | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LOGO_FETCH_MS) });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const size = imageSize(bytes);
    if (!size) return null;
    const type = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
    return { src: `data:${type};base64,${Buffer.from(bytes).toString('base64')}`, ...size };
  } catch {
    return null;
  }
}

/**
 * The tab icon when no square logo is uploaded: a square crop of the
 * horizontal logo (its left part, where a lockup's mark usually sits), or,
 * with no horizontal logo either, the name's first letter on the brand
 * color, so a new workspace has its own tab icon from the first visit.
 * `?size=` picks the square's edge (16 to 512, default 64).
 */
export async function GET(request: NextRequest) {
  const brand = await getBrand();
  const requested = Number(request.nextUrl.searchParams.get('size'));
  const size = Number.isFinite(requested) && requested >= 16 && requested <= 512 ? Math.round(requested) : 64;
  const letter = (brand.name.trim()[0] || 'W').toUpperCase();
  const logo = await horizontalLogo(brand.logos.light);
  const crop = logo ? squareCrop(logo, size) : null;

  return new ImageResponse(
    logo && crop ? (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- drawn into the icon image, not a page */}
        <img
          src={logo.src}
          width={crop.width}
          height={crop.height}
          alt=""
          style={{ position: 'absolute', left: crop.left, top: Math.round((size - crop.height) / 2) }}
        />
      </div>
    ) : (
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
