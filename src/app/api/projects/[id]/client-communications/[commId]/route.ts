import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceClient } from '@/lib/api/supabase-service';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
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

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; commId: string }> },
) {
  const { id: projectId, commId } = await ctx.params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllows(auth.data.access, 'communications.manage') || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const memberId = auth.data.memberId;

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
