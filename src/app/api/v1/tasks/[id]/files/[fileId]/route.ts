import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { updateTaskFileSchema } from '@/lib/task-files/schemas';
import { apiContext, getTaskFile, trashTaskFile, updateTaskFile } from '@/lib/task-files/service';

export const dynamic = 'force-dynamic';

type Params = { id: string; fileId: string };

export const GET = withApi<unknown, Params>(async (ctx) => {
  return success(await getTaskFile(apiContext(ctx), ctx.params.id, ctx.params.fileId));
}, { permission: 'files.read' });

/** Renames the file or changes its note: your own, or any with files.manage. */
export const PATCH = withApi<{ name?: string; note?: string | null }, Params>(async (ctx) => {
  const files = apiContext(ctx);
  const before = await getTaskFile(files, ctx.params.id, ctx.params.fileId);
  const file = await updateTaskFile(files, ctx.params.id, ctx.params.fileId, ctx.body);
  logAudit(ctx.supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/tasks/${ctx.params.id}/files/${ctx.params.fileId}`,
    entityType: 'task_file',
    entityId: file.id,
    apiKeyId: ctx.apiKeyId,
    teamMemberId: ctx.teamMemberId,
    requestBody: ctx.body,
    beforeSnapshot: before,
    afterSnapshot: file,
    statusCode: 200,
  });
  return success(file);
}, { schema: updateTaskFileSchema, permission: ['files.upload', 'files.manage'] });

/** Moves the file to Trash (your own, or any with files.manage); a linked file itself stays where it is. */
export const DELETE = withApi<unknown, Params>(async (ctx) => {
  const files = apiContext(ctx);
  const before = await getTaskFile(files, ctx.params.id, ctx.params.fileId);
  await trashTaskFile(files, ctx.params.id, ctx.params.fileId);
  logAudit(ctx.supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/tasks/${ctx.params.id}/files/${ctx.params.fileId}`,
    entityType: 'task_file',
    entityId: ctx.params.fileId,
    apiKeyId: ctx.apiKeyId,
    teamMemberId: ctx.teamMemberId,
    beforeSnapshot: before,
    statusCode: 200,
  });
  return success({ deleted: true });
}, { permission: ['files.upload', 'files.manage'] });
