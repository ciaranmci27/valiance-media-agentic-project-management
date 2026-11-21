import type { NextRequest } from 'next/server';
import { getUpdates } from '@/lib/updates/handlers';
import { updatesDeps } from '@/lib/updates/server';

/**
 * Settings > Updates: the running version, newer releases, the GitHub
 * connection and the update in progress, all read from GitHub. Owner only.
 * ?refresh=1 reads the release list again instead of the six-hour cache.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return getUpdates(request, updatesDeps());
}
