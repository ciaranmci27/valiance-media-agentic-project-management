/**
 * 5. Files: a member uploads a task file through the signed upload the task
 * panel uses and downloads it back; project files are private and open only
 * through /api/storage/file to people who can open the project (a guest of
 * another project gets a 404, never the file); the client portal lists only
 * its project's shared files and its links refresh with fresh signatures.
 */
import { createHash } from 'node:crypto';
import { OWNER_SETUP_SCOPES, check, dataOf, equal, http, makeProject, personalKey, step, tag, waitFor, type Ctx, type Json, type Person } from './harness';
import type { Scenario } from './run';

const sha = (bytes: ArrayBuffer | Buffer) => createHash('sha256').update(Buffer.from(bytes as ArrayBuffer)).digest('hex');

async function download(url: string): Promise<{ status: number; hash: string; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const bytes = await response.arrayBuffer();
  return { status: response.status, hash: sha(bytes), text: Buffer.from(bytes).toString('utf8') };
}

/** Puts an object in the private project files bucket as a person (the browser's own upload), and answers its stored address. */
async function storeProjectFile(ctx: Ctx, person: Person, projectId: string, name: string, content: string): Promise<string> {
  const path = `project/${projectId}/${Date.now()}-${name}`;
  const base = ctx.env.NEXT_PUBLIC_SUPABASE_URL;
  const put = await http(base, `${base}/storage/v1/object/pm-entity-files/${path}`, {
    method: 'POST', raw: content,
    headers: { apikey: ctx.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, authorization: `Bearer ${person.accessToken}`, 'content-type': 'text/plain' },
  });
  check(put.status === 200, `${person.name} uploads ${name} to project files (HTTP ${put.status})`, put.body);
  return `${base}/storage/v1/object/public/pm-entity-files/${path}`;
}

