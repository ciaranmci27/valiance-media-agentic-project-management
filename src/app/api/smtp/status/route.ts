import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { isSmtpEncryptionConfigured } from '@/lib/email/crypto';

export const dynamic = 'force-dynamic';

// Read-only booleans, intentionally NOT admin-gated: the settings page needs
// to know whether email can be sent so every member can manage their own
// notification preferences. No credentials or account details are exposed.
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Service client: smtp_accounts RLS is admin-only, but a row COUNT is safe
  const service = getServiceClient();
  const { count } = await service
    .from('smtp_accounts')
    .select('id', { count: 'exact', head: true });

  return NextResponse.json({
    configured: isSmtpEncryptionConfigured(),
    hasAccounts: (count ?? 0) > 0,
  });
}
