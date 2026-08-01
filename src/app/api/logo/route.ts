import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function findFile(baseName: string) {
  const dir = join(process.cwd(), 'public', 'logos');
  const extensions = ['.svg', '.png', '.webp', '.jpg', '.jpeg', '.ico'];
  for (const ext of extensions) {
    const filePath = join(dir, `${baseName}${ext}`);
    if (existsSync(filePath)) {
      return { filePath, ext };
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type') || 'logo';
  const baseName = type === 'favicon' ? 'favicon' : 'logo';

  // `variant=dark` asks for the lockup drawn for dark chrome (`logo-dark.*`).
  // It is optional: a brand that hasn't supplied one falls back to the
  // standard mark rather than 404ing.
  const wantsDark = searchParams.get('variant') === 'dark' && type !== 'favicon';
  const found = (wantsDark && findFile(`${baseName}-dark`)) || findFile(baseName);
  if (!found) {
    return new NextResponse(null, { status: 404 });
  }

  const buffer = readFileSync(found.filePath);

  // The asset behind this URL is swappable (that is the whole point of serving
  // it from a route), so it must never be cached as immutable: replacing the
  // file would leave every browser showing the old mark until the entry aged
  // out. `no-cache` still caches; it just forces a revalidation, and the ETag
  // turns that into an empty 304 whenever the bytes haven't changed.
  const etag = `"${createHash('sha1').update(buffer).digest('base64url')}"`;
  const headers = {
    'Content-Type': MIME[found.ext] || 'application/octet-stream',
    'Cache-Control': 'public, no-cache',
    ETag: etag,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(buffer, { headers });
}
