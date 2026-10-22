import type { SupabaseClient } from '@supabase/supabase-js';
import { moveToTrash, TrashError, type TrashTable } from '@/lib/supabase/trash';
import { ApiError, conflict, forbidden, notFound } from './errors';

/** A refused move to Trash as the API reports it: 404, 403, or 409 with the reason. */
export function trashApiError(error: unknown, resource: string): unknown {
  if (error instanceof ApiError || !(error instanceof TrashError)) return error;
  switch (error.reason) {
    case 'not_found': return notFound(resource);
    case 'forbidden': return forbidden(error.message);
    case 'blocked': return conflict(error.message);
    default: return error;
  }
}

/**
 * DELETE in the API: moves the record to Trash for the key's member. The route
 * has already checked the key may delete it (the service role trusts it).
 */
export async function trashForApi(
  supabase: SupabaseClient,
  table: TrashTable,
  id: string,
  teamMemberId: string | null,
  resource: string,
): Promise<void> {
  let moved: boolean;
  try {
    moved = await moveToTrash(supabase, table, id, teamMemberId);
  } catch (error) {
    throw trashApiError(error, resource);
  }
  if (!moved) throw notFound(resource);
}
