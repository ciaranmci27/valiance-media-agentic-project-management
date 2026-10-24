import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { addTaskFileSchema } from '@/lib/task-files/schemas';
import { addTaskFile, apiContext, listTaskFiles, type AddTaskFileInput } from '@/lib/task-files/service';

export const dynamic = 'force-dynamic';

/** Every file on the task, oldest first: its own uploads and links to email attachments and project files. */
export const GET = withApi<unknown, { id: string }>(async (ctx) => {
  return success(await listTaskFiles(apiContext(ctx), ctx.params.id));
}, { permission: 'files.read' });

/**
 * Adds a file: content_base64 (3 MB at most), an upload_id from
 * POST /files/uploads, an email_attachment_id or an entity_file_id. 201 when
 * added; 200 with the existing entry when the task already has that file.
 */
export const POST = withApi<AddTaskFileInput, { id: string }>(async (ctx) => {
  const { file, created: added } = await addTaskFile(apiContext(ctx), ctx.params.id, ctx.body);
  if (added) {
    // The bytes are not part of the audit record.
    const requestBody: Record<string, unknown> = { ...ctx.body };
    delete requestBody.content_base64;
    logAudit(ctx.supabase, {
      method: 'POST',
      endpoint: `/api/v1/tasks/${ctx.params.id}/files`,
      entityType: 'task_file',
      entityId: file.id,
      apiKeyId: ctx.apiKeyId,
      teamMemberId: ctx.teamMemberId,
      requestBody,
      afterSnapshot: file,
      statusCode: 201,
    });
  }
  return added ? created(file) : success(file);
}, { schema: addTaskFileSchema, permission: 'files.upload' });
