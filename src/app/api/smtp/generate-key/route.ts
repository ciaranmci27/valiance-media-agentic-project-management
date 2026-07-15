import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireAdmin } from '@/lib/api/require-admin';

export const dynamic = 'force-dynamic';

export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const key = crypto.randomBytes(32).toString('hex');
  return NextResponse.json({ key });
}
