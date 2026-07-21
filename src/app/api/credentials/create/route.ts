import { NextRequest, NextResponse } from 'next/server';
import { encrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { createCredentialSchema, payloadFromBody } from '@/lib/schemas/credentials';
import { insertProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { accessAllowsProject, requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await requireSessionAccess({ permission: 'credentials.manage' });
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { project_id, ...rest } = body;
  if (!project_id) {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  }
  if (!accessAllowsProject(access, project_id)) {
    return NextResponse.json({ error: 'Project access denied' }, { status: 403 });
  }

  const parsed = createCredentialSchema.safeParse(rest);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 422 });
  }

  const { label, category } = parsed.data;

  const payload: CredentialPayload = payloadFromBody(parsed.data);
  const { encrypted_data, iv } = await encrypt(payload);

  const credential = await insertProjectCredential(service, {
    project_id,
    label,
    category,
    encrypted_data,
    iv,
    created_by: memberId,
  });

  return NextResponse.json({ success: true, data: credential }, { status: 201 });
}
