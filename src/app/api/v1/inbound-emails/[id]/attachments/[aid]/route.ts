import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { assertUuid, isGoneError, loadAccessibleMessage } from '@/lib/inbound-email/agent-access';
import { nullableNumber } from '@/lib/inbound-email/agent-read';
import { attachmentLabelSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** Sets the one-line display label on an attachment (UI only), and nothing else. */
export const PATCH = withApi<{ agent_label: string | null }, { id: string; aid: string }>(
  async ({ supabase, params, body, teamMemberId, apiKeyId }) => {
    const message = await loadAccessibleMessage(supabase, teamMemberId, params.id);
    const attachmentId = assertUuid(params.aid, 'attachment id');
    const { data: before, error: beforeError } = await supabase.from('email_attachments')
      .select('id, agent_label').eq('id', attachmentId).eq('message_id', message.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) throw notFound('Attachment');
    const { data, error } = await supabase.from('email_attachments')
      .update({ agent_label: body.agent_label })
      .eq('id', attachmentId)
      .eq('message_id', message.id)
      .select('id, position, filename, content_type, size_bytes, skipped_reason, agent_label')
      .single();
    // Deleted (with its email, or by retention) between the read and the write.
    if (error) throw isGoneError(error) ? notFound('Attachment') : error;
    logAudit(supabase, {
      method: 'PATCH',
      endpoint: `/api/v1/inbound-emails/${message.id}/attachments/${attachmentId}`,
      entityType: 'email_attachment',
      entityId: attachmentId,
      apiKeyId,
      teamMemberId,
      requestBody: body,
      beforeSnapshot: before,
      afterSnapshot: data,
      statusCode: 200,
    });
    return success({ ...data, size_bytes: nullableNumber(data.size_bytes) });
  },
  { schema: attachmentLabelSchema, permission: 'inbound_email.triage' },
);
