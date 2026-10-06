import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { assertUuid, isGoneError, loadAccessibleMessage } from '@/lib/inbound-email/agent-access';
import { nullableNumber } from '@/lib/inbound-email/agent-read';
import { attachmentKind } from '@/lib/inbound-email/attachments';
import { INBOUND_EMAIL_BUCKET } from '@/lib/inbound-email/ingest';

export const dynamic = 'force-dynamic';

const SIGNED_URL_SECONDS = 300;

/** Storage answers a missing object with statusCode 404 (HTTP 400 or 404). */
function isMissingObject(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: string | number };
  return value.status === 404 || String(value.statusCode ?? '') === '404';
}

/**
 * A five-minute signed URL for one stored attachment, only for the kinds the
 * inbox lets agents read (agent_readable_types: image, pdf, text) and never
 * for a skipped or unstored file.
 */
export const GET = withApi<unknown, { id: string; aid: string }>(async ({ supabase, params, teamMemberId }) => {
  const message = await loadAccessibleMessage(supabase, teamMemberId, params.id);
  const attachmentId = assertUuid(params.aid, 'attachment id');
  const [{ data: attachment, error }, { data: inbox, error: inboxError }] = await Promise.all([
    supabase.from('email_attachments')
      .select('id, message_id, filename, content_type, size_bytes, storage_path, skipped_reason, uploaded_at')
      .eq('id', attachmentId).eq('message_id', message.id).maybeSingle(),
    supabase.from('email_inboxes').select('agent_readable_types').eq('id', message.inbox_id).single(),
  ]);
  if (error) throw error;
  if (inboxError) throw isGoneError(inboxError) ? notFound('Email') : inboxError;
  if (!attachment) throw notFound('Attachment');
  if (attachment.skipped_reason || !attachment.storage_path || !attachment.uploaded_at) {
    throw new ApiError(409, 'CONFLICT', 'This attachment was not stored', {
      reason: attachment.skipped_reason ?? 'not_stored',
    });
  }
  const kind = attachmentKind(attachment.content_type, attachment.filename);
  const readable = (inbox.agent_readable_types ?? []) as string[];
  if (!readable.includes(kind)) {
    throw forbidden('Agents cannot open this kind of attachment in this inbox', {
      reason: 'not_agent_readable',
      kind,
      agent_readable_types: readable,
    });
  }
  const { data: signed, error: signError } = await supabase.storage
    .from(INBOUND_EMAIL_BUCKET)
    .createSignedUrl(attachment.storage_path, SIGNED_URL_SECONDS);
  // The file was deleted (with its email or by retention) after the row was read.
  if (signError && isMissingObject(signError)) throw notFound('Attachment');
  if (signError || !signed) throw signError ?? new Error('No signed URL returned');
  return success({
    url: signed.signedUrl,
    expires_at: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString(),
    attachment_id: attachment.id,
    filename: attachment.filename,
    content_type: attachment.content_type,
    size_bytes: nullableNumber(attachment.size_bytes),
    kind,
  });
}, { permission: 'inbound_email.read' });
