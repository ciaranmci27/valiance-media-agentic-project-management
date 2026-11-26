/**
 * The inbox over MCP (list_inbox through get_inbox_signal), on the full
 * schema behind fake-postgrest, through the real /api/mcp route and the real
 * v1 inbox routes:
 * - every tool round-trips against seeded inbox email (two agents, three
 *   inboxes, one on plans), and the reads answer exactly what REST answers
 *   for the same call (get_email and the triage context through their
 *   bounding, which a short email passes but for the html_text it repeats);
 * - per-inbox access: a key reads and writes only its member's inboxes; a
 *   read (list, email, context) and a write (triage, task, draft) against
 *   another agent's inbox are refused, and mark_triage_summarized marks
 *   nothing outside them;
 * - visibility: no inbox tools without the scopes, with the Inbox module off,
 *   or as writes on a read-only key; create_task_from_email needs both
 *   tasks.create and inbound_email.triage;
 * - REST answers the same before and after the MCP calls;
 * - idempotency: create_task_from_email and add_sender_rule replay through
 *   the Idempotency-Key store, record_email_triage and submit_triage_plan
 *   through their own body key, and a retry makes nothing twice;
 * - a long thread stays readable over MCP (cut and flagged) while REST keeps it all;
 * - pm_guide's inbox section shows only for inbox keys, under the MCP cap;
 *   the context pack has the triage convention, and the inbox-triage
 *   template's scopes open the triage loop.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-inbox-mcp.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { FakeStorage } from './inbound-email-fixtures';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Handler = (request: NextRequest, context: never) => Promise<Response>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), scout: id(2), rex: id(3),
  acme: id(10), birch: id(11), cedar: id(12), dune: id(13), elm: id(14),
  inboxA: id(20), inboxP: id(21), inboxB: id(22),
  c1: id(30), c2: id(31), c3: id(32), cB: id(33), cLong: id(34), cBusy: id(35), cHtml: id(36),
  m1: id(40), m2: id(41), m3: id(42), mB: id(43), mBusy: id(44), mHtml: id(45), mHtmlReply: id(46),
  attachment: id(50), draft: id(60), draftB: id(61), busyPlan: id(70),
};
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const LONG_MESSAGES = 12;

const READ_SCOPES = ['inbound_email.read', 'tasks.read', 'projects.read'];
const FULL_SCOPES = [...READ_SCOPES, 'inbound_email.triage', 'inbound_email.signal', 'tasks.create'];

async function main() {
  const db = await createFullSchemaDatabase();
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.exec(`
    INSERT INTO pm.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Morgan Lee', 'owner@agency.example', 'owner'),
      ('${ids.scout}', 'Scout', 'scout-bot@agency.example', 'agent'),
      ('${ids.rex}', 'Rex', 'rex-bot@agency.example', 'agent');
    INSERT INTO pm.projects (id, name, status) VALUES ('${ids.acme}', 'Acme', 'active'), ('${ids.birch}', 'Birch', 'active'), ('${ids.cedar}', 'Cedar', 'active'),
      ('${ids.dune}', 'Dune', 'active'), ('${ids.elm}', 'Elm', 'active');
    INSERT INTO pm.project_members (project_id, member_id) VALUES ('${ids.acme}', '${ids.scout}'), ('${ids.birch}', '${ids.rex}');
    -- On the older triage by name: a new inbox defaults to plans (20261125001200).
    INSERT INTO pm.inboxes (id, name, address, handler_member_id, triage_mode) VALUES
      ('${ids.inboxA}', 'Scout', 'scout@agency.example', '${ids.scout}', 'legacy'),
      ('${ids.inboxB}', 'Rex', 'rex@agency.example', '${ids.rex}', 'legacy');
    INSERT INTO pm.inboxes (id, name, address, handler_member_id, triage_mode) VALUES
      ('${ids.inboxP}', 'Scout plans', 'scout-plans@agency.example', '${ids.scout}', 'plans');
    INSERT INTO pm.inbox_access (inbox_id, member_id) VALUES
      ('${ids.inboxA}', '${ids.scout}'), ('${ids.inboxP}', '${ids.scout}'), ('${ids.inboxB}', '${ids.rex}') ON CONFLICT DO NOTHING;
  `);
  const email = async (conversation: string, message: string, inbox: string, project: string, subject: string, body: string, options: { receivedAt?: string; seed?: boolean } = {}) => {
    if (options.seed !== false) {
      await q(`INSERT INTO pm.conversations (id, inbox_id, subject_normalized, channel, project_id, project_source, last_message_at)
        VALUES ($1, $2, $3, 'email', $4, 'mapped', now() - interval '1 hour')`, [conversation, inbox, subject.toLowerCase(), project]);
      await q("INSERT INTO pm.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'mapped')", [conversation, project]);
    }
    await q(`INSERT INTO pm.messages (id, inbox_id, thread_id, channel, status, provider, provider_email_id, internet_message_id,
        received_at, subject, kind, auth, text_body, html_body, new_text)
      VALUES ($1, $2, $3, 'email', 'new', 'test', $4, $4, $5, $6, 'person', '{"trust":"trusted"}', $7, $8, $7)`,
    [message, inbox, conversation, `m-${message}`, options.receivedAt ?? new Date(Date.now() - 3_600_000).toISOString(), subject, body, `<p>${body}</p>`]);
    await q("INSERT INTO pm.participants (message_id, kind, address, name, position) VALUES ($1, 'from', 'dana@acme.example', 'Dana Wu', 0)", [message]);
  };
  await email(ids.c1, ids.m1, ids.inboxA, ids.acme, 'Logo files', 'Here are the logo files. Can you swap the header logo?');
  await email(ids.c2, ids.m2, ids.inboxA, ids.acme, 'New landing page', 'Please build a landing page for the spring sale.');
  await email(ids.c3, ids.m3, ids.inboxP, ids.acme, 'Kickoff notes', 'Notes from the kickoff: Acme wants weekly updates.');
  await email(ids.cB, ids.mB, ids.inboxB, ids.birch, 'Birch invoice', 'The Birch invoice is attached.');
  // A long conversation: twelve emails of 20,000 characters each.
  for (let i = 0; i < LONG_MESSAGES; i++) {
    await email(ids.cLong, id(100 + i), ids.inboxA, ids.acme, 'Long thread', `${i}:${'w'.repeat(20_000)}`,
      { seed: i === 0, receivedAt: new Date(Date.now() - 86_400_000 + i * 60_000).toISOString() });
  }
  await q(`UPDATE pm.messages SET status = 'handled' WHERE thread_id = $1`, [ids.cLong]);
  // An email scoped to three busy projects: 40 open tasks each, 15 open subtasks under each, 20 recent plan items.
  await email(ids.cBusy, ids.mBusy, ids.inboxA, ids.cedar, 'Status for everyone', 'Where are we on all three accounts?');
  await q(`INSERT INTO pm.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'mapped'), ($1, $3, 'mapped')`, [ids.cBusy, ids.dune, ids.elm]);
  await q(`INSERT INTO pm.plans (id, message_id, conversation_id, member_id, mode, status, summary) VALUES ($1, $2, $3, $4, 'live', 'applied', 'Earlier plan')`,
    [ids.busyPlan, ids.m2, ids.c2, ids.scout]);
  for (const project of [ids.cedar, ids.dune, ids.elm]) {
    await q(`INSERT INTO pm.tasks (project_id, title, status, priority)
      SELECT $1, 'Open task ' || n || ': ' || repeat('a long and descriptive task title ', 4), 'todo', 'medium' FROM generate_series(1, 40) AS n`, [project]);
    await q(`INSERT INTO pm.tasks (project_id, parent_task_id, title, status)
      SELECT $1, t.id, 'Subtask ' || n || ' of ' || left(t.title, 20) || repeat(' with detail', 3), 'todo'
      FROM pm.tasks t CROSS JOIN generate_series(1, 15) AS n WHERE t.project_id = $1 AND t.parent_task_id IS NULL AND t.title LIKE 'Open task %'`, [project]);
    await q(`INSERT INTO pm.plan_items (plan_id, position, conversation_id, mode, type, intent, project_id, payload, decision, state)
      SELECT $1, n + (CASE WHEN $2::uuid = '${ids.cedar}' THEN 0 WHEN $2::uuid = '${ids.dune}' THEN 100 ELSE 200 END), $3, 'live', 'add_reminder', 'waiting_on', $2::uuid,
        jsonb_build_object('type', 'add_reminder', 'title', 'Chase item ' || n || repeat(' and its follow-up', 4)), 'apply', 'done'
      FROM generate_series(1, 20) AS n`, [ids.busyPlan, project, ids.c2]);
  }
  // An HTML-only email (its text part is a bare newline), and a reply whose own words are blank.
  await email(ids.cHtml, ids.mHtml, ids.inboxA, ids.acme, 'Newsletter', 'unused', { receivedAt: new Date(Date.now() - 7_200_000).toISOString() });
  await q(`UPDATE pm.messages SET text_body = E'\n', new_text = NULL, html_body = '<p>Only the HTML part has words.</p>', status = 'handled' WHERE id = $1`, [ids.mHtml]);
  await email(ids.cHtml, ids.mHtmlReply, ids.inboxA, ids.acme, 'Re: Newsletter', 'The reply text is here.', { seed: false });
  await q(`UPDATE pm.messages SET new_text = E' \n', status = 'handled' WHERE id = $1`, [ids.mHtmlReply]);
  await q(`INSERT INTO pm.attachments (id, message_id, position, filename, content_type, size_bytes, sha256, storage_path, uploaded_at)
    VALUES ($1, $2, 0, 'logo.pdf', 'application/pdf', 1200, repeat('a', 64), $3, now())`, [ids.attachment, ids.m1, `${ids.inboxA}/${ids.m1}/logo.pdf`]);
  await q(`INSERT INTO pm.reply_drafts (id, thread_id, message_id, instructions, requested_by, status) VALUES
    ($1, $2, $3, 'Say we will swap it today', $4, 'requested'), ($5, $6, $7, 'Thank them', $4, 'requested')`,
  [ids.draft, ids.c1, ids.m1, ids.owner, ids.draftB, ids.cB, ids.mB]);

  const key = async (memberId: string, scopes: string[], permissions: 'scoped' | 'read_only' = 'scoped') => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, $4)`, [hash(secret), memberId, scopes, permissions]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    scout: await key(ids.scout, FULL_SCOPES),
    rex: await key(ids.rex, FULL_SCOPES),
    noEmail: await key(ids.scout, ['tasks.read', 'tasks.create', 'projects.read']),
    readOnlyEmail: await key(ids.scout, READ_SCOPES),
    noTaskCreate: await key(ids.scout, [...READ_SCOPES, 'inbound_email.triage']),
    readOnly: await key(ids.scout, FULL_SCOPES, 'read_only'),
  };

  const storage = new FakeStorage();
  const server = await startFakePostgrest(db, { handle: storage.handler });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key' });

  try {
    const mcpRoute = await import('../src/app/api/mcp/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { INBOX_TOOLS, PM_GUIDE, PM_INBOX_GUIDE } = await import('../src/lib/mcp/guide');
    const { toolsFor } = await import('../src/lib/mcp/visibility');
    const { findAgentTemplate } = await import('../src/lib/agent-templates');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const { INBOUND_EMAIL_BUCKET } = await import('../src/lib/communications/email/storage-limits');
    storage.objects.set(`${INBOUND_EMAIL_BUCKET}/${ids.inboxA}/${ids.m1}/logo.pdf`, { bytes: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });
    const rest = {
      list: await import('../src/app/api/v1/inbox/messages/route'),
      oldList: await import('../src/app/api/v1/inbound-emails/route'),
      detail: await import('../src/app/api/v1/inbox/messages/[id]/route'),
      context: await import('../src/app/api/v1/inbox/messages/[id]/context/route'),
      attachmentUrl: await import('../src/app/api/v1/inbox/messages/[id]/attachments/[aid]/url/route'),
      queue: await import('../src/app/api/v1/inbox/queue/route'),
      questions: await import('../src/app/api/v1/inbox/questions/route'),
      drafts: await import('../src/app/api/v1/inbox/reply-drafts/route'),
      rules: await import('../src/app/api/v1/inbox/sender-rules/route'),
      senders: await import('../src/app/api/v1/inbox/senders/route'),
      unsummarized: await import('../src/app/api/v1/inbox/triage/unsummarized/route'),
      signal: await import('../src/app/api/v1/inbox/signal/route'),
      triage: await import('../src/app/api/v1/inbox/messages/[id]/triage/route'),
      tasks: await import('../src/app/api/v1/inbox/messages/[id]/tasks/route'),
    };
    const restCall = async (handler: unknown, method: string, path: string, apiKey: string, params: Record<string, string> = {}, body?: unknown) => {
      const response = await (handler as Handler)(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() as Loose };
    };

    const rpc = async (apiKey: string, body: unknown) => {
      const response = await mcpRoute.POST(new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify(body),
      }));
      const text = await response.text();
      return JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? text) as Loose;
    };
    const listTools = async (apiKey: string): Promise<string[]> =>
      ((await rpc(apiKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result?.tools ?? []).map((t: Loose) => t.name);
    const tool = async (apiKey: string, name: string, args: Record<string, unknown> = {}) => {
      const answer = await rpc(apiKey, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
      return { ...(answer.result?.structuredContent ?? {}), isError: answer.result?.isError === true } as Loose;
    };
    const same = (label: string, mcp: Loose, restAnswer: { status: number; body: Loose }, transform: (data: Loose) => Loose = (data) => data) => {
      check(label, mcp.ok === true && restAnswer.status === 200 && isDeepStrictEqual(mcp.data, transform(restAnswer.body.data))
        && isDeepStrictEqual(mcp.meta, restAnswer.body.meta), { mcp: mcp.error ?? mcp.data, rest: restAnswer.body });
    };

    // ---- The catalog ------------------------------------------------------------------------
    const inboxTools = PM_TOOLS.filter((t) => t.routes.some((route) => route.path.startsWith('/api/v1/inbox/')));
    check('catalog: INBOX_TOOLS (the guide section switch) lists exactly the tools on /api/v1/inbox',
      isDeepStrictEqual([...INBOX_TOOLS].sort(), inboxTools.map((t) => t.name).sort()), { listed: INBOX_TOOLS, tools: inboxTools.map((t) => t.name) });
    check('catalog: every inbox tool needs an inbox permission', inboxTools.every((t) =>
      [...(Array.isArray(t.permission) ? t.permission : [t.permission]), ...(t.requires ?? [])].some((p) => p.startsWith('inbound_email.'))));
    const createsWithKey = ['create_task_from_email', 'add_sender_rule', 'record_email_triage', 'submit_triage_plan'];
    check('catalog: create-type inbox tools take idempotency_key', createsWithKey.every((name) => 'idempotency_key' in (PM_TOOLS.find((t) => t.name === name)?.input.shape ?? {})));

    // ---- Who sees the inbox tools -------------------------------------------------------------
    const scoutTools = await listTools(keys.scout);
    const deprecatedInbox = INBOX_TOOLS.filter((name) => PM_TOOLS.find((t) => t.name === name)?.deprecated);
    check('catalog: the older triage and its summary are the deprecated inbox tools',
      isDeepStrictEqual([...deprecatedInbox].sort(), ['list_unsummarized_triage', 'mark_triage_summarized', 'record_email_triage']), deprecatedInbox);
    check('visible: a triage key sees every inbox tool but the deprecated ones', INBOX_TOOLS.every((name) => scoutTools.includes(name) !== deprecatedInbox.includes(name)),
      INBOX_TOOLS.filter((name) => scoutTools.includes(name) === deprecatedInbox.includes(name)));
    const noEmailTools = await listTools(keys.noEmail);
    check('hidden: a key without inbox scopes sees none', noEmailTools.length > 3 && !noEmailTools.some((name) => INBOX_TOOLS.includes(name)), noEmailTools);
    const readTools = await listTools(keys.readOnlyEmail);
    check('hidden: without inbound_email.triage, the reads only', readTools.includes('list_inbox') && readTools.includes('get_email')
      && !['record_email_triage', 'submit_triage_plan', 'write_reply_draft', 'create_task_from_email', 'add_sender_rule', 'get_inbox_signal'].some((name) => readTools.includes(name)), readTools);
    const noCreateTools = await listTools(keys.noTaskCreate);
    check('hidden: create_task_from_email needs tasks.create as well as triage', noCreateTools.includes('submit_triage_plan') && !noCreateTools.includes('create_task_from_email'), noCreateTools);
    const readOnlyTools = await listTools(keys.readOnly);
    check('hidden: a read-only key sees no inbox write', readOnlyTools.includes('list_inbox')
      && !readOnlyTools.some((name) => PM_TOOLS.find((t) => t.name === name)?.write), readOnlyTools);
    await q("UPDATE pm.team_member_permissions SET effect = 'deny' WHERE member_id = $1 AND permission_key = 'inbound_email.triage' AND access_channel = 'api'", [ids.scout]);
    const deniedTools = await listTools(keys.scout);
    check('hidden: the member losing triage hides the triage tools', deniedTools.includes('list_inbox') && !deniedTools.includes('submit_triage_plan'), deniedTools);
    await q("UPDATE pm.team_member_permissions SET effect = 'allow' WHERE member_id = $1 AND effect = 'deny'", [ids.scout]);
    await q("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'inbox'");
    const offTools = await listTools(keys.scout);
    const offCall = await tool(keys.scout, 'list_inbox');
    check('hidden: with the Inbox module off, no inbox tool is listed or callable', offTools.length > 3 && !offTools.some((name) => INBOX_TOOLS.includes(name))
      && offCall.ok === false && offCall.status === 404 && offCall.error?.reason === 'unknown_tool', { offTools, offCall });
    const offGuide = await tool(keys.scout, 'pm_guide');
    check('guide: no inbox section while the Inbox is off', offGuide.ok === true && !offGuide.guide.includes('Inbox triage'));
    await q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'inbox'");

    // ---- Reads: the same answer as REST ----------------------------------------------------------
    const restListBefore = await restCall(rest.list.GET, 'GET', '/api/v1/inbox/messages?status=new', keys.scout);
    const listed = await tool(keys.scout, 'list_inbox', { status: 'new' });
    same('list_inbox: the same rows and meta as REST', listed, restListBefore);
    const listedIds = (listed.data ?? []).map((row: Loose) => row.id);
    check('list_inbox: its own inboxes only, never Rex\'s', listedIds.includes(ids.m1) && listedIds.includes(ids.m3) && !listedIds.includes(ids.mB), listedIds);
    const oldPath = await restCall(rest.oldList.GET, 'GET', '/api/v1/inbound-emails?status=new', keys.scout);
    check('REST: the older inbound-emails path answers the same', isDeepStrictEqual(oldPath.body, restListBefore.body));
    const otherInbox = await tool(keys.scout, 'list_inbox', { inbox_id: ids.inboxB });
    check('access: listing another agent\'s inbox is refused (403 inbox_scope), as a result', otherInbox.ok === false && otherInbox.status === 403
      && otherInbox.error?.reason === 'inbox_scope' && !otherInbox.isError, otherInbox);
    const rexList = await tool(keys.rex, 'list_inbox');
    check('access: Rex reads only his inbox', (rexList.data ?? []).length === 1 && rexList.data[0].id === ids.mB, rexList);

    const restDetail = await restCall(rest.detail.GET, 'GET', `/api/v1/inbox/messages/${ids.m1}`, keys.scout, { id: ids.m1 });
    const detail = await tool(keys.scout, 'get_email', { message_id: ids.m1 });
    const withoutRepeats = (data: Loose) => {
      const strip = (m: Loose, inThread: boolean) => {
        const out = { ...m, html_text: null, html_text_omitted: true };
        return inThread ? { ...out, text: null, text_omitted: true } : out;
      };
      return { ...strip(data, false), thread: { ...data.thread, messages: data.thread.messages.map((m: Loose) => strip(m, true)) } };
    };
    same('get_email: REST\'s answer, less the html_text and thread text it repeats', detail, restDetail, withoutRepeats);
    check('get_email: the words, attachments and project scope', detail.data?.text?.startsWith('Here are the logo files') && detail.data?.new_text?.startsWith('Here are')
      && detail.data?.attachments?.[0]?.id === ids.attachment && detail.data?.attachments?.[0]?.agent_readable === true && !!detail.data?.project_scope, detail.data);
    const otherEmail = await tool(keys.scout, 'get_email', { message_id: ids.mB });
    check('access: another inbox\'s email is 404, as if it did not exist', otherEmail.ok === false && otherEmail.status === 404 && !otherEmail.isError, otherEmail);
    const badId = await tool(keys.scout, 'get_email', { message_id: 'not-a-uuid' });
    check('args: a bad id is refused before any route', badId.ok === false && badId.status === 422 && badId.error?.reason === 'invalid_arguments', badId);

    const restContext = await restCall(rest.context.GET, 'GET', `/api/v1/inbox/messages/${ids.m1}/context`, keys.scout, { id: ids.m1 });
    const context = await tool(keys.scout, 'get_email_triage_context', { message_id: ids.m1 });
    same('get_email_triage_context: REST\'s bundle, its email bounded as in get_email', context, restContext, (data) => ({ ...data, message: withoutRepeats(data.message) }));
    check('get_email_triage_context: the project in scope with its open tasks', context.data?.projects?.some((p: Loose) => p.id === ids.acme) && !!context.data?.speaker, context.data?.projects);
    const otherContext = await tool(keys.scout, 'get_email_triage_context', { message_id: ids.mB });
    check('access: another inbox\'s triage context is 404', otherContext.ok === false && otherContext.status === 404, otherContext);

    const restLink = await restCall(rest.attachmentUrl.GET, 'GET', `/api/v1/inbox/messages/${ids.m1}/attachments/${ids.attachment}/url`, keys.scout, { id: ids.m1, aid: ids.attachment });
    const link = await tool(keys.scout, 'get_email_attachment_link', { message_id: ids.m1, attachment_id: ids.attachment });
    const unsigned = (data: Loose) => ({ ...data, url: undefined, expires_at: undefined });
    check('get_email_attachment_link: a signed link, the same file facts as REST', link.ok === true && /signed-/.test(link.data?.url ?? '') && restLink.status === 200
      && isDeepStrictEqual(unsigned(link.data), unsigned(restLink.body.data)), { link, restLink: restLink.body });

    const restQueue = await restCall(rest.queue.GET, 'GET', '/api/v1/inbox/queue?mode=plans', keys.scout);
    const queue = await tool(keys.scout, 'get_triage_queue', { mode: 'plans' });
    same('get_triage_queue: the same queue as REST', queue, restQueue);
    check('get_triage_queue: the plan inbox\'s quiet email is next', queue.data?.messages?.some((m: Loose) => m.id === ids.m3) && !queue.data.messages.some((m: Loose) => m.id === ids.m1), queue.data);

    const restDrafts = await restCall(rest.drafts.GET, 'GET', '/api/v1/inbox/reply-drafts', keys.scout);
    const drafts = await tool(keys.scout, 'list_reply_drafts');
    same('list_reply_drafts: the same requests as REST', drafts, restDrafts);
    check('list_reply_drafts: its own inbox\'s request only', (drafts.data ?? []).length === 1 && drafts.data[0].id === ids.draft, drafts.data);
    same('list_sender_rules: the same as REST', await tool(keys.scout, 'list_sender_rules'), await restCall(rest.rules.GET, 'GET', '/api/v1/inbox/sender-rules', keys.scout));
    same('list_inbox_senders: the same as REST', await tool(keys.scout, 'list_inbox_senders', { days: 30 }), await restCall(rest.senders.GET, 'GET', '/api/v1/inbox/senders?days=30', keys.scout));
    same('get_inbox_signal: the same counts as REST', await tool(keys.scout, 'get_inbox_signal'), await restCall(rest.signal.GET, 'GET', '/api/v1/inbox/signal', keys.scout));

    // ---- Writes ------------------------------------------------------------------------------------
    const foreignTriage = await tool(keys.scout, 'record_email_triage', { message_id: ids.mB, outcome: 'no_action', urgent: false, summary: 'Not mine' });
    check('access: triaging another inbox\'s email is 404 and records nothing', foreignTriage.ok === false && foreignTriage.status === 404
      && (await q('SELECT 1 FROM pm.triage WHERE message_id = $1', [ids.mB])).length === 0, foreignTriage);
    const foreignDraft = await tool(keys.scout, 'write_reply_draft', { draft_id: ids.draftB, body: 'Thanks!' });
    check('access: writing another inbox\'s draft is 404 and changes nothing', foreignDraft.ok === false && foreignDraft.status === 404
      && (await q('SELECT status FROM pm.reply_drafts WHERE id = $1', [ids.draftB]))[0].status === 'requested', foreignDraft);
    const foreignTask = await tool(keys.scout, 'create_task_from_email', { message_id: ids.mB, project_id: ids.acme, title: 'Pay Birch', idempotency_key: randomUUID() });
    check('access: a task from another inbox\'s email is 404 and makes no task', foreignTask.ok === false && foreignTask.status === 404
      && (await q("SELECT 1 FROM pm.tasks WHERE title = 'Pay Birch'")).length === 0, foreignTask);

    const triageKey = `triage-${randomUUID()}`;
    const triageArgs = {
      message_id: ids.m1, outcome: 'needs_human', urgent: false, summary: 'Dana sent new logo files and asks to swap the header logo.',
      question_for_human: 'Swap the header logo now, or after the launch?', project_ids: [ids.acme],
      questions: [{ question: 'When should the logo change?', options: [{ label: 'Now' }, { label: 'After launch' }], recommended: 0 }],
      idempotency_key: triageKey,
    };
    const triaged = await tool(keys.scout, 'record_email_triage', triageArgs);
    check('record_email_triage: recorded, waiting on a person', triaged.ok === true && triaged.data?.status === 'needs_human' && triaged.data?.replayed === false, triaged);
    check('deprecated: record_email_triage is off tools/list yet still answers by name', !scoutTools.includes('record_email_triage') && triaged.ok === true, scoutTools);
    const triageAgain = await tool(keys.scout, 'record_email_triage', triageArgs);
    const restTriageAgain = await restCall(rest.triage.POST, 'POST', `/api/v1/inbox/messages/${ids.m1}/triage`, keys.scout, { id: ids.m1 },
      { ...triageArgs, message_id: undefined });
    check('record_email_triage: the same key replays the first triage, over MCP and REST alike', triageAgain.ok === true && triageAgain.data?.replayed === true
      && triageAgain.data?.triage?.id === triaged.data?.triage?.id && restTriageAgain.status === 200 && restTriageAgain.body.data?.triage?.id === triaged.data?.triage?.id
      && (await q('SELECT 1 FROM pm.triage WHERE message_id = $1', [ids.m1])).length === 1, { triageAgain, rest: restTriageAgain.body });
    const triageConflict = await tool(keys.scout, 'record_email_triage', { ...triageArgs, summary: 'Something else entirely.' });
    check('record_email_triage: the same key with another body is 409', triageConflict.ok === false && triageConflict.status === 409, triageConflict);
    const badOutreach = await tool(keys.scout, 'record_email_triage', { message_id: ids.m2, outcome: 'task', urgent: false, summary: 'A pitch', category: 'outreach' });
    check('record_email_triage: the route\'s own rules still apply (outreach is no_action)', badOutreach.ok === false && badOutreach.status === 422
      && JSON.stringify(badOutreach.error).includes('no_action'), badOutreach);

    same('list_inbox_questions: the same as REST, with the question asked', await tool(keys.scout, 'list_inbox_questions'),
      await restCall(rest.questions.GET, 'GET', '/api/v1/inbox/questions', keys.scout));
    const questions = await tool(keys.scout, 'list_inbox_questions');
    check('list_inbox_questions: the waiting question is there', JSON.stringify(questions.data ?? []).includes('Swap the header logo now'), questions.data);

    const planKey = `plan-${randomUUID()}`;
    const planArgs = {
      message_id: ids.m3, summary: 'Kickoff notes from Acme: weekly updates wanted.',
      items: [{ type: 'add_context', intent: 'context', project_id: ids.acme, category: 'business_context', content: 'Acme wants weekly updates.', evidence: 'Acme wants weekly updates.' }],
      idempotency_key: planKey,
    };
    const planned = await tool(keys.scout, 'submit_triage_plan', planArgs);
    check('submit_triage_plan: a live plan in the plans inbox, its item decided', planned.ok === true && planned.data?.plan?.mode === 'live'
      && planned.data?.items?.length === 1 && !!planned.data.items[0].decision, planned);
    const planAgain = await tool(keys.scout, 'submit_triage_plan', planArgs);
    check('submit_triage_plan: the same key replays, one plan stored', planAgain.ok === true && planAgain.data?.replayed === true && planAgain.data?.plan?.id === planned.data?.plan?.id
      && (await q('SELECT 1 FROM pm.plans WHERE message_id = $1', [ids.m3])).length === 1, planAgain);
    const badPlan = await tool(keys.scout, 'submit_triage_plan', { message_id: ids.m3, summary: 'Two asks', items: [
      { type: 'ask', intent: 'context', question: 'Which project?' }, { type: 'ask', intent: 'context', question: 'Which person?' }] });
    check('submit_triage_plan: the route\'s validation still applies (one question at most)', badPlan.ok === false && badPlan.status === 422, badPlan);

    const taskKey = randomUUID();
    const taskArgs = { message_id: ids.m2, project_id: ids.acme, title: 'Build the spring sale landing page', source_note: "from Dana's email", idempotency_key: taskKey };
    const made = await tool(keys.scout, 'create_task_from_email', taskArgs);
    check('create_task_from_email: the task, linked to the email as created', made.ok === true && made.data?.email_link?.relation === 'created'
      && made.data?.project_id === ids.acme, made);
    const madeAgain = await tool(keys.scout, 'create_task_from_email', taskArgs);
    check('create_task_from_email: the same idempotency_key replays, one task made', madeAgain.ok === true && madeAgain.data?.id === made.data?.id
      && (await q("SELECT 1 FROM pm.tasks WHERE title = 'Build the spring sale landing page'")).length === 1, madeAgain);
    const outOfScope = await tool(keys.scout, 'create_task_from_email', { message_id: ids.m2, project_id: ids.birch, title: 'Wrong project' });
    check('create_task_from_email: a project outside the email\'s scope is refused, nothing made', outOfScope.ok === false && [403, 422].includes(outOfScope.status)
      && (await q("SELECT 1 FROM pm.tasks WHERE title = 'Wrong project'")).length === 0, outOfScope);

    // The agent's rules apply: an approval policy makes a suggestion, links nothing.
    const linksOf = async (message: string) => (await q('SELECT task_id FROM pm.task_links WHERE message_id = $1', [message])).length;
    const m1Links = await linksOf(ids.m1);
    await q("UPDATE pm.team_members SET agent_create_policy = 'approval' WHERE id = $1", [ids.scout]);
    const approvalRest = await restCall(rest.tasks.POST, 'POST', `/api/v1/inbox/messages/${ids.m1}/tasks`, keys.scout, { id: ids.m1 }, { project_id: ids.acme, title: 'Swap the header logo' });
    check('approval: an approval-policy agent gets a suggestion (202) holding the email, no task and no link', approvalRest.status === 202
      && approvalRest.body.data?.needs_approval === true && approvalRest.body.data?.metadata?.message_id === ids.m1 && !approvalRest.body.data?.email_link
      && (await q("SELECT 1 FROM pm.tasks WHERE title = 'Swap the header logo'")).length === 0
      && (await q("SELECT 1 FROM pm.task_suggestions WHERE title = 'Swap the header logo' AND status = 'pending'")).length === 1
      && await linksOf(ids.m1) === m1Links, approvalRest.body);
    const approvalMcp = await tool(keys.scout, 'create_task_from_email', { message_id: ids.m1, project_id: ids.acme, title: 'Swap the footer logo', idempotency_key: randomUUID() });
    check('approval: over MCP too, a suggestion and no task', approvalMcp.ok === true && approvalMcp.data?.needs_approval === true
      && (await q("SELECT 1 FROM pm.tasks WHERE title = 'Swap the footer logo'")).length === 0 && await linksOf(ids.m1) === m1Links, approvalMcp);
    await q("UPDATE pm.team_members SET agent_create_policy = 'live' WHERE id = $1", [ids.scout]);

    // With the default rules the answer is what it was: createApiTask's task, then the link.
    const { resolveApiKey } = await import('../src/lib/api/middleware');
    const { createApiTask } = await import('../src/lib/api/create-task');
    const { createTaskSchema } = await import('../src/lib/schemas');
    const { comms } = await import('../src/lib/communications/db');
    const { apiRequestContext } = await import('../src/lib/api/request-context');
    const { getActorClient } = await import('../src/lib/api/supabase-service');
    const viaRoute = await restCall(rest.tasks.POST, 'POST', `/api/v1/inbox/messages/${ids.m1}/tasks`, keys.scout, { id: ids.m1 }, { project_id: ids.acme, title: 'Identity check A' });
    const resolved = await resolveApiKey(keys.scout);
    // As withApi runs a handler: its actor client, inside the request context that names the door and the key.
    const actor = getActorClient(ids.scout, 'api', resolved.keyRow.id);
    const oldTask = await apiRequestContext.run({ via: 'rest', keyId: resolved.keyRow.id }, () => createApiTask({
      supabase: actor, body: createTaskSchema.parse({ project_id: ids.acme, title: 'Identity check B' }), apiKeyId: resolved.keyRow.id,
      teamMemberId: ids.scout, access: resolved.access, scopes: resolved.keyRow.scopes ?? [],
    }, `/api/v1/inbound-emails/${ids.m1}/tasks`));
    const { data: oldLink } = await comms(actor).rpc('link_message_task', { p_message_id: ids.m1, p_task_id: oldTask.id, p_relation: 'created', p_member_id: ids.scout });
    const before = { ...oldTask, email_link: { message_id: ids.m1, relation: 'created', ...(oldLink as Record<string, unknown>) } } as Loose;
    const after = viaRoute.body.data ?? {};
    const VOLATILE = new Set(['id', 'title', 'created_at', 'updated_at', 'sort_order', 'email_link']);
    const differing = Object.keys(before).filter((field) => !VOLATILE.has(field) && !isDeepStrictEqual(before[field], after[field]));
    check('default rules: the REST answer keeps the old shape exactly (fields, order, values)', viaRoute.status === 201
      && JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(before))
      && JSON.stringify(Object.keys(after.email_link ?? {})) === JSON.stringify(Object.keys(before.email_link)) && differing.length === 0,
    { status: viaRoute.status, after: Object.keys(after), before: Object.keys(before), differing: differing.map((f) => [f, before[f], after[f]]) });

    const labelled = await tool(keys.scout, 'label_email_attachment', { message_id: ids.m1, attachment_id: ids.attachment, agent_label: 'The new logo, vector' });
    check('label_email_attachment: the label is set', labelled.ok === true && (await q('SELECT agent_label FROM pm.attachments WHERE id = $1', [ids.attachment]))[0].agent_label === 'The new logo, vector', labelled);
    const wrote = await tool(keys.scout, 'write_reply_draft', { draft_id: ids.draft, body: 'Thanks Dana, we will swap it today.' });
    check('write_reply_draft: the draft is ready', wrote.ok === true && wrote.data?.status === 'ready', wrote);
    const wroteAgain = await tool(keys.scout, 'write_reply_draft', { draft_id: ids.draft, body: 'Again' });
    check('write_reply_draft: an answered request is 409', wroteAgain.ok === false && wroteAgain.status === 409, wroteAgain);
    const both = await tool(keys.scout, 'write_reply_draft', { draft_id: ids.draft, body: 'x', failure: 'y' });
    check('write_reply_draft: body or failure, not both', both.ok === false && both.status === 422 && both.error?.reason === 'invalid_arguments', both);

    const ruleKey = randomUUID();
    const ruleArgs = { match_kind: 'domain', match_value: 'tool.example', topic: 'usage', action: 'fyi', reason: 'Weekly usage alerts from tool.example need no action.', idempotency_key: ruleKey };
    const rule = await tool(keys.scout, 'add_sender_rule', ruleArgs);
    const ruleAgain = await tool(keys.scout, 'add_sender_rule', ruleArgs);
    check('add_sender_rule: added once; the same idempotency_key replays it', rule.ok === true && ruleAgain.ok === true && ruleAgain.data?.rule?.id === rule.data?.rule?.id
      && (await q("SELECT 1 FROM pm.sender_rules WHERE match_value = 'tool.example' AND disabled_at IS NULL")).length === 1, { rule, ruleAgain });
    const protectedRule = await tool(keys.scout, 'add_sender_rule', { ...ruleArgs, topic: 'money', idempotency_key: undefined });
    check('add_sender_rule: never money (the route says so)', protectedRule.ok === false && protectedRule.status === 422, protectedRule);
    same('list_sender_rules: lists the new rule, as REST does', await tool(keys.scout, 'list_sender_rules'), await restCall(rest.rules.GET, 'GET', '/api/v1/inbox/sender-rules', keys.scout));

    // Summaries: Rex's triage is out of Scout's reach.
    const rexTriage = await restCall(rest.triage.POST, 'POST', `/api/v1/inbox/messages/${ids.mB}/triage`, keys.rex, { id: ids.mB },
      { outcome: 'needs_human', urgent: false, summary: 'Invoice to check', question_for_human: 'Pay it?' });
    const restUnsummarized = await restCall(rest.unsummarized.GET, 'GET', '/api/v1/inbox/triage/unsummarized', keys.scout);
    const unsummarized = await tool(keys.scout, 'list_unsummarized_triage');
    same('list_unsummarized_triage: the same as REST', unsummarized, restUnsummarized);
    const triageIds = (unsummarized.data ?? []).map((item: Loose) => item.triage?.id ?? item.id).filter(Boolean);
    check('list_unsummarized_triage: Scout\'s question is there, Rex\'s is not', JSON.stringify(unsummarized.data).includes(triaged.data?.triage?.id)
      && !JSON.stringify(unsummarized.data).includes(rexTriage.body.data?.triage?.id), { unsummarized: unsummarized.data, rex: rexTriage.body });
    const foreignMark = await tool(keys.scout, 'mark_triage_summarized', { triage_ids: [triaged.data?.triage?.id, rexTriage.body.data?.triage?.id] });
    check('access: marking another inbox\'s triage marks nothing (404)', foreignMark.ok === false && foreignMark.status === 404
      && (await q('SELECT 1 FROM pm.triage WHERE summarized_at IS NOT NULL')).length === 0, foreignMark);
    const marked = await tool(keys.scout, 'mark_triage_summarized', { triage_ids: [triaged.data?.triage?.id] });
    check('mark_triage_summarized: marks its own', marked.ok === true && marked.data?.marked >= 1, { marked, triageIds });
    check('deprecated: the summary tools are off tools/list yet still answer by name', !scoutTools.includes('list_unsummarized_triage') && !scoutTools.includes('mark_triage_summarized')
      && unsummarized.ok === true && marked.ok === true, scoutTools);

    // ---- REST unchanged by all of it, for a read nothing above wrote to --------------------------------
    const restListAfter = await restCall(rest.list.GET, 'GET', `/api/v1/inbox/messages?inbox_id=${ids.inboxB}`, keys.rex);
    const mcpRex = await tool(keys.rex, 'list_inbox', { inbox_id: ids.inboxB });
    same('REST and MCP still agree for another key', mcpRex, restListAfter);
    const restLater = await restCall(rest.list.GET, 'GET', '/api/v1/inbox/messages?status=handled', keys.scout);
    same('REST and MCP agree after the writes', await tool(keys.scout, 'list_inbox', { status: 'handled' }), restLater);

    // ---- A long conversation stays readable ---------------------------------------------------------
    const longId = id(100 + LONG_MESSAGES - 1);
    const restLong = await restCall(rest.detail.GET, 'GET', `/api/v1/inbox/messages/${longId}`, keys.scout, { id: longId });
    const long = await tool(keys.scout, 'get_email', { message_id: longId });
    check('bounding: REST keeps the whole thread (over the MCP cap)', restLong.status === 200 && JSON.stringify(restLong.body).length > 40_000
      && restLong.body.data.thread.messages.length === LONG_MESSAGES, JSON.stringify(restLong.body).length);
    check('bounding: over MCP it reads, under the cap, cut and flagged', long.ok === true && JSON.stringify(long).length < 40_000
      && long.data.text.length <= 8001 && long.data.text_truncated === true && long.data.new_text_truncated === true && long.data.html_text_omitted === true
      && long.data.thread.messages.length === 8 && /Newest 8 of 12/.test(long.data.thread.messages_note)
      && long.data.thread.messages.every((m: Loose) => m.text === null && m.new_text.length <= 801), long.error ?? JSON.stringify(long).length);
    const longContext = await tool(keys.scout, 'get_email_triage_context', { message_id: longId });
    check('bounding: the triage context of a long thread reads too', longContext.ok === true && JSON.stringify(longContext).length < 40_000, longContext.error);

    const restBusy = await restCall(rest.context.GET, 'GET', `/api/v1/inbox/messages/${ids.mBusy}/context`, keys.scout, { id: ids.mBusy });
    check('bounding: REST gives three busy projects whole (over the MCP cap)', restBusy.status === 200 && JSON.stringify(restBusy.body).length > 40_000
      && restBusy.body.data.projects.length === 3 && restBusy.body.data.projects.every((p: Loose) => p.open_tasks.length === 40 && p.recent.length === 20),
    restBusy.body.data?.projects?.map((p: Loose) => [p.open_tasks?.length, p.recent?.length]));
    const busy = await tool(keys.scout, 'get_email_triage_context', { message_id: ids.mBusy });
    const busyProjects: Loose[] = busy.data?.projects ?? [];
    check('bounding: over MCP three busy projects read under the cap, every cut flagged', busy.ok === true && JSON.stringify(busy).length < 40_000
      && busyProjects.length === 3
      && busyProjects.every((p) => p.open_tasks.length > 0 && p.open_tasks.length < 40 && new RegExp(`Newest ${p.open_tasks.length} of 40 open tasks`).test(p.open_tasks_note)
        && p.recent.length < 20 && new RegExp(`Newest ${p.recent.length} of 20 recent items`).test(p.recent_note ?? ''))
      && busyProjects.every((p) => p.open_tasks.every((t: Loose) => {
        const whole = restBusy.body.data.projects.find((r: Loose) => r.id === p.id)?.open_tasks.find((w: Loose) => w.id === t.id);
        return !!whole && (t.subtasks.length === whole.subtasks.length || new RegExp(`First ${t.subtasks.length} of ${whole.subtasks.length} open subtasks`).test(t.subtasks_note ?? ''));
      }))
      && Array.isArray(busy.data?.cut_to_fit),
    busy.error ?? { size: JSON.stringify(busy).length, projects: busyProjects.map((p) => [p.open_tasks?.length, p.open_tasks_note, p.recent?.length, p.recent_note, p.open_tasks?.[0]?.subtasks?.length, p.open_tasks?.[0]?.subtasks_note]), cut: busy.data?.cut_to_fit });
    check('bounding: the newest open tasks are the ones kept', busyProjects.length === 3 && busyProjects.every((p) => {
      const whole = restBusy.body.data.projects.find((r: Loose) => r.id === p.id);
      return p.open_tasks.every((t: Loose, i: number) => t.id === whole.open_tasks[i].id);
    }));

    // ---- Whitespace is not text ------------------------------------------------------------------------
    const htmlOnly = await tool(keys.scout, 'get_email', { message_id: ids.mHtml });
    check('whitespace: an HTML-only email (its text a bare newline) keeps html_text', htmlOnly.ok === true && /Only the HTML part/.test(htmlOnly.data?.html_text ?? '')
      && !htmlOnly.data?.html_text_omitted, htmlOnly.error ?? htmlOnly.data);
    const blankReply = await tool(keys.scout, 'get_email', { message_id: ids.mHtmlReply });
    const entries: Loose[] = blankReply.data?.thread?.messages ?? [];
    const replyEntry = entries.find((m) => m.id === ids.mHtmlReply);
    const htmlEntry = entries.find((m) => m.id === ids.mHtml);
    check('whitespace: in the thread, blank new_text keeps the text, and the HTML-only email keeps its html_text', !!replyEntry && /The reply text/.test(replyEntry.text ?? '')
      && !replyEntry.text_omitted && !!htmlEntry && /Only the HTML part/.test(htmlEntry.html_text ?? '') && !htmlEntry.html_text_omitted, entries);

    // ---- pm_guide, the context pack and the template -----------------------------------------------
    const guide = await tool(keys.scout, 'pm_guide');
    check('guide: an inbox key gets the inbox section', guide.ok === true && guide.guide.includes(PM_INBOX_GUIDE) && guide.guide.startsWith(PM_GUIDE), guide.guide?.slice(-400));
    check('guide: and stays under the MCP read cap', JSON.stringify(guide).length < 40_000, JSON.stringify(guide).length);
    check('context: the triage convention is in its pack', (guide.context?.conventions ?? []).some((line: string) => /submit_triage_plan/.test(line) && /record_email_triage/.test(line)), guide.context?.conventions);
    const plainGuide = await tool(keys.noEmail, 'pm_guide');
    check('guide: a key without inbox tools gets the guide without it', plainGuide.ok === true && plainGuide.guide === PM_GUIDE
      && !(plainGuide.context?.conventions ?? []).some((line: string) => /submit_triage_plan/.test(line)), plainGuide.guide?.slice(-200));

    const template = findAgentTemplate('inbox-triage');
    const service = getServiceClient();
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [ids.scout, template?.scopes ?? []]);
    const access = await resolveMemberAccess(service, ids.scout);
    const templateTools = access ? toolsFor({ access, scopes: [...(template?.scopes ?? [])], readOnly: false, profile: 'generic' }).map((t) => t.name) : [];
    // record_email_triage is deprecated: callable by name (above), no longer offered.
    const loop = ['get_triage_queue', 'list_inbox', 'get_email', 'get_email_triage_context', 'submit_triage_plan', 'create_task_from_email', 'list_reply_drafts', 'write_reply_draft'];
    check('template: inbox-triage\'s scopes open the whole triage loop', loop.every((name) => templateTools.includes(name)), loop.filter((name) => !templateTools.includes(name)));
    check('template: its brief names the loop', ['get_triage_queue', 'get_email_triage_context', 'submit_triage_plan', 'record_email_triage'].every((name) => (template?.context ?? '').includes(name)), template?.context);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`inbox over MCP: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`inbox over MCP: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
