import type { NextRequest } from 'next/server';
import { postSetup } from '@/lib/updates/handlers';
import { updatesDeps } from '@/lib/updates/server';

/** Finish setup: stores PM_GITHUB_TOKEN as the PM_UPDATE_TOKEN Actions secret, sealed. Owner only. */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return postSetup(request, updatesDeps());
}
