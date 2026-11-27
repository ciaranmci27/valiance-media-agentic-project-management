import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { DEFAULT_BRAND, LOGO_KINDS, resolveBrand, type LogoKind } from '@/lib/brand';
import { readStoredBrand } from '@/lib/brand/server';
import { removeBrandLogo, uploadBrandLogo, type LogoRefusal } from '@/lib/brand/logo-write';

/**
 * Settings > Workspace > Brand: upload (POST, multipart `file`) or remove
 * (DELETE) one of the brand's files, `?kind=light|dark|favicon`. Owner only.
 * The writer is lib/brand/logo-write.ts, shared with
 * /api/v1/workspace/brand/logo.
 */

function parseKind(request: NextRequest): LogoKind | null {
  const kind = request.nextUrl.searchParams.get('kind');
  return (LOGO_KINDS as readonly string[]).includes(kind ?? '') ? (kind as LogoKind) : null;
}

function refused(refusal: LogoRefusal) {
  return NextResponse.json({ error: refusal.message, ...(refusal.code === 'MIGRATION_REQUIRED' ? { code: refusal.code } : {}) }, { status: refusal.status });
}

async function respond(service: SupabaseClient) {
  const stored = await readStoredBrand(service);
  return NextResponse.json({ data: { settings: stored.settings, brand: resolveBrand(stored.settings), defaults: DEFAULT_BRAND } });
}

async function guard(request: NextRequest) {
  if (isDemoWorkspace()) return { error: NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 }) } as const;
  if (foreignOrigin(request)) return { error: NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 }) } as const;
  const kind = parseKind(request);
  if (!kind) return { error: NextResponse.json({ error: `kind must be one of: ${LOGO_KINDS.join(', ')}` }, { status: 400 }) } as const;
  const auth = await requireOwner();
  if (auth.error) return { error: auth.error } as const;
  return { kind, memberId: auth.data.memberId, service: auth.data.service, error: null } as const;
}

export async function POST(request: NextRequest) {
  const g = await guard(request);
  if (g.error) return g.error;
  const { kind, memberId, service } = g;

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return NextResponse.json({ error: 'Send the image as multipart form data in a field named file' }, { status: 400 });
  }
  if (!file || typeof file === 'string') return NextResponse.json({ error: 'Choose an image to upload' }, { status: 400 });
  const refusal = await uploadBrandLogo(service, { memberId, endpoint: '/api/workspace/brand/logo', via: 'app' }, kind, file);
  if (refusal) return refused(refusal);
  return respond(service);
}

export async function DELETE(request: NextRequest) {
  const g = await guard(request);
  if (g.error) return g.error;
  const { kind, memberId, service } = g;
  const refusal = await removeBrandLogo(service, { memberId, endpoint: '/api/workspace/brand/logo', via: 'app' }, kind);
  if (refusal) return refused(refusal);
  return respond(service);
}
