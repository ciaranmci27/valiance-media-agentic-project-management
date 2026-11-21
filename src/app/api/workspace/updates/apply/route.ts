import type { NextRequest } from 'next/server';
import { postApply } from '@/lib/updates/handlers';
import { updatesDeps } from '@/lib/updates/server';

/** Apply: merges a ready update's pull request as a merge commit at its checked head ({ version }). Owner only. */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return postApply(request, await updatesDeps());
}
