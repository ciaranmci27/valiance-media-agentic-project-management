import { insertAuditRows } from '@/lib/api/audit';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, isSchemaMissing, migrationMissing, requireOwner } from '@/lib/api/owner-route';
import { BRAND_BUCKET, DEFAULT_BRAND, LOGO_KINDS, resolveBrand, type LogoKind } from '@/lib/brand';
import { expireBrand, readStoredBrand } from '@/lib/brand/server';
import { LOGO_MAX_BYTES, sniffImage } from '@/lib/brand/validate';
import { pmStorage } from '@/lib/supabase/storage';
import { plainDbError } from '@/lib/api/plain-error';

/**
 * Settings > Workspace > Brand: upload (POST, multipart `file`) or remove
 * (DELETE) one of the brand's files, `?kind=light|dark|favicon`. Owner only.
 * Each upload gets a new object name, so browsers and email clients never
 * show a stale cached logo; the replaced file is removed after the row
 * points at the new one.
 */

const COLUMN: Record<LogoKind, 'logo_light_path' | 'logo_dark_path' | 'favicon_path'> = {
  light: 'logo_light_path',
  dark: 'logo_dark_path',
  favicon: 'favicon_path',
};

const LABEL: Record<LogoKind, string> = { light: 'Logo', dark: 'Dark logo', favicon: 'Favicon' };

function parseKind(request: NextRequest): LogoKind | null {
  const kind = request.nextUrl.searchParams.get('kind');
  return (LOGO_KINDS as readonly string[]).includes(kind ?? '') ? (kind as LogoKind) : null;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

async function currentPath(service: SupabaseClient, kind: LogoKind): Promise<{ path: string | null; error: NextResponse | null }> {
  const { data, error } = await service.from('workspace_brand').select(COLUMN[kind]).eq('id', true).maybeSingle();
  if (error) return { path: null, error: isSchemaMissing(error) ? migrationMissing() : plainDbError(error) };
  return { path: ((data as Record<string, string | null> | null)?.[COLUMN[kind]]) ?? null, error: null };
}

async function respond(service: SupabaseClient) {
  const stored = await readStoredBrand(service);
  return NextResponse.json({ data: { settings: stored.settings, brand: resolveBrand(stored.settings), defaults: DEFAULT_BRAND } });
}

function audit(service: SupabaseClient, memberId: string, method: 'POST' | 'DELETE', kind: LogoKind, before: string | null, after: string | null) {
  afterResponse('workspace brand logo audit', async () => {
    const { error } = await insertAuditRows(service, {
      method,
      endpoint: `/api/workspace/brand/logo?kind=${kind}`,
      entity_type: 'workspace_brand',
      team_member_id: memberId,
      request_body: { kind },
      before_snapshot: { [COLUMN[kind]]: before },
      after_snapshot: { [COLUMN[kind]]: after },
      status_code: 200,
      via: 'app',
    });
    if (error) throw error;
  });
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
  if (file.size > LOGO_MAX_BYTES[kind]) {
    return NextResponse.json({ error: `${LABEL[kind]} can be at most ${megabytes(LOGO_MAX_BYTES[kind])}` }, { status: 413 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniffImage(bytes, kind);
  if (!image) {
    return NextResponse.json({ error: kind === 'favicon' ? 'Use a PNG, JPG or ICO file' : 'Use a PNG or JPG file' }, { status: 415 });
  }

  const before = await currentPath(service, kind);
  if (before.error) return before.error;

  const path = `${kind}-${Date.now()}.${image.ext}`;
  const upload = await pmStorage(service).from(BRAND_BUCKET).upload(path, bytes, {
    contentType: image.contentType,
    // The name is unique per upload, so the file itself never changes.
    cacheControl: '31536000',
    upsert: false,
  });
  if (upload.error) return NextResponse.json({ error: `Upload failed: ${upload.error.message}` }, { status: 500 });

  const { error } = await service.from('workspace_brand')
    .upsert({ id: true, [COLUMN[kind]]: path, updated_by: memberId }, { onConflict: 'id' });
  if (error) {
    await pmStorage(service).from(BRAND_BUCKET).remove([path]);
    return isSchemaMissing(error) ? migrationMissing() : plainDbError(error);
  }
  if (before.path && before.path !== path) await pmStorage(service).from(BRAND_BUCKET).remove([before.path]);

  expireBrand();
  audit(service, memberId, 'POST', kind, before.path, path);
  return respond(service);
}

export async function DELETE(request: NextRequest) {
  const g = await guard(request);
  if (g.error) return g.error;
  const { kind, memberId, service } = g;

  const before = await currentPath(service, kind);
  if (before.error) return before.error;
  if (before.path) {
    const { error } = await service.from('workspace_brand').update({ [COLUMN[kind]]: null, updated_by: memberId }).eq('id', true);
    if (error) return plainDbError(error);
    await pmStorage(service).from(BRAND_BUCKET).remove([before.path]);
    expireBrand();
    audit(service, memberId, 'DELETE', kind, before.path, null);
  }
  return respond(service);
}
