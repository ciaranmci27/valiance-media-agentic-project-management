import { NextRequest, NextResponse } from 'next/server';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { updateCredentialSchema, payloadFromBody } from '@/lib/schemas/credentials';
import { fetchCredentialWithEncryptedData, patchProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireSessionAccess({ permission: 'credentials.manage' });
  if (auth.error) return auth.error;
  const { service } = auth.data;

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

  const { label, category } = parsed.data;
  const providedFields = payloadFromBody(parsed.data);
  const hasSecretFields = Object.keys(providedFields).length > 0;

  try {
    const updates: Record<string, any> = {};
    if (label !== undefined) updates.label = label;
    if (category !== undefined) updates.category = category;

    if (hasSecretFields) {
      // Decrypt current values, merge with updates, re-encrypt.
      // Keys not present in the request are preserved.
      const existing = await fetchCredentialWithEncryptedData(service, id);
      const current = await decrypt<CredentialPayload>(existing.encrypted_data, existing.iv);

      const merged: CredentialPayload = { ...current, ...providedFields };

      const { encrypted_data, iv } = await encrypt(merged);
      updates.encrypted_data = encrypted_data;
      updates.iv = iv;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updated = await patchProjectCredential(service, id, updates);
    return NextResponse.json({ success: true, data: updated });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
