import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.msi', '.dll', '.scr',
  '.com', '.vbs', '.js', '.ps1', '.wsf',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

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
  const supabase = getServiceClient();

  // Verify portal
  const { data: settings } = await supabase
    .from('portal_settings')
    .select('project_id, enabled, pin, show_files')
    .eq('token', token)
    .maybeSingle();

  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (!settings.show_files) {
    return NextResponse.json({ error: 'File uploads are not enabled' }, { status: 403 });
  }

  // Check PIN (accept via header to avoid leaking in server logs)
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({ error: 'Invalid PIN' }, { status: 401 });
    }
  }

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  if (!file || file.size === 0) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File exceeds 50 MB limit' }, { status: 400 });
  }

  // Block dangerous extensions (check all segments, not just last)
  const nameParts = file.name.toLowerCase().split('.');
  const allExtensions = nameParts.slice(1).map(p => '.' + p);
  if (allExtensions.some(ext => DANGEROUS_EXTENSIONS.has(ext))) {
    return NextResponse.json({ error: 'This file type is not allowed' }, { status: 400 });
  }

  // Sanitize filename for storage path to prevent traversal
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const storagePath = `project/${settings.project_id}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from('entity-files')
    .upload(storagePath, file, { contentType: file.type || 'application/octet-stream' });

  if (uploadError) {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  const { data: { publicUrl } } = supabase.storage
    .from('entity-files')
    .getPublicUrl(storagePath);

  // Insert entity_files row
  const { data: record, error: insertError } = await supabase
    .from('entity_files')
    .insert({
      entity_type: 'project',
      entity_id: settings.project_id,
      name: file.name,
      file_url: publicUrl,
      file_size: file.size,
      mime_type: file.type || 'application/octet-stream',
      visibility: 'external',
      uploaded_by: null,
    })
    .select('id, name, file_url, file_size, mime_type')
    .single();

  if (insertError || !record) {
    return NextResponse.json({ error: 'Failed to save file record' }, { status: 500 });
  }

  return NextResponse.json(record, { status: 201 });
}
