import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { portalSubmitCredentialSchema } from '@/lib/schemas/credentials';
import { encrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import type { CredentialPayload } from '@/lib/types';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createClient(url, key);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params;
  const token = rawToken.toLowerCase();

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  const supabase = getServiceClient();

  // Verify portal
  const { data: settings } = await supabase
    .from('portal_settings')
    .select('project_id, enabled, pin, show_credentials')
    .eq('token', token)
    .maybeSingle();

  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (!settings.show_credentials) {
    return NextResponse.json({ error: 'Credential submission is not enabled' }, { status: 403 });
  }

  // Check PIN (prefer header, fall back to query param)
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
    }
  }

  // Parse body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = portalSubmitCredentialSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { label, category, username, password, url, notes, submitted_by_name } = parsed.data;

  const payload: CredentialPayload = { username, password, url, notes };
  const { encrypted_data, iv } = await encrypt(payload);

  const { error: insertError } = await supabase
    .from('project_credentials')
    .insert({
      project_id: settings.project_id,
      label,
      category,
      encrypted_data,
      iv,
      submitted_by_client: true,
      submitted_by_name,
    });

  if (insertError) {
    return NextResponse.json({ error: 'Failed to save credential' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
