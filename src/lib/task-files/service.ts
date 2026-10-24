import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext, PermissionKey } from '@/lib/access-control';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { ApiError, badRequest, forbidden, notFound } from '@/lib/api/errors';
import { attachmentKind } from '@/lib/inbound-email/attachments';
import { INBOUND_EMAIL_BUCKET } from '@/lib/inbound-email/ingest';
import { trashApiError } from '@/lib/api/trash';
import { moveToTrash } from '@/lib/supabase/trash';

/**
 * A task's files, for the app (session routes) and the API (v1, MCP). Each
 * is one of three kinds:
 *
 *   upload            the task's own copy, in the private task-files bucket at
 *                     {project_id}/{sha256}: the same bytes on several tasks of
 *                     a project are one object. The server computes the hash
 *                     from the bytes it stores; nobody names a path.
 *   email_attachment  a link to an email's stored attachment. Linking needs
 *                     the email's inbox to be readable by the person linking;
 *                     after that the task's readers open it with the task.
 *                     An email due for deletion within RETENTION_MARGIN_DAYS
 *                     is copied as an upload instead, and retention copies
 *                     the rest before it deletes (task-files/retention.ts).
 *   project_file      a link to a file on the task's own project.
 *
 * Only the server writes task_files (20261024074521): every check here is
 * one the database cannot make. Reads come back as TaskFileView, with links
 * to open them signed for a minute (download) or five (inline, only for the
 * kinds the browser shows safely: images, PDFs, text).
 */

export const TASK_FILES_BUCKET = 'task-files';
/** The bucket's own limit (file_size_limit). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** content_base64 uploads: the JSON body stays under Vercel's 4.5 MB request cap. */
export const MAX_INLINE_UPLOAD_BYTES = 3 * 1024 * 1024;
/** Storage's signed upload links last two hours, whatever is asked for. */
export const UPLOAD_LINK_SECONDS = 2 * 60 * 60;
const DOWNLOAD_SECONDS = 60;
const INLINE_SECONDS = 300;
/** Retention runs daily; an email this close to its retention date is copied, not linked. */
export const RETENTION_MARGIN_DAYS = 2;

export type TaskFileKind = 'upload' | 'email_attachment' | 'project_file';
export type TaskFilePreview = 'image' | 'pdf' | 'text';

export interface TaskFileView {
  id: string;
  task_id: string;
  kind: TaskFileKind;
  name: string;
  mime_type: string;
  file_size: number;
  note: string | null;
  added_by: string | null;
  created_at: string;
  updated_at: string;
  /** What the browser can show inline; null means download only. */
  preview: TaskFilePreview | null;
  /** False when the linked project file is in Trash or the attachment was never stored. */
  available: boolean;
  /** Where a link points. The email's ids and subject only when the reader can open its inbox. */
  source:
    | { type: 'email'; attachment_id: string; message_id: string | null; thread_id: string | null; subject: string | null }
    | { type: 'project_file'; entity_file_id: string }
    | null;
}

export type AddTaskFileInput =
  | { content_base64: string; name: string; mime_type?: string; note?: string | null }
  | { upload_id: string; name: string; mime_type?: string; note?: string | null }
  | { email_attachment_id: string; name?: string; note?: string | null }
  | { entity_file_id: string; name?: string; note?: string | null };

export interface TaskFilesContext {
  /** The service role, naming the member (getActorClient) so the activity log can. */
  db: SupabaseClient;
  access: AccessContext;
  memberId: string;
  channel: 'app' | 'api';
  /** API only: the key's scopes. A permission must be on both the key and the member. */
  scopes?: string[];
}

interface TaskRow { id: string; project_id: string }

interface FileRow {
  id: string;
  task_id: string;
  kind: TaskFileKind;
  storage_path: string | null;
  sha256: string | null;
  email_attachment_id: string | null;
  entity_file_id: string | null;
  name: string;
  mime_type: string;
  file_size: number | string;
  note: string | null;
  added_by: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size_bytes: number | string | null;
  sha256: string | null;
  storage_path: string | null;
  uploaded_at: string | null;
  skipped_reason: string | null;
}

interface EntityFileRow {
  id: string;
  entity_type: string;
  entity_id: string;
  name: string;
  file_url: string;
  file_size: number | string | null;
  mime_type: string | null;
  deleted_at: string | null;
}

