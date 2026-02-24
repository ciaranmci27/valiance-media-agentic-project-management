import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { createCredentialSchema } from '@/lib/schemas/credentials';
import { insertProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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

  const { project_id, created_by, ...rest } = body;
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }

  const parsed = createCredentialSchema.safeParse(rest);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { label, category, username, password, url, notes } = parsed.data;

  const payload: CredentialPayload = { username, password, url, notes };
  const { encrypted_data, iv } = await encrypt(payload);

  const credential = await insertProjectCredential(supabase, {
    project_id,
    label,
    category,
    encrypted_data,
    iv,
    created_by: created_by || null,
  });

  return NextResponse.json({ success: true, data: credential }, { status: 201 });
}
