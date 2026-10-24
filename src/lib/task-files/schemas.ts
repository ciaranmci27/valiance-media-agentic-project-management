import { z } from 'zod';

const note = z.string().max(500, 'note must be 500 characters or fewer').nullable().optional();
const name = z.string().min(1, 'name must not be empty').max(255, 'name must be 255 characters or fewer');
const mimeType = z.string().max(255).optional();
const uuid = (what: string) => z.uuid(`${what} must be a uuid`);

/** Exactly one source: bytes (content_base64 or upload_id), an email attachment, or a project file. */
export const addTaskFileSchema = z.union([
  z.object({
    // 3 MB of bytes is 4 MiB of base64; the service checks the decoded size.
    content_base64: z.string().min(1).max(4_194_304, 'content_base64 can carry at most 3 MB').regex(/^[A-Za-z0-9+/]+={0,2}$/, 'content_base64 must be base64'),
    name,
    mime_type: mimeType,
    note,
  }).strict(),
  z.object({ upload_id: uuid('upload_id'), name, mime_type: mimeType, note }).strict(),
  z.object({ email_attachment_id: uuid('email_attachment_id'), name: name.optional(), note }).strict(),
  z.object({ entity_file_id: uuid('entity_file_id'), name: name.optional(), note }).strict(),
], { error: 'Send one of content_base64 (with name), upload_id (with name), email_attachment_id or entity_file_id' });

export const updateTaskFileSchema = z.object({ name: name.optional(), note }).strict()
  .refine((value) => value.name !== undefined || value.note !== undefined, 'Send name or note');
