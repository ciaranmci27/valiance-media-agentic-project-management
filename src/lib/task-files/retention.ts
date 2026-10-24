import type { SupabaseClient } from '@supabase/supabase-js';
import { copyAttachmentToProject } from './service';

/**
 * Before retention deletes an email, every task file linking one of its
 * attachments becomes the task's own upload: the bytes are copied to the
 * task's project in the task-files bucket ({project_id}/{sha256}) and the row
 * points there instead. Rows in Trash are kept the same way, so a restore
 * still has its file. A task that already has those bytes as an upload keeps
 * that one; the link goes to Trash, its place taken. A message whose files
 * cannot be copied is held back whole and tried again next run, so a link is
 * never left pointing at nothing (and the RESTRICT on email_attachment_id
 * would refuse the delete anyway).
 */

const CHUNK = 100;

interface Attachment { id: string; message_id: string; filename: string; content_type: string; storage_path: string | null; sha256: string | null }
interface LinkRow { id: string; task_id: string; email_attachment_id: string; deleted_at: string | null }

async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await read(ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export interface KeptTaskFiles {
  /** Task file rows that now hold their own copy. */
  kept: number;
  /** Messages to hold back: one of their linked files could not be copied. */
  failed: string[];
  last_error: string | null;
}

export async function keepLinkedTaskFiles(supabase: SupabaseClient, messageIds: string[]): Promise<KeptTaskFiles> {
  const result: KeptTaskFiles = { kept: 0, failed: [], last_error: null };
  if (messageIds.length === 0) return result;
  const attachments = await inChunks<Attachment>(messageIds, (chunk) => supabase.from('email_attachments')
    .select('id, message_id, filename, content_type, storage_path, sha256').in('message_id', chunk));
  if (attachments.length === 0) return result;
  // Every link, in Trash or not: the foreign key holds either way.
  const links = await inChunks<LinkRow>(attachments.map((row) => row.id), (chunk) => supabase.from('task_files')
    .select('id, task_id, email_attachment_id, deleted_at').in('email_attachment_id', chunk));
  if (links.length === 0) return result;
  // includes-deleted: a task in Trash still holds its links; its project decides where the copy goes.
  const tasks = await inChunks<{ id: string; project_id: string }>([...new Set(links.map((link) => link.task_id))], (chunk) => supabase.from('tasks')
    .select('id, project_id').in('id', chunk));
  const projectOf = new Map(tasks.map((task) => [task.id, task.project_id]));
  const attachmentById = new Map(attachments.map((row) => [row.id, row]));
  const failed = new Set<string>();
  const copies = new Map<string, { path: string; sha256: string }>();

  for (const link of links) {
    const attachment = attachmentById.get(link.email_attachment_id)!;
    if (failed.has(attachment.message_id)) continue;
    const projectId = projectOf.get(link.task_id);
    try {
      if (!projectId) throw new Error(`task ${link.task_id} has no project`);
      const copyKey = `${projectId}:${attachment.id}`;
      let stored = copies.get(copyKey);
      if (!stored) {
        stored = await copyAttachmentToProject(supabase, projectId, attachment);
        copies.set(copyKey, stored);
      }
      if (!link.deleted_at) {
        const { data: twin, error: twinError } = await supabase.from('task_files').select('id')
          .eq('task_id', link.task_id).eq('kind', 'upload').eq('sha256', stored.sha256).is('deleted_at', null).maybeSingle();
        if (twinError) throw new Error(twinError.message);
        if (twin) {
          const { error: trashError } = await supabase.rpc('soft_delete_record', { p_table: 'task_files', p_id: link.id });
          if (trashError) throw new Error(trashError.message);
        }
      }
      // includes-deleted: a link in Trash is converted too, so a restore still has its file.
      const { error } = await supabase.from('task_files')
        .update({ kind: 'upload', storage_path: stored.path, sha256: stored.sha256, email_attachment_id: null })
        .eq('id', link.id).eq('email_attachment_id', attachment.id);
      if (error) throw new Error(error.message);
      result.kept++;
    } catch (error) {
      failed.add(attachment.message_id);
      result.last_error = `task file ${link.id} of message ${attachment.message_id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000);
    }
  }
  result.failed = [...failed];
  return result;
}
