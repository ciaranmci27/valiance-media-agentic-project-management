import type { NextRequest } from 'next/server';
import { postPrepare } from '@/lib/updates/handlers';
import { updatesDeps } from '@/lib/updates/server';

/** Prepare: starts core-update.yml for a pending release ({ version }). Owner only. */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return postPrepare(request, await updatesDeps());
}