const scenario: Scenario = {
  name: 'Files: task uploads, private project files, guest isolation, portal links',
  async run(ctx: Ctx) {
    const { owner, requester, guest } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, OWNER_SETUP_SCOPES, 'owner setup')).caller;
    const inside = await makeProject(ctx, ownerKey, 'Files internal', [requester.memberId]);
    const shared = await makeProject(ctx, ownerKey, 'Files client', [requester.memberId, guest.memberId]);
    const task = dataOf(await ownerKey.post('/api/v1/tasks', { project_id: inside.id, title: `Brief with files ${tag}` }), 201, 'task on the internal project');
    step(`Owner made an internal project (${requester.name}) and a client project (also ${guest.name}, a guest)`);

    // ── Task file through the signed upload ──
    const content = `E2E task file ${tag} ${Date.now()}`;
    const ticket = dataOf(await requester.post(`/api/workspace/tasks/${task.id}/files/uploads`), 201, 'ask for an upload link');
    check(ticket.upload_url && ticket.upload_id, 'The upload link answer', ticket);
    const put = await fetch(ticket.upload_url, { method: 'PUT', body: content, headers: { 'content-type': 'text/plain' }, signal: AbortSignal.timeout(30_000) });
    check(put.ok, `The signed upload takes the bytes (HTTP ${put.status})`, await put.text());
    const file = dataOf(await requester.post(`/api/workspace/tasks/${task.id}/files`, { upload_id: ticket.upload_id, name: 'brief.txt', mime_type: 'text/plain' }), 201, 'record the task file');
    const listed = dataOf(await requester.get(`/api/workspace/tasks/${task.id}/files`), 200, 'list task files');
    const items = Array.isArray(listed) ? listed : listed.files ?? listed.items ?? [];
    check(items.some((f: Json) => f.id === file.id && f.name === 'brief.txt'), 'The task lists the new file', listed);
    const link = dataOf(await requester.get(`/api/workspace/tasks/${task.id}/files/${file.id}/url`), 200, 'download link');
    const got = await download(link.url ?? link.signed_url ?? link);
    equal(got.status, 200, 'download status');
    equal(got.text, content, 'downloaded task file bytes');
    const again = await requester.post(`/api/workspace/tasks/${task.id}/files/uploads`);
    const ticket2 = dataOf(again, 201, 'second upload link');
    await fetch(ticket2.upload_url, { method: 'PUT', body: content, headers: { 'content-type': 'text/plain' } });
    const dup = await requester.post(`/api/workspace/tasks/${task.id}/files`, { upload_id: ticket2.upload_id, name: 'brief-copy.txt', mime_type: 'text/plain' });
    equal(dup.status, 200, 'the same bytes twice answer the existing file', dup.body);
    equal(dup.body.data?.id, file.id, 'same file id for the same bytes');
    step('Task file: signed upload, recorded, listed, downloaded byte for byte; the same bytes again reuse it');

    // ── Private project files through /api/storage/file ──
    const internalText = `E2E internal plan ${tag}`;
    const clientText = `E2E client deliverable ${tag}`;
    const internalUrl = await storeProjectFile(ctx, owner, inside.id, 'plan.txt', internalText);
    const clientUrl = await storeProjectFile(ctx, owner, shared.id, 'deliverable.txt', clientText);
    const internalRow = dataOf(await ownerKey.post('/api/v1/entity-files', { entity_type: 'project', entity_id: inside.id, name: 'plan.txt', file_url: internalUrl, file_size: internalText.length, mime_type: 'text/plain' }), 201, 'record the internal file');
    const clientRow = dataOf(await ownerKey.post('/api/v1/entity-files', { entity_type: 'project', entity_id: shared.id, name: 'deliverable.txt', file_url: clientUrl, file_size: clientText.length, mime_type: 'text/plain', visibility: 'external' }), 201, 'record the client file');
    const direct = await download(internalUrl);
    check(direct.status >= 400, 'The bucket is private: the stored address alone opens nothing', direct);

    const open = (person: Person, url: string) => person.call(`/api/storage/file?u=${encodeURIComponent(url)}`);
    const viaApp = await open(requester, internalUrl);
    equal(viaApp.status, 302, 'a project member opens the file through the app');
    equal((await download(viaApp.headers.get('location')!)).text, internalText, 'file through the app');
    const guestOther = await open(guest, internalUrl);
    equal(guestOther.status, 404, 'a guest of another project gets a 404 for this project\'s file', guestOther.body);
    const guestOwn = await open(guest, clientUrl);
    equal(guestOwn.status, 302, 'the guest opens their own project\'s file');
    equal((await download(guestOwn.headers.get('location')!)).text, clientText, 'guest file through the app');
    const anonymous = await http(ctx.baseUrl, `/api/storage/file?u=${encodeURIComponent(internalUrl)}`);
    equal(anonymous.status, 401, 'no session, no file');
    step('Project files are private: members open them through /api/storage/file (302), a guest of another project gets 404, no session 401');

    const guestTaskFiles = await guest.get(`/api/workspace/tasks/${task.id}/files`);
    equal(guestTaskFiles.status, 404, 'the guest cannot list another project\'s task files');
    const guestEntity = await guest.rest(`entity_files?select=id&entity_id=eq.${inside.id}`);
    check(guestEntity.status === 200 && guestEntity.body.length === 0, 'The guest reads no file rows of the other project', guestEntity.body);
    step('The guest cannot list the other project\'s task files (404) or its file rows (none)');

    // ── Portal ──
    const portal = dataOf(await ownerKey.put(`/api/v1/projects/${shared.id}/portal`, { enabled: true, show_files: true }), [200, 201], 'turn on the client portal');
    const token = portal.token;
    check(token, 'The portal has a link token', portal);
    ctx.cleanup.add(`turn off portal ${shared.id}`, () => ownerKey.put(`/api/v1/projects/${shared.id}/portal`, { enabled: false }));
    const first = await http(ctx.baseUrl, `/api/portal/${token}/links`);
    equal(first.status, 200, 'portal links', first.body);
    const links = first.body.data ?? first.body;
    check(links.files?.[clientRow.id], 'The portal links the shared file', links);
    check(!links.files?.[internalRow.id], 'The portal never links another project\'s file', links);
    equal((await download(links.files[clientRow.id])).text, clientText, 'file through the portal link');
    const expiry = (url: string) => {
      const jwt = new URL(url).searchParams.get('token') ?? '';
      return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')).exp as number;
    };
    const firstExp = expiry(links.files[clientRow.id]);
    check(firstExp - Date.now() / 1000 > 3000, 'A portal link is signed for about an hour', { exp: firstExp });
    // The page refreshes before links expire: each call re-signs (the signature clock ticks in whole seconds).
    const refreshed: string = await waitFor('a re-signed portal link', async () => {
      const again = await http(ctx.baseUrl, `/api/portal/${token}/links`);
      const url = (again.body.data ?? again.body).files?.[clientRow.id];
      return url && expiry(url) > firstExp ? url : null;
    }, 5_000, 300);
    equal((await download(refreshed)).text, clientText, 'file through the refreshed link');
    const wrongFile = await http(ctx.baseUrl, `/api/portal/${token}/file/${internalRow.id}`);
    equal(wrongFile.status, 404, 'the portal refuses another project\'s file id');
    const unknown = await http(ctx.baseUrl, `/api/portal/e2e-no-such-portal-${tag}/links`);
    equal(unknown.status, 404, 'an unknown portal');
    step('Portal: lists only the shared file, links work, refresh re-signs them later; other project ids and unknown portals 404');
  },
};

export default scenario;
