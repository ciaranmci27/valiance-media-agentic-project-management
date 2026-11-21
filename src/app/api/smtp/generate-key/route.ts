import { NextResponse } from 'next/server';
import { generateAppKey } from '@/lib/crypto/app-key';
import { requireAdmin } from '@/lib/api/require-admin';

export const dynamic = 'force-dynamic';

/** A new APP_ENCRYPTION_KEY (64 hex characters) to add in the host. Never stored. */
export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  return NextResponse.json({ key: generateAppKey() });
}
