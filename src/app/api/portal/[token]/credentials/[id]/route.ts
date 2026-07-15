import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { updateCredentialSchema, payloadFromBody } from '@/lib/schemas/credentials';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { isSensitiveKey } from '@/lib/credential-fields';
import type { CredentialPayload } from '@/lib/types';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createClient(url, key);
}

/** Return decrypted fields (minus password) so the client can pre-fill the edit form. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> },
) {
  const { token: rawToken, id } = await params;
  const token = rawToken.toLowerCase();

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  const supabase = getServiceClient();

  const { data: settings } = await supabase
    .from('portal_settings')
    .select('project_id, enabled, pin, show_credentials')
    .eq('token', token)
    .maybeSingle();

  if (!settings || !settings.enabled || !settings.show_credentials) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
    }
  }

  const { data: credential, error: credError } = await supabase
    .from('project_credentials')
    .select('id, project_id, submitted_by_client, encrypted_data, iv')
    .eq('id', id)
    .single();

  if (credError || !credential || credential.project_id !== settings.project_id || !credential.submitted_by_client) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }

  const decrypted = await decrypt<CredentialPayload>(credential.encrypted_data, credential.iv);

  // Return everything EXCEPT sensitive fields (passwords, keys, card/account
  // numbers). Clients re-enter those if they want to change them.
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) {
    if (!isSensitiveKey(key)) fields[key] = value;
  }
  return NextResponse.json({
    fields,
    // Transitional: portal bundles loaded before this deploy read these flat
    // keys; without them a stale tab would prefill blanks and save them back
    username: fields.username ?? '',
    url: fields.url ?? '',
    notes: fields.notes ?? '',
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> },
) {
  const { token: rawToken, id } = await params;
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

  // Verify credential exists, belongs to project, and was submitted by client
  const { data: credential, error: credError } = await supabase
    .from('project_credentials')
    .select('id, project_id, submitted_by_client, encrypted_data, iv')
    .eq('id', id)
    .single();

  if (credError || !credential) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }

  if (credential.project_id !== settings.project_id) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }

  if (!credential.submitted_by_client) {
    return NextResponse.json({ error: 'Cannot edit admin-created credentials' }, { status: 403 });
  }

  // Parse body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = updateCredentialSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { label, category } = parsed.data;
  const providedFields = payloadFromBody(parsed.data);
  const hasSecretFields = Object.keys(providedFields).length > 0;

  const updates: Record<string, any> = {};
  if (label !== undefined) updates.label = label;
  if (category !== undefined) updates.category = category;

  if (hasSecretFields) {
    // Decrypt current, merge, re-encrypt. Sensitive keys the client left
    // blank are omitted from the request and therefore preserved.
    const current = await decrypt<CredentialPayload>(credential.encrypted_data, credential.iv);
    const merged: CredentialPayload = { ...current, ...providedFields };

    const { encrypted_data, iv } = await encrypt(merged);
    updates.encrypted_data = encrypted_data;
    updates.iv = iv;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const { data: updated, error: updateError } = await supabase
    .from('project_credentials')
    .update(updates)
    .eq('id', id)
    .select('id, label, category, created_at, updated_at')
    .single();

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update credential' }, { status: 500 });
  }

  return NextResponse.json({ success: true, data: updated });
}