const FILE_COLUMNS = 'id, task_id, kind, storage_path, sha256, email_attachment_id, entity_file_id, name, mime_type, file_size, note, added_by, created_at, updated_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

function assertId(value: string, what: string): string {
  if (!UUID.test(value)) throw badRequest(`${what} must be a uuid`);
  return value.toLowerCase();
}

/** On the member and, for a key, on the key too; a broader permission counts. */
function can(ctx: TaskFilesContext, permission: PermissionKey): boolean {
  const options: PermissionKey[] = permission === 'files.read' ? ['files.read', 'files.manage'] : [permission];
  return options.some((option) => accessAllows(ctx.access, option, ctx.channel)
    && (ctx.channel === 'app' || (ctx.scopes ?? []).includes(option)));
}

function requirePermission(ctx: TaskFilesContext, permission: PermissionKey, message: string) {
  if (!can(ctx, permission)) throw forbidden(message, { reason: 'missing_permission', permission });
}

/** A file name as stored: no folders, no control characters, at most 255 characters. */
export function cleanFileName(name: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim();
  if (!base) throw badRequest('name must not be empty');
  return base.slice(0, 255);
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
};

function cleanMime(value: string | null | undefined, name: string): string {
  const type = (value ?? '').split(';')[0].trim().toLowerCase();
  if (MIME.test(type) && type !== 'application/octet-stream') return type;
  const extension = name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  return (extension && TYPE_BY_EXTENSION[extension]) || 'application/octet-stream';
}

/**
 * The type an object is stored (and so served) with: its own for what the
 * browser shows safely, otherwise a plain download. A file declared as HTML
 * or SVG is never served as one.
 */
function storedType(mimeType: string, name: string): string {
  return previewOf(mimeType, name) ? mimeType : 'application/octet-stream';
}

function cleanNote(note: string | null | undefined): string | null {
  const text = note?.trim();
  if (!text) return null;
  if (text.length > 500) throw badRequest('note must be 500 characters or fewer');
  return text;
}

function previewOf(mimeType: string, name: string): TaskFilePreview | null {
  const kind = attachmentKind(mimeType, name);
  return kind === 'other' ? null : kind;
}

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function isDuplicateObject(error: unknown): boolean {
  const value = error as { statusCode?: string | number; status?: number; message?: string };
  return String(value.statusCode ?? '') === '409' || value.status === 409 || /already exists|duplicate/i.test(value.message ?? '');
}

function isMissingObject(error: unknown): boolean {
  const value = error as { statusCode?: string | number; status?: number; message?: string };
  return String(value.statusCode ?? '') === '404' || value.status === 404 || /not found/i.test(value.message ?? '');
}

/**
 * A download does not read the error body, so a missing object comes back as
 * the bare response: Storage answers one with 400 (or 404).
 */
function isMissingDownload(error: unknown): boolean {
  const status = (error as { originalError?: { status?: number } }).originalError?.status;
  return isMissingObject(error) || status === 400 || status === 404;
}

