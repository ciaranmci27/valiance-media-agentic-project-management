import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isEncryptionConfigured } from '@/lib/api/encryption';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({ configured: isEncryptionConfigured() });
}
