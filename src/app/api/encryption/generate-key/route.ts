import { NextResponse } from 'next/server';
import { generateEncryptionKey } from '@/lib/api/encryption';
import { requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function POST() {
  const auth = await requireSessionAccess({ permission: 'settings.manage' });
  if (auth.error) return auth.error;

  return NextResponse.json({ key: generateEncryptionKey() });
}
