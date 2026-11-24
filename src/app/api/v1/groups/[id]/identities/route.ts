import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { parsePagination } from '@/lib/api/pagination';
import { groupIdentities, providerFilter } from '@/lib/api/identities';

/**
 * How to reach a group: { group, members }, its members (leads first) paged,
 * each with active and their verified accounts (provider to narrow, such as
 * slack). A suspended member is listed with active false and no accounts.
 *
 * Permission: identities.read.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const { group, rows, total } = await groupIdentities(supabase, params.id, providerFilter(searchParams), { offset, limit });
  return NextResponse.json({
    success: true,
    data: { group, members: rows },
    meta: { page, limit, total, total_pages: limit > 0 ? Math.ceil(total / limit) : 0 },
  });
}, { permission: 'identities.read' });