async function loadTask(ctx: TaskFilesContext, taskId: string): Promise<TaskRow> {
  const id = assertId(taskId, 'task id');
  const { data, error } = await ctx.db.from('tasks')
    .select('id, project_id, project:projects!inner(id)')
    .eq('id', id).is('deleted_at', null).is('project.deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data || !accessAllowsProject(ctx.access, data.project_id, ctx.channel)) throw notFound('Task');
  return { id: data.id, project_id: data.project_id };
}

async function loadFile(ctx: TaskFilesContext, task: TaskRow, fileId: string): Promise<FileRow> {
  const id = assertId(fileId, 'file id');
  const { data, error } = await ctx.db.from('task_files').select(FILE_COLUMNS)
    .eq('id', id).eq('task_id', task.id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Task file');
  return data as FileRow;
}

/** The inboxes this reader opens: in the app as the Inbox scopes them, through a key only with inbound_email.read on both sides. */
async function readableInboxes(ctx: TaskFilesContext): Promise<Set<string>> {
  if (ctx.channel === 'app' && accessAllows(ctx.access, 'inbound_email.manage', 'app')) {
    const { data, error } = await ctx.db.from('email_inboxes').select('id');
    if (error) throw error;
    return new Set((data ?? []).map((row: { id: string }) => row.id));
  }
  if (!can(ctx, 'inbound_email.read') && !can(ctx, 'inbound_email.manage')) return new Set();
  const { data, error } = await ctx.db.from('email_inbox_access').select('inbox_id').eq('member_id', ctx.memberId);
  if (error) throw error;
  return new Set((data ?? []).map((row: { inbox_id: string }) => row.inbox_id));
}

async function views(ctx: TaskFilesContext, rows: FileRow[]): Promise<TaskFileView[]> {
  const attachmentIds = rows.flatMap((row) => (row.email_attachment_id ? [row.email_attachment_id] : []));
  const entityFileIds = rows.flatMap((row) => (row.entity_file_id ? [row.entity_file_id] : []));
  const [attachments, entityFiles] = await Promise.all([
    attachmentIds.length
      ? ctx.db.from('email_attachments').select('id, message_id, storage_path, uploaded_at, skipped_reason').in('id', attachmentIds)
      : Promise.resolve({ data: [], error: null }),
    entityFileIds.length
      ? ctx.db.from('entity_files').select('id, deleted_at').in('id', entityFileIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (attachments.error) throw attachments.error;
  if (entityFiles.error) throw entityFiles.error;
  const attachmentById = new Map((attachments.data as Pick<AttachmentRow, 'id' | 'message_id' | 'storage_path' | 'uploaded_at' | 'skipped_reason'>[]).map((row) => [row.id, row]));
  const liveEntityFiles = new Set((entityFiles.data as { id: string; deleted_at: string | null }[]).filter((row) => !row.deleted_at).map((row) => row.id));

  const messageIds = [...new Set([...attachmentById.values()].map((row) => row.message_id))];
  const messages = new Map<string, { id: string; inbox_id: string; thread_id: string; subject: string | null }>();
  if (messageIds.length) {
    const { data, error } = await ctx.db.from('email_messages').select('id, inbox_id, thread_id, subject').in('id', messageIds);
    if (error) throw error;
    for (const message of data ?? []) messages.set(message.id, message);
  }
  const readable = messageIds.length ? await readableInboxes(ctx) : new Set<string>();

  return rows.map((row) => {
    let source: TaskFileView['source'] = null;
    let available = true;
    if (row.kind === 'email_attachment' && row.email_attachment_id) {
      const attachment = attachmentById.get(row.email_attachment_id);
      const message = attachment ? messages.get(attachment.message_id) : undefined;
      const open = !!message && readable.has(message.inbox_id);
      available = !!attachment?.storage_path && !!attachment.uploaded_at && !attachment.skipped_reason;
      source = {
        type: 'email',
        attachment_id: row.email_attachment_id,
        message_id: open ? message!.id : null,
        thread_id: open ? message!.thread_id : null,
        subject: open ? message!.subject : null,
      };
    } else if (row.kind === 'project_file' && row.entity_file_id) {
      available = liveEntityFiles.has(row.entity_file_id);
      source = { type: 'project_file', entity_file_id: row.entity_file_id };
    }
    return {
      id: row.id,
      task_id: row.task_id,
      kind: row.kind,
      name: row.name,
      mime_type: row.mime_type,
      file_size: Number(row.file_size ?? 0),
      note: row.note,
      added_by: row.added_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      preview: previewOf(row.mime_type, row.name),
      available,
      source,
    };
  });
}

/** Every live file on the task, oldest first. */
export async function listTaskFiles(ctx: TaskFilesContext, taskId: string): Promise<TaskFileView[]> {
  requirePermission(ctx, 'files.read', 'Seeing task files needs permission to read files');
  const task = await loadTask(ctx, taskId);
  const { data, error } = await ctx.db.from('task_files').select(FILE_COLUMNS)
    .eq('task_id', task.id).is('deleted_at', null).order('created_at').order('id');
  if (error) throw error;
  return views(ctx, (data ?? []) as FileRow[]);
}

export async function getTaskFile(ctx: TaskFilesContext, taskId: string, fileId: string): Promise<TaskFileView> {
  requirePermission(ctx, 'files.read', 'Seeing task files needs permission to read files');
  const task = await loadTask(ctx, taskId);
  return (await views(ctx, [await loadFile(ctx, task, fileId)]))[0];
}

/**
 * Stores bytes as the project's object for their hash. The same bytes are
 * already there when another task of the project has them; that is not an error.
 */
async function storeBytes(ctx: TaskFilesContext, projectId: string, bytes: Buffer, mimeType: string, name: string): Promise<{ path: string; sha256: string }> {
  const sha256 = sha256Of(bytes);
  const path = `${projectId}/${sha256}`;
  // trash-checked: a Storage bucket, not a table.
  const { error } = await ctx.db.storage.from(TASK_FILES_BUCKET).upload(path, bytes, { contentType: storedType(mimeType, name), upsert: false });
  if (error && !isDuplicateObject(error)) throw new ApiError(502, 'STORAGE_ERROR', 'Could not store the file');
  return { path, sha256 };
}

/**
 * Copies one stored email attachment to the project's object for its hash,
 * server side when Storage can, by download and upload when it cannot.
 */
export async function copyAttachmentToProject(
  db: SupabaseClient,
  projectId: string,
  attachment: Pick<AttachmentRow, 'storage_path' | 'sha256' | 'content_type' | 'filename'>,
): Promise<{ path: string; sha256: string }> {
  if (!attachment.storage_path) throw new Error('the attachment was not stored');
  let sha256 = attachment.sha256;
  let bytes: Buffer | null = null;
  if (!sha256) {
    const { data, error } = await db.storage.from(INBOUND_EMAIL_BUCKET).download(attachment.storage_path);
    if (error || !data) throw new Error(`could not read the attachment: ${error?.message ?? 'no data'}`);
    bytes = Buffer.from(await data.arrayBuffer());
    sha256 = sha256Of(bytes);
  }
  const path = `${projectId}/${sha256}`;
  if (!bytes) {
    const copied = await db.storage.from(INBOUND_EMAIL_BUCKET).copy(attachment.storage_path, path, { destinationBucket: TASK_FILES_BUCKET });
    if (!copied.error || isDuplicateObject(copied.error)) return { path, sha256 };
    const { data, error } = await db.storage.from(INBOUND_EMAIL_BUCKET).download(attachment.storage_path);
    if (error || !data) throw new Error(`could not read the attachment: ${error?.message ?? 'no data'}`);
    bytes = Buffer.from(await data.arrayBuffer());
  }
  const { error } = await db.storage.from(TASK_FILES_BUCKET).upload(path, bytes, { contentType: storedType(attachment.content_type, attachment.filename), upsert: false });
  if (error && !isDuplicateObject(error)) throw new Error(`could not store the copy: ${error.message}`);
  return { path, sha256 };
}

/** A two-hour link to upload one file's bytes to; add it with its upload_id once the bytes are there. */
export async function createUploadLink(ctx: TaskFilesContext, taskId: string): Promise<{ upload_id: string; upload_url: string; token: string; expires_at: string; max_bytes: number }> {
  requirePermission(ctx, 'files.upload', 'Adding files to a task needs permission to upload files');
  const task = await loadTask(ctx, taskId);
  const uploadId = randomUUID();
  const { data, error } = await ctx.db.storage.from(TASK_FILES_BUCKET).createSignedUploadUrl(`${task.project_id}/incoming/${uploadId}`);
  if (error || !data) throw new ApiError(502, 'STORAGE_ERROR', 'Could not create an upload link');
  return {
    upload_id: uploadId,
    upload_url: data.signedUrl,
    token: data.token,
    expires_at: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    max_bytes: MAX_FILE_BYTES,
  };
}

/** The bytes uploaded to an upload link, read back so the server hashes them itself; the upload is removed once stored. */
async function claimUpload(ctx: TaskFilesContext, projectId: string, uploadId: string): Promise<{ bytes: Buffer; contentType: string | null; remove: () => Promise<void> }> {
  const incoming = `${projectId}/incoming/${assertId(uploadId, 'upload_id')}`;
  const bucket = ctx.db.storage.from(TASK_FILES_BUCKET);
  const { data, error } = await bucket.download(incoming);
  if (error || !data) {
    if (!error || isMissingDownload(error)) {
      throw new ApiError(409, 'CONFLICT', 'Nothing was uploaded for this upload_id. Upload the file to its upload_url first.', { reason: 'upload_missing' });
    }
    throw new ApiError(502, 'STORAGE_ERROR', 'Could not read the upload');
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const remove = async () => { await bucket.remove([incoming]); };
  if (bytes.length > MAX_FILE_BYTES) {
    await remove();
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Task files can be at most 50 MB');
  }
  if (bytes.length === 0) {
    await remove();
    throw badRequest('The uploaded file is empty');
  }
  return { bytes, contentType: data.type || null, remove };
}

async function existingLive(ctx: TaskFilesContext, taskId: string, column: 'sha256' | 'email_attachment_id' | 'entity_file_id', kind: TaskFileKind, value: string): Promise<FileRow | null> {
  const { data, error } = await ctx.db.from('task_files').select(FILE_COLUMNS)
    .eq('task_id', taskId).eq('kind', kind).eq(column, value).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return (data as FileRow | null) ?? null;
}

/** Inserts the row, or answers with the live one already there for the same file (one per file per task). */
async function insertOnce(ctx: TaskFilesContext, row: Omit<FileRow, 'id' | 'created_at' | 'updated_at'>, key: { column: 'sha256' | 'email_attachment_id' | 'entity_file_id'; value: string }): Promise<{ row: FileRow; created: boolean }> {
  const before = await existingLive(ctx, row.task_id, key.column, row.kind, key.value);
  if (before) return { row: before, created: false };
  const { data, error } = await ctx.db.from('task_files').insert(row).select(FILE_COLUMNS).single();
  if (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    const raced = await existingLive(ctx, row.task_id, key.column, row.kind, key.value);
    if (!raced) throw error;
    return { row: raced, created: false };
  }
  return { row: data as FileRow, created: true };
}

/**
 * Adds a file to the task: bytes (content_base64, or an upload_id from
 * createUploadLink), an email attachment, or a project file. Adding a file
 * the task already has answers with that entry and created: false.
 */
export async function addTaskFile(ctx: TaskFilesContext, taskId: string, input: AddTaskFileInput): Promise<{ file: TaskFileView; created: boolean }> {
  requirePermission(ctx, 'files.upload', 'Adding files to a task needs permission to upload files');
  const task = await loadTask(ctx, taskId);
  const note = cleanNote(input.note);
  const base = { task_id: task.id, note, added_by: ctx.memberId, storage_path: null, sha256: null, email_attachment_id: null, entity_file_id: null };
  let result: { row: FileRow; created: boolean };

  if ('content_base64' in input || 'upload_id' in input) {
    const name = cleanFileName(input.name);
    let bytes: Buffer;
    let mime: string;
    let removeUpload: (() => Promise<void>) | null = null;
    if ('content_base64' in input) {
      bytes = Buffer.from(input.content_base64, 'base64');
      if (bytes.length === 0) throw badRequest('content_base64 is empty or not base64');
      if (bytes.length > MAX_INLINE_UPLOAD_BYTES) {
        throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'content_base64 can carry at most 3 MB. For larger files, upload to an upload link and add it by upload_id.');
      }
      mime = cleanMime(input.mime_type, name);
    } else {
      const upload = await claimUpload(ctx, task.project_id, input.upload_id);
      bytes = upload.bytes;
      mime = cleanMime(input.mime_type ?? upload.contentType, name);
      removeUpload = upload.remove;
    }
    const stored = await storeBytes(ctx, task.project_id, bytes, mime, name);
    result = await insertOnce(ctx, {
      ...base,
      kind: 'upload',
      storage_path: stored.path,
      sha256: stored.sha256,
      name,
      mime_type: mime,
      file_size: bytes.length,
    }, { column: 'sha256', value: stored.sha256 });
    // Stored under its hash now; the upload link's copy is not needed.
    await removeUpload?.().catch(() => undefined);
  } else if ('email_attachment_id' in input) {
    result = await addEmailAttachment(ctx, task, assertId(input.email_attachment_id, 'email_attachment_id'), input.name, base);
  } else {
    result = await addProjectFile(ctx, task, assertId(input.entity_file_id, 'entity_file_id'), input.name, base);
  }
  return { file: (await views(ctx, [result.row]))[0], created: result.created };
}

type BaseRow = Pick<FileRow, 'task_id' | 'note' | 'added_by' | 'storage_path' | 'sha256' | 'email_attachment_id' | 'entity_file_id'>;

async function addEmailAttachment(ctx: TaskFilesContext, task: TaskRow, attachmentId: string, name: string | undefined, base: BaseRow) {
  const { data: attachment, error } = await ctx.db.from('email_attachments')
    .select('id, message_id, filename, content_type, size_bytes, sha256, storage_path, uploaded_at, skipped_reason')
    .eq('id', attachmentId).maybeSingle();
  if (error) throw error;
  const { data: message, error: messageError } = attachment
    ? await ctx.db.from('email_messages').select('id, inbox_id, status, received_at').eq('id', (attachment as AttachmentRow).message_id).maybeSingle()
    : { data: null, error: null };
  if (messageError) throw messageError;
  // An attachment the person cannot open reads as missing, as it does in the Inbox.
  if (!attachment || !message || message.status === 'receiving' || !(await readableInboxes(ctx)).has(message.inbox_id)) {
    throw notFound('Email attachment');
  }
  const row = attachment as AttachmentRow;
  if (row.skipped_reason || !row.storage_path || !row.uploaded_at) {
    throw new ApiError(409, 'CONFLICT', 'This attachment was not stored (it was over the size limit), so there is nothing to add', { reason: row.skipped_reason ?? 'not_stored' });
  }
  const fileName = cleanFileName(name || row.filename || 'attachment');
  const mime = cleanMime(row.content_type, fileName);
  const size = Number(row.size_bytes ?? 0);

  const { data: inbox, error: inboxError } = await ctx.db.from('email_inboxes').select('retention_days').eq('id', message.inbox_id).single();
  if (inboxError) throw inboxError;
  const deletesAt = new Date(message.received_at).getTime() + Number(inbox.retention_days) * 86_400_000;
  if (deletesAt - Date.now() < RETENTION_MARGIN_DAYS * 86_400_000) {
    // About to be deleted: the task gets its own copy now, not a link that retention would have to rescue.
    let stored: { path: string; sha256: string };
    try {
      stored = await copyAttachmentToProject(ctx.db, task.project_id, row);
    } catch {
      throw new ApiError(502, 'STORAGE_ERROR', 'Could not copy the attachment');
    }
    return insertOnce(ctx, { ...base, kind: 'upload', storage_path: stored.path, sha256: stored.sha256, name: fileName, mime_type: mime, file_size: size },
      { column: 'sha256', value: stored.sha256 });
  }
  return insertOnce(ctx, { ...base, kind: 'email_attachment', email_attachment_id: row.id, name: fileName, mime_type: mime, file_size: size },
    { column: 'email_attachment_id', value: row.id });
}

async function addProjectFile(ctx: TaskFilesContext, task: TaskRow, entityFileId: string, name: string | undefined, base: BaseRow) {
  const { data, error } = await ctx.db.from('entity_files')
    .select('id, entity_type, entity_id, name, file_url, file_size, mime_type, deleted_at')
    .eq('id', entityFileId).maybeSingle();
  if (error) throw error;
  const file = data as EntityFileRow | null;
  if (!file || file.deleted_at || file.entity_type !== 'project' || file.entity_id !== task.project_id) {
    throw notFound("File on this task's project");
  }
  if (!/^https?:\/\//.test(file.file_url)) throw new ApiError(409, 'CONFLICT', 'This project file has nothing stored to link to');
  const fileName = cleanFileName(name || file.name);
  return insertOnce(ctx, {
    ...base,
    kind: 'project_file',
    entity_file_id: file.id,
    name: fileName,
    mime_type: cleanMime(file.mime_type, fileName),
    file_size: Number(file.file_size ?? 0),
  }, { column: 'entity_file_id', value: file.id });
}

function assertMayChange(ctx: TaskFilesContext, file: FileRow) {
  if (file.added_by === ctx.memberId ? can(ctx, 'files.upload') || can(ctx, 'files.manage') : can(ctx, 'files.manage')) return;
  throw forbidden("Changing someone else's task file needs permission to manage files", { reason: 'not_yours' });
}

/** Renames a task file or changes its note: your own, or any with files.manage. */
export async function updateTaskFile(ctx: TaskFilesContext, taskId: string, fileId: string, changes: { name?: string; note?: string | null }): Promise<TaskFileView> {
  const task = await loadTask(ctx, taskId);
  const file = await loadFile(ctx, task, fileId);
  assertMayChange(ctx, file);
  const update: Record<string, unknown> = {};
  if (changes.name !== undefined) update.name = cleanFileName(changes.name);
  if (changes.note !== undefined) update.note = cleanNote(changes.note);
  if (Object.keys(update).length === 0) throw badRequest('Send name or note');
  const { data, error } = await ctx.db.from('task_files').update(update)
    .eq('id', file.id).is('deleted_at', null).select(FILE_COLUMNS).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Task file');
  return (await views(ctx, [data as FileRow]))[0];
}

/** Moves a task file to Trash: your own, or any with files.manage. Its bytes stay for a restore. */
export async function trashTaskFile(ctx: TaskFilesContext, taskId: string, fileId: string): Promise<void> {
  const task = await loadTask(ctx, taskId);
  const file = await loadFile(ctx, task, fileId);
  assertMayChange(ctx, file);
  let moved: boolean;
  try {
    moved = await moveToTrash(ctx.db, 'task_files', file.id, ctx.memberId);
  } catch (error) {
    throw trashApiError(error, 'Task file');
  }
  if (!moved) throw notFound('Task file');
}

/**
 * A short link to open a task file: a one-minute download, or with `inline`
 * a five-minute link the browser shows (images, PDFs and text only, never a
 * file's own HTML or SVG). Through a key, a linked email attachment opens
 * only if its inbox lets agents read that kind, as the inbox's own
 * attachment link does.
 */
export async function taskFileLink(ctx: TaskFilesContext, taskId: string, fileId: string, options: { inline?: boolean } = {}): Promise<{ url: string; name: string; mime_type: string; expires_in: number }> {
  requirePermission(ctx, 'files.read', 'Opening task files needs permission to read files');
  const task = await loadTask(ctx, taskId);
  const file = await loadFile(ctx, task, fileId);
  const preview = previewOf(file.mime_type, file.name);
  if (options.inline && !preview) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This file cannot be opened in the browser. Download it instead.');
  const expiresIn = options.inline ? INLINE_SECONDS : DOWNLOAD_SECONDS;
  const sign = async (bucket: string, path: string) => {
    // trash-checked: a Storage bucket, not a table.
    const { data, error } = await ctx.db.storage.from(bucket)
      .createSignedUrl(path, expiresIn, options.inline ? undefined : { download: file.name || true });
    if (error && isMissingObject(error)) throw notFound('Stored file');
    if (error || !data?.signedUrl) throw new ApiError(502, 'STORAGE_ERROR', 'Could not create a link');
    return data.signedUrl;
  };

  let url: string;
  if (file.kind === 'upload') {
    // Only ever the task's own project's objects.
    if (!file.storage_path?.startsWith(`${task.project_id}/`)) throw notFound('Stored file');
    url = await sign(TASK_FILES_BUCKET, file.storage_path);
  } else if (file.kind === 'email_attachment') {
    const { data: attachment, error } = await ctx.db.from('email_attachments')
      .select('id, message_id, filename, content_type, storage_path, uploaded_at, skipped_reason').eq('id', file.email_attachment_id!).maybeSingle();
    if (error) throw error;
    if (!attachment?.storage_path || !attachment.uploaded_at || attachment.skipped_reason) {
      throw new ApiError(409, 'CONFLICT', 'This attachment was not stored, so there is nothing to open');
    }
    if (ctx.channel === 'api') {
      const { data: message, error: messageError } = await ctx.db.from('email_messages')
        .select('inbox:email_inboxes!inner(agent_readable_types)').eq('id', attachment.message_id).single();
      if (messageError) throw messageError;
      const readableTypes = ((message.inbox as unknown as { agent_readable_types: string[] | null }).agent_readable_types ?? []);
      const kind = attachmentKind(attachment.content_type, attachment.filename);
      if (!readableTypes.includes(kind)) {
        throw forbidden('Agents cannot open this kind of attachment from its inbox', { reason: 'not_agent_readable', kind, agent_readable_types: readableTypes });
      }
    }
    url = await sign(INBOUND_EMAIL_BUCKET, attachment.storage_path);
  } else {
    const { data, error } = await ctx.db.from('entity_files')
      .select('id, entity_type, entity_id, file_url, deleted_at').eq('id', file.entity_file_id!).maybeSingle();
    if (error) throw error;
    if (!data || data.deleted_at || data.entity_type !== 'project' || data.entity_id !== task.project_id) throw notFound('Project file');
    // Project files live in the public entity-files bucket.
    url = data.file_url;
  }
  return { url, name: file.name, mime_type: file.mime_type, expires_in: expiresIn };
}

/** The context for a v1 route: its actor client, the key's member and scopes. */
export function apiContext(ctx: { supabase: SupabaseClient; access: AccessContext; teamMemberId: string; scopes: string[] }): TaskFilesContext {
  return { db: ctx.supabase, access: ctx.access, memberId: ctx.teamMemberId, channel: 'api', scopes: ctx.scopes };
}
