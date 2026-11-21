import type { NextRequest } from 'next/server';
import { postDatabase } from '@/lib/updates/handlers';
import { updatesDeps } from '@/lib/updates/server';

/** Turns automatic database updates on or off ({ automatic: boolean }). Owner only. */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return postDatabase(request, updatesDeps());
}
