import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertAuditRows } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { isSchemaMissing } from '@/lib/api/owner-route';
import { plainDbMessage } from '@/lib/api/plain-error';
import { BRAND_BUCKET, type LogoKind } from '@/lib/brand';
import { expireBrand } from '@/lib/brand/server';
import { LOGO_MAX_BYTES, sniffImage } from '@/lib/brand/validate';
import { pmStorage } from '@/lib/supabase/storage';
import { expireCache } from '@/lib/api/workspace-settings';

/**
 * Uploading and removing one of the brand's files (light logo, dark logo,
 * favicon): the one writer behind Settings > Workspace > Brand and
 * /api/v1/workspace/brand/logo. Owner only: each caller checks that first.
 * Each upload gets a new object name, so browsers and email clients never
 * show a stale cached logo; the replaced file is removed after the row
 * points at the new one. Every change leaves an audit row.
 */

export const LOGO_COLUMN: Record<LogoKind, 'logo_light_path' | 'logo_dark_path' | 'favicon_path'> = {
  light: 'logo_light_path',
  dark: 'logo_dark_path',
  favicon: 'favicon_path',
};

const LABEL: Record<LogoKind, string> = { light: 'Logo', dark: 'Dark logo', favicon: 'Favicon' };

/** A refusal in plain words, with the status the caller answers and, for a missing migration, a code. */
export interface LogoRefusal { status: number; message: string; code?: 'MIGRATION_REQUIRED' | 'too_large' | 'not_an_image' | 'upload_failed' }

export interface LogoWriter {
  memberId: string;
  endpoint: string;
  via: 'app' | 'rest' | 'mcp';
  apiKeyId?: string | null;
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

function dbRefusal(error: { code?: string | null; message?: string | null }): LogoRefusal {
  if (isSchemaMissing(error)) return { status: 409, message: 'Run the latest database migration first.', code: 'MIGRATION_REQUIRED' };
  console.error('[api] database error:', error);
  return { status: 500, message: plainDbMessage(error) };
}

async function currentPath(service: SupabaseClient, kind: LogoKind): Promise<{ path: string | null; refusal: LogoRefusal | null }> {
  const { data, error } = await service.from('workspace_brand').select(LOGO_COLUMN[kind]).eq('id', true).maybeSingle();
  if (error) return { path: null, refusal: dbRefusal(error) };
  return { path: ((data as Record<string, string | null> | null)?.[LOGO_COLUMN[kind]]) ?? null, refusal: null };
}

function audit(service: SupabaseClient, writer: LogoWriter, method: 'POST' | 'DELETE', kind: LogoKind, before: string | null, after: string | null) {
  afterResponse('workspace brand logo audit', async () => {
    const { error } = await insertAuditRows(service, {
      method,
      endpoint: `${writer.endpoint}?kind=${kind}`,
      entity_type: 'workspace_brand',
      team_member_id: writer.memberId,
      ...(writer.apiKeyId ? { api_key_id: writer.apiKeyId } : {}),
      request_body: { kind },
      before_snapshot: { [LOGO_COLUMN[kind]]: before },
      after_snapshot: { [LOGO_COLUMN[kind]]: after },
      status_code: 200,
      ...(writer.via !== 'rest' ? { via: writer.via } : {}),
    });
    if (error) throw error;
  });
}

/** The size, type and content checks, before anything is stored. */
export async function readLogoFile(kind: LogoKind, file: Blob): Promise<{ bytes: Uint8Array; ext: string; contentType: string } | LogoRefusal> {
  if (file.size > LOGO_MAX_BYTES[kind]) return { status: 413, message: `${LABEL[kind]} can be at most ${megabytes(LOGO_MAX_BYTES[kind])}`, code: 'too_large' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniffImage(bytes, kind);
  if (!image) return { status: 415, message: kind === 'favicon' ? 'Use a PNG, JPG or ICO file' : 'Use a PNG or JPG file', code: 'not_an_image' };
  return { bytes, ext: image.ext, contentType: image.contentType };
}

/** Stores the file and points the brand at it. Answers null when done, or the refusal. */
export async function uploadBrandLogo(service: SupabaseClient, writer: LogoWriter, kind: LogoKind, file: Blob): Promise<LogoRefusal | null> {
  const image = await readLogoFile(kind, file);
  if ('status' in image) return image;
  const before = await currentPath(service, kind);
  if (before.refusal) return before.refusal;

  const path = `${kind}-${Date.now()}.${image.ext}`;
  const upload = await pmStorage(service).from(BRAND_BUCKET).upload(path, image.bytes, {
    contentType: image.contentType,
    // The name is unique per upload, so the file itself never changes.
    cacheControl: '31536000',
    upsert: false,
  });
  if (upload.error) return { status: 500, message: `Upload failed: ${upload.error.message}`, code: 'upload_failed' };

  const { error } = await service.from('workspace_brand')
    .upsert({ id: true, [LOGO_COLUMN[kind]]: path, updated_by: writer.memberId }, { onConflict: 'id' });
  if (error) {
    await pmStorage(service).from(BRAND_BUCKET).remove([path]);
    return dbRefusal(error);
  }
  if (before.path && before.path !== path) await pmStorage(service).from(BRAND_BUCKET).remove([before.path]);

  expireCache(expireBrand);
  audit(service, writer, 'POST', kind, before.path, path);
  return null;
}

/** Removes the file, if there is one, and the brand goes back to the default. */
export async function removeBrandLogo(service: SupabaseClient, writer: LogoWriter, kind: LogoKind): Promise<LogoRefusal | null> {
  const before = await currentPath(service, kind);
  if (before.refusal) return before.refusal;
  if (!before.path) return null;
  const { error } = await service.from('workspace_brand').update({ [LOGO_COLUMN[kind]]: null, updated_by: writer.memberId }).eq('id', true);
  if (error) return dbRefusal(error);
  await pmStorage(service).from(BRAND_BUCKET).remove([before.path]);
  expireCache(expireBrand);
  audit(service, writer, 'DELETE', kind, before.path, null);
  return null;
}
