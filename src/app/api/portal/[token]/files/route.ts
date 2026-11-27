import { createClient } from '@supabase/supabase-js';
import { createPmClient } from '@/lib/supabase/pm-client';
import { NextRequest, NextResponse } from 'next/server';
import { checkPortalPin, pinFailureResponse } from '@/lib/portal-pin';
import { enabledModuleSet } from '@/lib/modules/server';
import { PM_DB } from '@/lib/supabase/schema';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';
import { signStoredFileUrl } from '@/lib/storage/sign-stored-file';
import { PORTAL_UPLOAD_MAX_BYTES, PORTAL_UPLOADS_PER_DAY, portalUploadProblem } from '@/lib/portal-uploads';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createPmClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createPmClient(url, key);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params;
  const token = rawToken.toLowerCase();
  const supabase = getServiceClient();

  // With the Client portal switched off every link answers like an unknown one.
  const modules = await enabledModuleSet(supabase);
  if (!modules.has('portal')) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  // Verify portal
  const { data: settings } = await supabase
    .from('portal_settings')
    .select('id, project_id, enabled, pin, show_files, project:projects!inner(id)')
    .eq('token', token)
    // A project in Trash has no portal; it comes back when the project is restored.
    .is('project.deleted_at', null)
    .maybeSingle();

  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (!settings.show_files) {
    return NextResponse.json({ error: 'File uploads are not enabled' }, { status: 403 });
  }

  // PIN travels in a header to avoid leaking into server logs
  const pinCheck = await checkPortalPin({ supabase, request, token, settings });
  if (!pinCheck.ok) return pinFailureResponse(pinCheck);

  // Too big to be a file the app keeps: refused before the body is read.
  if (Number(request.headers.get('content-length') || 0) > PORTAL_UPLOAD_MAX_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: `File exceeds the ${Math.round(PORTAL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit` }, { status: 413 });
  }

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Programs, web pages, SVG and scripts are refused, and the app's file limit applies (portal-uploads.ts).
  const problem = portalUploadProblem(file);
  if (problem) {
    return NextResponse.json({ error: problem }, { status: file.size > PORTAL_UPLOAD_MAX_BYTES ? 413 : 400 });
  }

  // A portal takes so many visitor files a day: the link alone lets someone in.
  const { count: today, error: countError } = await supabase
    .from('entity_files')
    .select('id', { count: 'exact', head: true })
    .eq('entity_type', 'project')
    .eq('entity_id', settings.project_id)
    .is('uploaded_by', null)
    .is('deleted_at', null)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  if (countError) {
    console.error('[portal-files] could not count today\'s uploads', countError);
    return NextResponse.json({ error: 'Upload failed. Try again.' }, { status: 500 });
  }
  if ((today ?? 0) >= PORTAL_UPLOADS_PER_DAY) {
    return NextResponse.json({ error: 'This portal has taken all the files it can today. Try again tomorrow.' }, { status: 429 });
  }

  // Sanitize filename for storage path to prevent traversal
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const storagePath = `project/${settings.project_id}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await pmStorage(supabase)
    .from(BUCKETS.entityFiles)
    .upload(storagePath, file, { contentType: file.type || 'application/octet-stream' });

  if (uploadError) {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  const { data: { publicUrl } } = pmStorage(supabase)
    .from(BUCKETS.entityFiles)
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

  // The bucket is private: the visitor's page gets a link that lasts an hour.
  const fileUrl = (await signStoredFileUrl(supabase, record.file_url, 3600)) ?? record.file_url;
  return NextResponse.json({ ...record, file_url: fileUrl }, { status: 201 });
}
