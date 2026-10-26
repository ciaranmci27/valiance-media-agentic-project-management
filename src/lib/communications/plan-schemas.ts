/**
 * What an agent sends as a triage plan: a summary and its items. Each item
 * has a type (what it does), an intent (why: the triage catalog's twelve), who
 * the work is aimed at, the words that justify it, and how sure the agent is.
 * The app's policy decides each item (triage-policy.ts).
 */
import { z } from 'zod';
import { ADDRESSEES, PLAN_INTENTS } from './triage-policy';

const id = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM (24-hour)');
const text = (max: number) => z.string().trim().min(1).max(max);

const base = {
  intent: z.enum(PLAN_INTENTS),
  addressee: z.enum(ADDRESSEES).default('ciaran'),
  /** The teammate it is aimed at, when addressee is teammate. */
  addressee_member_id: id.optional(),
  /** The words (or "attachment <name>: what it shows") that justify it. */
  evidence: z.string().trim().max(1000).optional(),
  confidence: z.enum(['sure', 'unsure']).default('sure'),
};

export const planItemSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('create_task'),
    project_id: id,
    title: text(500),
    description: z.string().max(20000).optional(),
    due_date: day.nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    /** Who should do it; assignment itself is always a person's call. */
    suggested_assignee_id: id.optional(),
    /** This message's attachments to put on the new task. */
    attachment_ids: z.array(id).max(20).optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal('update_task'),
    task_id: id,
    changes: z.object({
      due_date: day.nullable().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      project_id: id.optional(),
      description: z.string().max(20000).optional(),
      /** Only in_review: a teammate reporting their own task ready. */
      status: z.literal('in_review').optional(),
    }).strict().refine((changes) => Object.values(changes).some((v) => v !== undefined), { message: 'Name at least one change' }),
  }).strict(),
  z.object({ ...base, type: z.literal('comment'), task_id: id, text: text(10000) }).strict(),
  z.object({ ...base, type: z.literal('attach_file'), task_id: id, attachment_ids: z.array(id).min(1).max(20) }).strict(),
  z.object({
    ...base,
    type: z.literal('add_reminder'),
    title: text(500),
    notes: z.string().max(5000).optional(),
    remind_on: day.nullable().optional(),
    remind_at: time.nullable().optional(),
    task_id: id.optional(),
    project_id: id.optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal('update_reminder'),
    reminder_id: id,
    title: text(500).optional(),
    notes: z.string().max(5000).optional(),
    remind_on: day.nullable().optional(),
    remind_at: time.nullable().optional(),
  }).strict(),
  z.object({ ...base, type: z.literal('complete_reminder'), reminder_id: id }).strict(),
  z.object({ ...base, type: z.literal('link_task'), task_id: id, relation: z.enum(['created', 'updated', 'related']) }).strict(),
  z.object({ ...base, type: z.literal('file_project'), project_id: id }).strict(),
  z.object({
    ...base,
    type: z.literal('reply_owed'),
    /** An open point on this conversation to amend instead of adding one. */
    point_id: id.optional(),
    who: text(200),
    what: text(1000),
    kind: z.enum(['info', 'decision', 'security', 'schedule']),
    project_id: id.optional(),
    by_when: day.optional(),
    urgent: z.boolean().optional(),
    /** Owed by the agent (a teammate asked it), with the answer it found. */
    to_agent: z.boolean().optional(),
    note: z.string().max(2000).optional(),
  }).strict(),
  z.object({ ...base, type: z.literal('revert_item'), plan_item_id: id }).strict(),
  z.object({ ...base, type: z.literal('mute_conversation') }).strict(),
  z.object({
    ...base,
    type: z.literal('add_context'),
    project_id: id,
    category: z.enum(['business_context', 'existing_work', 'technical_decision', 'constraint', 'lesson_learned']),
    content: text(5000),
  }).strict(),
  z.object({
    ...base,
    type: z.literal('propose_mapping'),
    project_id: id,
    address: z.string().trim().toLowerCase().max(320).optional(),
    domain: z.string().trim().toLowerCase().max(253).optional(),
  }).strict().refine((item) => !!item.address !== !!item.domain, { message: 'Name an address or a domain' }),
  z.object({
    ...base,
    type: z.literal('create_lead'),
    name: text(200),
    email: z.string().trim().toLowerCase().max(320).optional(),
    company: z.string().trim().max(200).optional(),
    notes: z.string().max(5000).optional(),
    source: z.enum(['referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other']).optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal('log_interaction'),
    lead_id: id,
    kind: z.enum(['call', 'email', 'meeting', 'note', 'follow_up']),
    title: text(300),
    description: z.string().max(5000).optional(),
    scheduled_at: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal('ask'),
    /** One sentence: which project or task this belongs to. */
    question: text(300),
    default: z.string().trim().max(300).optional(),
  }).strict(),
]);
export type PlanItemRequest = z.infer<typeof planItemSchema>;

export const planSchema = z.object({
  mode: z.enum(['live', 'shadow']).default('live'),
  summary: text(4000),
  thread_summary: z.string().trim().max(300).optional(),
  urgent: z.boolean().default(false),
  suspicious: z.boolean().default(false),
  flags: z.array(z.enum(['context_incomplete', 'content_unreadable'])).max(2).default([]),
  items: z.array(planItemSchema).max(30).default([]),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
}).strict().refine((plan) => plan.items.filter((item) => item.type === 'ask').length <= 1, {
  message: 'A plan asks at most one question',
  path: ['items'],
});
export type PlanRequest = z.infer<typeof planSchema>;
