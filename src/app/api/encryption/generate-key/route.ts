import { NextResponse } from 'next/server';
import { generateAppKey } from '@/lib/crypto/app-key';
import { requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

/** A new APP_ENCRYPTION_KEY (64 hex characters) to add in the host. Never stored. */
export async function POST() {
  const auth = await requireSessionAccess({ permission: 'settings.manage' });
  if (auth.error) return auth.error;

  return NextResponse.json({ key: generateAppKey() });
}
