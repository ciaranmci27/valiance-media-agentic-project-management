import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
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

  const found = findFile(baseName);
  if (!found) {
    return new NextResponse(null, { status: 404 });
  }

  const buffer = readFileSync(found.filePath);
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': MIME[found.ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}
