/**
 * Task files through the real v1 routes (withApi, supabase-js, fake PostgREST
 * and Storage) and the app's service: uploads are stored once per project by
 * the hash the server computes, never served as HTML; an upload link's bytes
 * are claimed by upload_id; email attachments and project files are linked,
 * not copied, unless the email is about to be deleted; a key reads an
 * attachment only from an inbox it was granted and only kinds agents may
 * open; nobody reaches another project's task; renames and Trash are your
 * own unless you manage files.
 *
 * Runs on PGlite (real Postgres) over the whole real schema; nothing touches
 * a live database.
 *
 *   npm run -s test:task-files
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { FakeStorage } from './inbound-email-fixtures';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const SHOT = Buffer.from('a screenshot from the client');
const OLD_SHOT = Buffer.from('an attachment from three months ago');
const SPEC = Buffer.from('%PDF-1.7 the spec');
const ids = {
  inbox: '00000000-0000-4000-8000-0000000000a1',
  hiddenInbox: '00000000-0000-4000-8000-0000000000a2',
  thread: '00000000-0000-4000-8000-0000000000a3',
  hiddenThread: '00000000-0000-4000-8000-0000000000a7',
  message: '00000000-0000-4000-8000-0000000000a4',
  oldMessage: '00000000-0000-4000-8000-0000000000a5',
  hiddenMessage: '00000000-0000-4000-8000-0000000000a6',
  shot: '00000000-0000-4000-8000-0000000000b1',
  oldShot: '00000000-0000-4000-8000-0000000000b2',
  skipped: '00000000-0000-4000-8000-0000000000b3',
  hidden: '00000000-0000-4000-8000-0000000000b4',
  doc: '00000000-0000-4000-8000-0000000000b5',
};

async function seed(db: PGlite, storage: FakeStorage) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION public.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const agent = (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ('Ashley', 'ashley@example.com', 'agent') RETURNING id"))[0].id;
  const owner = (await q<{ id: string }>("INSERT INTO public.team_members (name, email, role) VALUES ('Ciaran', 'ciaran@example.com', 'owner') RETURNING id"))[0].id;
  const project = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id"))[0].id;
  const elsewhere = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  await db.query('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [project, agent]);
  const task = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Holiday banner') RETURNING id", [project]))[0].id;
  const sibling = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Footer banner') RETURNING id", [project]))[0].id;
  const hiddenTask = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Not theirs') RETURNING id", [elsewhere]))[0].id;
  const projectFile = (await q<{ id: string }>(`INSERT INTO public.entity_files (entity_type, entity_id, name, file_url, mime_type, file_size)
    VALUES ('project', $1, 'brand-guide.pdf', 'https://files.example.com/brand-guide.pdf', 'application/pdf', 900) RETURNING id`, [project]))[0].id;
  const otherProjectFile = (await q<{ id: string }>(`INSERT INTO public.entity_files (entity_type, entity_id, name, file_url)
    VALUES ('project', $1, 'apex.pdf', 'https://files.example.com/apex.pdf') RETURNING id`, [elsewhere]))[0].id;

  await db.exec(`
    INSERT INTO communications.inboxes (id, name, address, routing_domain, routing_local_part, retention_days)
      VALUES ('${ids.inbox}', 'Ops', 'ops@example.com', 'relay.example.com', 'ops', 90),
             ('${ids.hiddenInbox}', 'Billing', 'billing@example.com', 'relay.example.com', 'billing', 90);
    INSERT INTO communications.inbox_access (inbox_id, member_id) VALUES ('${ids.inbox}', '${agent}');
    INSERT INTO communications.conversations (id, inbox_id) VALUES ('${ids.thread}', '${ids.inbox}'), ('${ids.hiddenThread}', '${ids.hiddenInbox}');
    INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, subject, received_at) VALUES
      ('${ids.message}', '${ids.inbox}', '${ids.thread}', 'handled', 'resend', 'tfa-1', 'tfa-1@example.com', 'Banner feedback', now() - interval '1 day'),
      ('${ids.oldMessage}', '${ids.inbox}', '${ids.thread}', 'handled', 'resend', 'tfa-2', 'tfa-2@example.com', 'Old banner', now() - interval '89 days'),
      ('${ids.hiddenMessage}', '${ids.hiddenInbox}', '${ids.hiddenThread}', 'handled', 'resend', 'tfa-3', 'tfa-3@example.com', 'Invoice', now() - interval '1 day');
  `);
  const attach = (id: string, message: string, position: number, filename: string, type: string, bytes: Buffer | null) => db.query(
    `INSERT INTO communications.attachments (id, message_id, position, filename, content_type, storage_path, sha256, size_bytes, uploaded_at, skipped_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, message, position, filename, type, bytes ? `${ids.inbox}/${message}/${id}` : null, bytes ? sha(bytes) : null,
      bytes?.length ?? 99_000_000, bytes ? new Date().toISOString() : null, bytes ? null : 'over_size_cap']);
  await attach(ids.shot, ids.message, 0, 'screenshot.png', 'image/png', SHOT);
  await attach(ids.doc, ids.message, 1, 'contract.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('docx bytes'));
  await attach(ids.skipped, ids.message, 2, 'video.mov', 'video/quicktime', null);
  await attach(ids.oldShot, ids.oldMessage, 0, 'old.png', 'image/png', OLD_SHOT);
  await attach(ids.hidden, ids.hiddenMessage, 0, 'invoice.pdf', 'application/pdf', Buffer.from('invoice'));
  for (const [id, message, bytes] of [[ids.shot, ids.message, SHOT], [ids.doc, ids.message, Buffer.from('docx bytes')], [ids.oldShot, ids.oldMessage, OLD_SHOT], [ids.hidden, ids.hiddenMessage, Buffer.from('invoice')]] as const) {
    storage.objects.set(`inbound-email/${ids.inbox}/${message}/${id}`, { bytes, contentType: 'application/octet-stream' });
  }

  const key = async (name: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await db.query(`INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ($1, 'pk_live', $2, $3, $4, 'scoped')`, [name, sha(Buffer.from(secret)), agent, scopes]);
    return secret;
  };
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'files.read', 'files.upload', 'inbound_email.read']) AS key`, [agent]);
  const ashley = await key('Ashley', ['projects.read', 'tasks.read', 'files.read', 'files.upload', 'inbound_email.read']);
  const noInbox = await key('Files only', ['projects.read', 'tasks.read', 'files.read', 'files.upload']);
  return { agent, owner, project, elsewhere, task, sibling, hiddenTask, projectFile, otherProjectFile, ashley, noInbox };
}

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  const storage = new FakeStorage();
  const s = await seed(db, storage);
  const server = await startFakePostgrest(db, { handle: storage.handler });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely in checks
  type Body = { success?: boolean; data?: Record<string, any>; error?: { code?: string; message?: string; details?: Record<string, unknown> } };
  const files = await import('../src/app/api/v1/tasks/[id]/files/route');
  const uploads = await import('../src/app/api/v1/tasks/[id]/files/uploads/route');
  const one = await import('../src/app/api/v1/tasks/[id]/files/[fileId]/route');
  const link = await import('../src/app/api/v1/tasks/[id]/files/[fileId]/url/route');
  const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
    method: string, path: string, params: Record<string, string>, body?: unknown, apiKey = s.ashley) => {
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { params: Promise.resolve(params) } as never);
    return { status: response.status, body: await response.json() as Body };
  };
  const base = `/api/v1/tasks/${s.task}/files`;
  const add = (body: unknown, task = s.task, apiKey = s.ashley) => call(files.POST, 'POST', `/api/v1/tasks/${task}/files`, { id: task }, body, apiKey);
  const objectsIn = (bucket: string) => [...storage.objects.keys()].filter((key) => key.startsWith(`${bucket}/`));

  try {
    // --- Uploads, stored once by their hash ----------------------------------------------
    const png = await add({ content_base64: PNG.toString('base64'), name: 'C:\\shots\\banner.png', mime_type: 'image/png', note: 'the mockup Ciaran sent' });
    const pngPath = `${s.project}/${sha(PNG)}`;
    check('upload: base64 bytes become the task\'s own file, named without its folders', png.status === 201 && png.body.data?.kind === 'upload'
      && png.body.data?.name === 'banner.png' && png.body.data?.file_size === PNG.length && png.body.data?.preview === 'image' && png.body.data?.note === 'the mockup Ciaran sent', png);
    check('upload: stored at {project}/{sha256 of the bytes}, as an image',
      storage.objects.get(`task-files/${pngPath}`)?.contentType === 'image/png'
        && (await q<{ storage_path: string }>('SELECT storage_path FROM public.task_files WHERE id = $1', [png.body.data?.id]))[0]?.storage_path === pngPath);
    const again = await add({ content_base64: PNG.toString('base64'), name: 'banner copy.png' });
    check('upload: the same bytes on the same task answer with the entry already there', again.status === 200 && again.body.data?.id === png.body.data?.id, again);
    const sibling = await add({ content_base64: PNG.toString('base64'), name: 'banner.png' }, s.sibling);
    check('upload: the same bytes on another task of the project are one object',
      sibling.status === 201 && sibling.body.data?.id !== png.body.data?.id && objectsIn('task-files').length === 1, { sibling, objects: objectsIn('task-files') });
    const page = await add({ content_base64: Buffer.from('<script>alert(1)</script>').toString('base64'), name: 'page.html', mime_type: 'text/html' });
    const pageObject = [...storage.objects.entries()].find(([key]) => key.endsWith(sha(Buffer.from('<script>alert(1)</script>'))));
    check('upload: an HTML file is kept as a download, never served as a page',
      page.status === 201 && page.body.data?.preview === null && pageObject?.[1].contentType === 'application/octet-stream', { page, type: pageObject?.[1].contentType });
    const inlinePage = await call(link.GET, 'GET', `${base}/${page.body.data?.id}/url?inline=true`, { id: s.task, fileId: page.body.data?.id });
    check('upload: and it cannot be opened inline', inlinePage.status === 415, inlinePage);
    const tooBig = await add({ content_base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64'), name: 'big.bin' });
    check('upload: base64 carries at most 3 MB', tooBig.status === 422 || tooBig.status === 413, tooBig.status);
    const notBase64 = await add({ content_base64: 'not base64!', name: 'x.txt' });
    check('upload: content that is not base64 is refused', notBase64.status === 422, notBase64.status);

    // --- An upload link for larger files ---------------------------------------------------
    const ticket = await call(uploads.POST, 'POST', `${base}/uploads`, { id: s.task });
    const uploadId = ticket.body.data?.upload_id as string;
    check('upload link: two hours to put the bytes in the task\'s project',
      ticket.status === 201 && String(ticket.body.data?.upload_url).includes(`/task-files/${s.project}/incoming/${uploadId}`) && ticket.body.data?.max_bytes === 50 * 1024 * 1024, ticket);
    const early = await add({ upload_id: uploadId, name: 'spec.pdf' });
    check('upload link: adding before the bytes arrive says to upload first', early.status === 409 && early.body.error?.details?.reason === 'upload_missing', early);
    const put = await fetch(String(ticket.body.data?.upload_url), { method: 'PUT', headers: { 'content-type': 'text/html' }, body: SPEC });
    const spec = await add({ upload_id: uploadId, name: 'spec.pdf', mime_type: 'application/pdf' });
    check('upload link: the bytes are hashed by the server and stored under their hash; the upload is gone',
      put.ok && spec.status === 201 && spec.body.data?.file_size === SPEC.length && spec.body.data?.preview === 'pdf'
        && storage.objects.get(`task-files/${s.project}/${sha(SPEC)}`)?.contentType === 'application/pdf'
        && !storage.objects.has(`task-files/${s.project}/incoming/${uploadId}`), { put: put.status, spec });
    const reused = await add({ upload_id: uploadId, name: 'spec.pdf' });
    check('upload link: an upload_id is used once', reused.status === 409, reused.status);

    // --- Links to email attachments ----------------------------------------------------------
    const before = objectsIn('task-files').length;
    const shot = await add({ email_attachment_id: ids.shot, note: 'from the email' });
    check('email: an attachment is linked, not copied, with the email it came from',
      shot.status === 201 && shot.body.data?.kind === 'email_attachment' && shot.body.data?.name === 'screenshot.png'
        && shot.body.data?.source?.subject === 'Banner feedback' && shot.body.data?.source?.thread_id === ids.thread
        && objectsIn('task-files').length === before, shot);
    const old = await add({ email_attachment_id: ids.oldShot });
    check('email: an email about to be deleted gives the task its own copy instead',
      old.status === 201 && old.body.data?.kind === 'upload' && storage.objects.has(`task-files/${s.project}/${sha(OLD_SHOT)}`), old);
    const skipped = await add({ email_attachment_id: ids.skipped });
    check('email: an attachment that was never stored cannot be added', skipped.status === 409, skipped);
    const hidden = await add({ email_attachment_id: ids.hidden });
    check('email: an attachment from an inbox the key was not granted reads as missing', hidden.status === 404, hidden);
    const withoutScope = await add({ email_attachment_id: ids.shot }, s.sibling, s.noInbox);
    check('email: a key without inbound_email.read links no attachment', withoutScope.status === 404, withoutScope);
    const doc = await add({ email_attachment_id: ids.doc });
    const docLink = await call(link.GET, 'GET', `${base}/${doc.body.data?.id}/url`, { id: s.task, fileId: doc.body.data?.id });
    check('email: a key opens only the kinds its inbox lets agents read', doc.status === 201 && docLink.status === 403
      && docLink.body.error?.details?.reason === 'not_agent_readable', docLink);
    const shotLink = await call(link.GET, 'GET', `${base}/${shot.body.data?.id}/url?inline=true`, { id: s.task, fileId: shot.body.data?.id });
    check('email: a readable attachment opens inline for five minutes', shotLink.status === 200 && /inbound-email/.test(String(shotLink.body.data?.url))
      && shotLink.body.data?.expires_in === 300, shotLink);

    // --- Links to project files ---------------------------------------------------------------
    const guide = await add({ entity_file_id: s.projectFile });
    check('project file: linked from the task\'s own project', guide.status === 201 && guide.body.data?.kind === 'project_file' && guide.body.data?.name === 'brand-guide.pdf', guide);
    const apex = await add({ entity_file_id: s.otherProjectFile });
    check('project file: never from another project', apex.status === 404, apex);
    const guideLink = await call(link.GET, 'GET', `${base}/${guide.body.data?.id}/url`, { id: s.task, fileId: guide.body.data?.id });
    check('project file: opens at its own address', guideLink.body.data?.url === 'https://files.example.com/brand-guide.pdf', guideLink);

    // --- Reading, scope, changes ------------------------------------------------------------
    const list = await call(files.GET, 'GET', base, { id: s.task });
    const names = (list.body.data as unknown as { name: string }[] | undefined)?.map((file) => file.name);
    check('list: every file on the task, oldest first', list.status === 200
      && names?.join(',') === 'banner.png,page.html,spec.pdf,screenshot.png,old.png,contract.docx,brand-guide.pdf', names);
    const pngLink = await call(link.GET, 'GET', `${base}/${png.body.data?.id}/url`, { id: s.task, fileId: png.body.data?.id });
    check('link: an upload downloads for a minute under its name', pngLink.status === 200 && String(pngLink.body.data?.url).includes(`task-files/${pngPath}`)
      && pngLink.body.data?.expires_in === 60, pngLink);
    const hiddenList = await call(files.GET, 'GET', `/api/v1/tasks/${s.hiddenTask}/files`, { id: s.hiddenTask });
    const hiddenAdd = await add({ content_base64: PNG.toString('base64'), name: 'x.png' }, s.hiddenTask);
    check("scope: no reading or adding to another project's task", hiddenList.status === 403 && hiddenAdd.status === 403, { hiddenList, hiddenAdd });
    const renamed = await call(one.PATCH, 'PATCH', `${base}/${png.body.data?.id}`, { id: s.task, fileId: png.body.data?.id }, { name: 'final banner.png', note: null });
    check('change: rename your own file and clear its note', renamed.status === 200 && renamed.body.data?.name === 'final banner.png' && renamed.body.data?.note === null, renamed);

    await q("UPDATE public.task_files SET added_by = $1 WHERE id = $2", [s.owner, guide.body.data?.id]);
    const notYours = await call(one.DELETE, 'DELETE', `${base}/${guide.body.data?.id}`, { id: s.task, fileId: guide.body.data?.id });
    check("trash: someone else's file needs files.manage", notYours.status === 403, notYours);
    const trashed = await call(one.DELETE, 'DELETE', `${base}/${spec.body.data?.id}`, { id: s.task, fileId: spec.body.data?.id });
    const afterTrash = await call(files.GET, 'GET', base, { id: s.task });
    check('trash: your own file goes to Trash and leaves the list; its bytes stay for a restore',
      trashed.status === 200 && !(afterTrash.body.data as unknown as { id: string }[]).some((file) => file.id === spec.body.data?.id)
        && storage.objects.has(`task-files/${s.project}/${sha(SPEC)}`)
        && (await q<{ deleted_by: string }>('SELECT deleted_by FROM public.task_files WHERE id = $1', [spec.body.data?.id]))[0]?.deleted_by === s.agent, trashed);
    const audit = await q<{ added: string; bytes: string }>(`SELECT count(*) FILTER (WHERE method = 'POST')::text AS added,
      count(*) FILTER (WHERE request_body::text LIKE '%content_base64%')::text AS bytes FROM public.api_audit_log WHERE entity_type = 'task_file'`);
    check('audit: each added file is logged, never with its bytes', Number(audit[0]?.added) > 0 && audit[0]?.bytes === '0', audit);

    // --- Abandoned upload links ---------------------------------------------------------------------
    const abandoned = await call(uploads.POST, 'POST', `${base}/uploads`, { id: s.task });
    const recent = await call(uploads.POST, 'POST', `${base}/uploads`, { id: s.task });
    await fetch(String(abandoned.body.data?.upload_url), { method: 'PUT', body: Buffer.from('never added') });
    await fetch(String(recent.body.data?.upload_url), { method: 'PUT', body: Buffer.from('still being added') });
    const incoming = (id: unknown) => `task-files/${s.project}/incoming/${id}`;
    const dayAndAHalfAgo = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    storage.objects.get(incoming(abandoned.body.data?.upload_id))!.updatedAt = dayAndAHalfAgo;
    storage.objects.get(incoming(recent.body.data?.upload_id))!.updatedAt = new Date().toISOString();
    // A stored file just as old is never a candidate.
    storage.objects.get(`task-files/${pngPath}`)!.updatedAt = dayAndAHalfAgo;
    const { sweepAbandonedUploads } = await import('../src/lib/task-files/retention');
    const { getServiceClient: serviceClient } = await import('../src/lib/api/supabase-service');
    const swept = await sweepAbandonedUploads(serviceClient());
    check('uploads: bytes left at an upload link for over a day are removed; recent ones and stored files stay',
      swept.outcome === 'complete' && swept.uploads_removed === 1 && !storage.objects.has(incoming(abandoned.body.data?.upload_id))
        && storage.objects.has(incoming(recent.body.data?.upload_id)) && storage.objects.has(`task-files/${pngPath}`), swept);

    // --- Retention keeps what tasks link ----------------------------------------------------------
    // The sibling task already has the screenshot's bytes as an upload, and links it too.
    await add({ content_base64: SHOT.toString('base64'), name: 'screenshot copy.png' }, s.sibling);
    const siblingLink = await add({ email_attachment_id: ids.shot }, s.sibling);
    const trashedDoc = await call(one.DELETE, 'DELETE', `${base}/${doc.body.data?.id}`, { id: s.task, fileId: doc.body.data?.id });
    // A second email whose file is gone from Storage: its copy fails, so it waits.
    const lost = { message: '00000000-0000-4000-8000-0000000000a8', attachment: '00000000-0000-4000-8000-0000000000b6' };
    await q(`INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, subject, received_at)
      VALUES ($1, $2, $3, 'handled', 'resend', 'tfa-4', 'tfa-4@example.com', 'Lost file', now() - interval '1 day')`, [lost.message, ids.inbox, ids.thread]);
    await q(`INSERT INTO communications.attachments (id, message_id, position, filename, content_type, storage_path, sha256, size_bytes, uploaded_at)
      VALUES ($1, $2, 0, 'lost.png', 'image/png', $3, $4, 4, now())`, [lost.attachment, lost.message, `${ids.inbox}/${lost.message}/${lost.attachment}`, sha(Buffer.from('lost'))]);
    storage.objects.set(`inbound-email/${ids.inbox}/${lost.message}/${lost.attachment}`, { bytes: Buffer.from('lost'), contentType: 'image/png' });
    const lostLink = await add({ email_attachment_id: lost.attachment });
    storage.objects.delete(`inbound-email/${ids.inbox}/${lost.message}/${lost.attachment}`);
    await q("UPDATE communications.messages SET received_at = now() - interval '100 days' WHERE id IN ($1, $2)", [ids.message, lost.message]);

    const { runRetention } = await import('../src/lib/communications/retention');
    const { getServiceClient: service } = await import('../src/lib/api/supabase-service');
    const run = await runRetention(service(), { budgetMs: 20_000 });
    type Kept = { kind: string; storage_path: string | null; email_attachment_id: string | null; deleted_at: string | null };
    const row = async (id: unknown) => (await q<Kept>('SELECT kind, storage_path, email_attachment_id, deleted_at FROM public.task_files WHERE id = $1', [id]))[0];
    const [keptShot, keptDoc, keptSibling, keptLost] = [await row(shot.body.data?.id), await row(doc.body.data?.id), await row(siblingLink.body.data?.id), await row(lostLink.body.data?.id)];
    check('retention: a linked attachment becomes the task\'s own copy before its email is deleted',
      run.task_files_kept === 3 && keptShot?.kind === 'upload' && keptShot.storage_path === `${s.project}/${sha(SHOT)}` && keptShot.deleted_at === null
        && storage.objects.has(`task-files/${s.project}/${sha(SHOT)}`)
        && (await q('SELECT 1 FROM communications.messages WHERE id = $1', [ids.message])).length === 0, { run, keptShot });
    check('retention: a link in Trash keeps its file for a restore', trashedDoc.status === 200 && keptDoc?.kind === 'upload' && keptDoc.deleted_at !== null, keptDoc);
    check('retention: a task that already has the bytes keeps its upload; the link goes to Trash',
      keptSibling?.kind === 'upload' && keptSibling.deleted_at !== null
        && (await q("SELECT 1 FROM public.task_files WHERE task_id = $1 AND name = 'screenshot copy.png' AND deleted_at IS NULL", [s.sibling])).length === 1, keptSibling);
    check('retention: an email whose file cannot be copied is held back whole, its link untouched',
      run.failed_message_ids.includes(lost.message) && keptLost?.kind === 'email_attachment'
        && (await q('SELECT 1 FROM communications.attachments WHERE id = $1', [lost.attachment])).length === 1, { run, keptLost });
    const afterRetention = await call(files.GET, 'GET', base, { id: s.task });
    const shotAfter = (afterRetention.body.data as unknown as { id: string; kind: string; source: unknown; available: boolean }[]).find((file) => file.id === shot.body.data?.id);
    check('retention: the file reads as the task\'s own afterwards', shotAfter?.kind === 'upload' && shotAfter.source === null && shotAfter.available, shotAfter);

    // --- The app's own reads (session routes use the same service) -------------------------------
    const { listTaskFiles } = await import('../src/lib/task-files/service');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const ownerAccess = (await resolveMemberAccess(getServiceClient(), s.owner))!;
    const appView = await listTaskFiles({ db: getServiceClient(), access: ownerAccess, memberId: s.owner, channel: 'app' }, s.task);
    const appLink = appView.find((file) => file.id === lostLink.body.data?.id);
    check('app: the owner sees the same files, the email behind a link included', appView.length === 6 && appLink?.source?.type === 'email'
      && appLink.source.subject === 'Lost file', appView.map((file) => [file.name, file.source]));

    // What can be added without uploading: the task's email attachments (not body images) and project files.
    await q("INSERT INTO communications.task_links (message_id, task_id, relation) VALUES ($1, $2, 'related')", [lost.message, s.task]);
    await q(`INSERT INTO communications.attachments (message_id, position, filename, content_type, storage_path, sha256, size_bytes, uploaded_at, disposition)
      VALUES ($1, 1, 'logo.png', 'image/png', 'x/y/z', $2, 10, now(), 'inline')`, [lost.message, 'f'.repeat(64)]);
    // The same image again: in a reply quoting it (same conversation, so still
    // one), and in another conversation (a signature logo's pattern: two).
    const reply = '00000000-0000-4000-8000-0000000000a9';
    const elsewhere = { thread: '00000000-0000-4000-8000-0000000000aa', message: '00000000-0000-4000-8000-0000000000ab' };
    await q('INSERT INTO communications.conversations (id, inbox_id) VALUES ($1, $2)', [elsewhere.thread, ids.inbox]);
    await q(`INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id, subject, received_at)
      VALUES ($1, $2, $3, 'handled', 'resend', 'tfa-5', 'tfa-5@example.com', 'Re: Lost file', now()),
             ($4, $2, $5, 'handled', 'resend', 'tfa-6', 'tfa-6@example.com', 'Another topic', now())`, [reply, ids.inbox, ids.thread, elsewhere.message, elsewhere.thread]);
    await q(`INSERT INTO communications.attachments (message_id, position, filename, content_type, storage_path, sha256, size_bytes, uploaded_at, disposition)
      VALUES ($1, 0, 'logo.png', 'image/png', 'x/y/again', $3, 10, now(), 'inline'), ($2, 0, 'logo.png', 'image/png', 'x/y/elsewhere', $3, 10, now(), 'inline')`,
      [reply, elsewhere.message, 'f'.repeat(64)]);
    await q("INSERT INTO communications.task_links (message_id, task_id, relation) VALUES ($1, $3, 'updated'), ($2, $3, 'related')", [reply, elsewhere.message, s.task]);
    const { taskFileCandidates } = await import('../src/lib/task-files/service');
    const candidates = await taskFileCandidates({ db: getServiceClient(), access: ownerAccess, memberId: s.owner, channel: 'app' }, s.task);
    check("candidates: the task's email attachments (pasted images too, each file once, from the email that first sent it, counted by conversation) and project files, marked when already added",
      candidates.email_attachments.map((a) => `${a.name}:${a.added}:${a.subject}:${a.conversation_count}`).join(',') === 'logo.png:false:Lost file:2,lost.png:true:Lost file:1'
        && candidates.project_files.map((f) => `${f.name}:${f.added}`).join(',') === 'brand-guide.pdf:true', candidates);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`task files api: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`task files api: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
