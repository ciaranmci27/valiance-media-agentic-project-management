import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { memberIdentities, providerFilter } from '@/lib/api/identities';

/**
 * How to reach a member: their verified accounts (provider to narrow, such
 * as slack). Answers { member, identities }.
 *
 * Permission: identities.read.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams }) =>
  success(await memberIdentities(supabase, params.id, providerFilter(searchParams))), { permission: 'identities.read' });
