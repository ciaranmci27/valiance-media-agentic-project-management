import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { apiKeyEditOptions, editApiKey } from '@/lib/api/key-edit';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The key and the scopes a key for its member may carry, for the edit form.
 * Allowed for the key's member and holders of api_keys.manage_all.
 */
export async function GET(_request: Request, { params }: Params) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const { id } = await params;

  const result = await apiKeyEditOptions(service, { memberId, access }, id);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Renames a key and/or replaces its scopes (Settings > API Keys > Edit). The
 * secret stays the same and the change applies from the key's next request.
 * Scopes are checked against the key's member's api permissions; see
 * lib/api/key-edit.ts for every rule.
 */
export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const { id } = await params;

  const input = await request.json().catch(() => null);
  const result = await editApiKey(service, { memberId, access }, id, input);
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}
