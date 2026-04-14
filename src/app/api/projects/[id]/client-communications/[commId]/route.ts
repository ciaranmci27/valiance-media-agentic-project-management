import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { approveCommunication, dismissCommunication } from '@/lib/email/client-notifications';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  action: z.enum(['approve', 'dismiss']),
  slotOverrides: z.record(z.string(), z.string()).optional(),
  recipients: z.object({
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
  }).optional(),
});

async function requireTeamMember() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const service = getServiceClient();
  const { data } = await service
    .from('team_members')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  return data?.id ?? null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commId: string }> },
) {
  const { id: projectId, commId } = await ctx.params;
  const memberId = await requireTeamMember();
  if (!memberId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Guard: confirm the comm belongs to this project
  const service = getServiceClient();
  const { data: row } = await service
    .from('client_communications')
    .select('project_id')
    .eq('id', commId)
    .maybeSingle();
  if (!row || row.project_id !== projectId) {
    return NextResponse.json({ error: 'Communication not found' }, { status: 404 });
  }

  const result = body.action === 'approve'
    ? await approveCommunication(commId, memberId, body.slotOverrides, body.recipients)
    : await dismissCommunication(commId, memberId);

  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Action failed' }, { status: 400 });
  }
  return NextResponse.json({ success: true, communicationId: result.communicationId });
}
