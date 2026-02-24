import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { updateCredentialSchema } from '@/lib/schemas/credentials';
import { fetchCredentialWithEncryptedData, patchProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = updateCredentialSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { label, category, username, password, url, notes } = parsed.data;
  const hasSecretFields = username !== undefined || password !== undefined || url !== undefined || notes !== undefined;

  try {
    const updates: Record<string, any> = {};
    if (label !== undefined) updates.label = label;
    if (category !== undefined) updates.category = category;

    if (hasSecretFields) {
      // Decrypt current values, merge with updates, re-encrypt
      const existing = await fetchCredentialWithEncryptedData(supabase, id);
      const current = await decrypt<CredentialPayload>(existing.encrypted_data, existing.iv);

      const merged: CredentialPayload = {
        username: username ?? current.username,
        password: password ?? current.password,
        url: url ?? current.url,
        notes: notes ?? current.notes,
      };

      const { encrypted_data, iv } = await encrypt(merged);
      updates.encrypted_data = encrypted_data;
      updates.iv = iv;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updated = await patchProjectCredential(supabase, id, updates);
    return NextResponse.json({ success: true, data: updated });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
