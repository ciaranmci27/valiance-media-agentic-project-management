import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { listTrashForApi, TRASH_PERMISSIONS, TRASH_TYPES } from '@/lib/api/trash-api';
import type { TrashTable } from '@/lib/supabase/trash';

export const dynamic = 'force-dynamic';

const typesSchema = z.array(z.enum(TRASH_TYPES)).max(TRASH_TYPES.length);

/**
 * What is in Trash that this key could restore (Settings > Trash, for the
 * key's member on the api channel), newest first: record_type, id, label,
 * context (its project, task or lead), project_id, when and by whom it was
 * deleted, and blocker (what must come back first, or null). types: a comma
 * list of record types; limit 1-500, default 100.
 */
export const GET = withApi(async ({ supabase, searchParams, access, scopes, teamMemberId }) => {
  const rawTypes = searchParams.get('types');
  const parsed = typesSchema.safeParse(rawTypes ? rawTypes.split(',').map((t) => t.trim()).filter(Boolean) : []);
  if (!parsed.success) throw badRequest(`types must be record types from: ${TRASH_TYPES.join(', ')}`, { reason: 'invalid_types' });
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100', 10) || 100));
  const types = parsed.data.length ? (parsed.data as TrashTable[]) : null;
  const items = await listTrashForApi({ service: supabase, access, scopes, memberId: teamMemberId }, types, limit);
  return success(items);
}, { permission: TRASH_PERMISSIONS });
