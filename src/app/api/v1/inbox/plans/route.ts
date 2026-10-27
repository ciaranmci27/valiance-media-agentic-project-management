import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { inboxScope } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

async function rows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/**
 * Shadow plans beside what the older triage actually did with the same
 * messages, newest first, for comparing the two before a cutover: each
 * message's subject, the shadow plan's summary and items (type, intent,
 * decision, project, what it would do), and the older triage's outcome,
 * question, task links and reminders. Read only, from the inboxes the key can
 * read.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const days = Number(searchParams.get('days') ?? 14);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw badRequest('days must be a whole number from 1 to 90');
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  if (!inboxIds.length) return success({ messages: [] });
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const plans = await rows(comms(supabase).from('plans').select('id, message_id, summary, suspicious, flags, created_at')
    .eq('mode', 'shadow').gte('created_at', since).order('created_at', { ascending: false }).limit(200));
  if (!plans.length) return success({ messages: [] });
  const messageIds = [...new Set(plans.map((p) => p.message_id as string))];
  const [messages, items, triage, links, reminders] = await Promise.all([
    rows(comms(supabase).from('messages').select('id, inbox_id, subject, received_at').in('id', messageIds).in('inbox_id', inboxIds)),
    rows(comms(supabase).from('plan_items').select('plan_id, position, type, intent, decision, decision_reason, project_id, task_id, payload')
      .in('plan_id', plans.map((p) => p.id as string)).order('position')),
    rows(comms(supabase).from('triage').select('message_id, outcome, summary, question_for_human, plan_id, created_at').in('message_id', messageIds).is('plan_id', null)),
    rows(comms(supabase).from('task_links').select('message_id, task_id, relation').in('message_id', messageIds)),
    rows(supabase.from('reminders').select('source_message_id, title, remind_on').in('source_message_id', messageIds).is('deleted_at', null)),
  ]);
  const taskIds = [...new Set([...links.map((l) => l.task_id as string), ...items.map((i) => i.task_id as string | null).filter((id): id is string => !!id)])];
  // includes-deleted: the compare report names tasks and projects even once they are in Trash.
  const tasks = taskIds.length ? await rows(supabase.from('tasks').select('id, title, project_id').in('id', taskIds)) : [];
  const projectIds = [...new Set([...tasks.map((t) => t.project_id as string), ...items.map((i) => i.project_id as string | null).filter((id): id is string => !!id)])];
  // includes-deleted: as above, a project in Trash still has its name in the report.
  const projects = projectIds.length ? await rows(supabase.from('projects').select('id, name').in('id', projectIds)) : [];
  const projectName = (id: unknown) => (projects.find((p) => p.id === id)?.name as string | undefined) ?? null;
  const taskOf = (id: unknown) => tasks.find((t) => t.id === id);
  const visible = new Set(messages.map((m) => m.id as string));

  return success({
    messages: plans.filter((plan) => visible.has(plan.message_id as string)).map((plan) => {
      const message = messages.find((m) => m.id === plan.message_id)!;
      const older = triage.filter((t) => t.message_id === plan.message_id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      return {
        message_id: plan.message_id,
        subject: message.subject,
        received_at: message.received_at,
        shadow: {
          plan_id: plan.id,
          summary: plan.summary,
          suspicious: plan.suspicious,
          flags: plan.flags,
          items: items.filter((i) => i.plan_id === plan.id).map((i) => {
            const payload = (i.payload ?? {}) as Row;
            return {
              type: i.type,
              intent: i.intent,
              decision: i.decision,
              reason: i.decision_reason,
              project: projectName(i.project_id),
              task: (taskOf(i.task_id)?.title as string | undefined) ?? null,
              what: payload.title ?? payload.what ?? payload.text ?? payload.question ?? payload.content ?? payload.name ?? null,
            };
          }),
        },
        older: {
          outcome: older?.outcome ?? null,
          summary: older?.summary ?? null,
          question: older?.question_for_human ?? null,
          links: links.filter((l) => l.message_id === plan.message_id).map((l) => {
            const task = taskOf(l.task_id);
            return { relation: l.relation, task: (task?.title as string | undefined) ?? null, project: projectName(task?.project_id) };
          }),
          reminders: reminders.filter((r) => r.source_message_id === plan.message_id).map((r) => ({ title: r.title, remind_on: r.remind_on })),
        },
      };
    }),
  });
}, { permission: 'inbound_email.read' });
