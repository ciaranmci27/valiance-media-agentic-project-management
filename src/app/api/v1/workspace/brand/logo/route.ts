import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, badRequest } from '@/lib/api/errors';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { currentApiVia } from '@/lib/api/request-context';
import { readWorkspaceBrand } from '@/lib/api/workspace-settings';
import { LOGO_KINDS, type LogoKind } from '@/lib/brand';
import { LOGO_MAX_BYTES } from '@/lib/brand/validate';
import { removeBrandLogo, uploadBrandLogo, type LogoRefusal } from '@/lib/brand/logo-write';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<Record<string, string>> };

function kindOf(searchParams: URLSearchParams): LogoKind {
  const kind = searchParams.get('kind');
  if (!(LOGO_KINDS as readonly string[]).includes(kind ?? '')) throw badRequest(`kind must be one of: ${LOGO_KINDS.join(', ')}`, { reason: 'invalid_kind' });
  return kind as LogoKind;
}

const CODES: Record<number, string> = { 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 500: 'INTERNAL_ERROR' };
function refused(refusal: LogoRefusal): ApiError {
  return new ApiError(refusal.status, refusal.code === 'MIGRATION_REQUIRED' ? 'MIGRATION_REQUIRED' : CODES[refusal.status] ?? 'INTERNAL_ERROR', refusal.message, { reason: refusal.code ?? 'logo_failed' });
}

/**
 * The brand's files over the API (Settings > Workspace > Brand), by the same
 * writer as Settings: ?kind=light|dark|favicon|square_dark. POST uploads one (multipart,
 * one field named file: PNG or JPG up to 2 MB, a favicon PNG, JPG or ICO up
 * to 512 KB; REST only, a file upload), DELETE removes it and the default
 * shows again. Owner only, on a key that carries settings.manage. Answers
 * the brand as GET /api/v1/workspace/brand does.
 */
export const POST = (request: NextRequest, context: Context) => withApi(async ({ supabase, access, searchParams, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes the brand');
  const kind = kindOf(searchParams);
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    throw badRequest('Send the image as multipart form data in a field named file', { reason: 'not_multipart' });
  }
  if (!file || typeof file === 'string') throw badRequest('Send the image in a field named file', { reason: 'no_file' });
  const refusal = await uploadBrandLogo(supabase, { memberId: teamMemberId, apiKeyId, endpoint: '/api/v1/workspace/brand/logo', via: currentApiVia() }, kind, file);
  if (refusal) throw refused(refusal);
  return success(await readWorkspaceBrand(supabase));
}, { permission: 'settings.manage', maxBodyBytes: LOGO_MAX_BYTES.light + 64 * 1024 })(request, context);

export const DELETE = withApi(async ({ supabase, access, searchParams, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes the brand');
  const refusal = await removeBrandLogo(supabase, { memberId: teamMemberId, apiKeyId, endpoint: '/api/v1/workspace/brand/logo', via: currentApiVia() }, kindOf(searchParams));
  if (refusal) throw refused(refusal);
  return success(await readWorkspaceBrand(supabase));
}, { permission: 'settings.manage' });
