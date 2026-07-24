import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceClient } from '@/lib/api/supabase-service';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import {
  previewCommunication,
  sendCommunication,
  type RenderContext,
} from '@/lib/email/client-notifications';
import { CLIENT_COMM_TYPES, type ClientCommType } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const renderContextSchema = z.object({
  thresholdPct: z.number().optional(),
  milestone: z.number().optional(),
  oldBudget: z.number().optional(),
  newBudget: z.number().optional(),
  oldBudgetType: z.enum(['hours', 'amount']).optional(),
  newBudgetType: z.enum(['hours', 'amount']).optional(),
  invoiceId: z.string().uuid().optional(),
}).optional();

const recipientsSchema = z.object({
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
}).optional();

const postSchema = z.object({
  action: z.enum(['preview', 'send']),
  type: z.enum(CLIENT_COMM_TYPES as unknown as [string, ...string[]]),
  slotOverrides: z.record(z.string(), z.string()).optional(),
  context: renderContextSchema,
  recipients: recipientsSchema,
});

// GET — list communications for the project (optionally filtered by status)
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllows(auth.data.access, 'communications.read') || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const status = req.nextUrl.searchParams.get('status');
  const service = getServiceClient();
  let query = service
    .from('client_communications')
    .select('*, contact:contacts(id, name, email)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (status && status !== 'all') {
    query = query.eq('status', status);
  }
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ communications: data });
}

// POST — preview or send a communication
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  if (!accessAllows(auth.data.access, 'communications.manage') || !accessAllowsProject(auth.data.access, projectId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const memberId = auth.data.memberId;

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = body.type as ClientCommType;
  const overrides = body.slotOverrides || {};
  const context: RenderContext = body.context || {};
  const recipients = body.recipients;

  if (type === 'invoice') {
    const canReadInvoices = accessAllows(auth.data.access, 'invoices.read')
      || accessAllows(auth.data.access, 'invoices.manage');
    const canSendInvoices = accessAllows(auth.data.access, 'invoices.manage');
    if (!canReadInvoices || (body.action === 'send' && !canSendInvoices)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  if (body.action === 'preview') {
    const result = await previewCommunication(projectId, type, overrides, context, recipients);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      to: result.to,
      cc: result.cc,
      bcc: result.bcc,
      subject: result.subject,
      html: result.html,
      text: result.text,
      defaults: result.defaults,
      metadata: result.metadata,
      attachments: result.attachments || [],
    });
  }

  const result = await sendCommunication(projectId, type, {
    slotOverrides: overrides,
    triggeredBy: memberId,
    context,
    recipients,
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Send failed' }, { status: 400 });
  }
  return NextResponse.json({ success: true, communicationId: result.communicationId });
}
