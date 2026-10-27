import { z } from 'zod';
import { TRIAGE_CATEGORIES } from './outreach';

// -- Agent API -------------------------------------------------------------

export const AGENT_MESSAGE_STATUSES = ['new', 'handled', 'ignored', 'needs_human'] as const;
export const TRIAGE_OUTCOMES = ['no_action', 'task', 'needs_reply', 'needs_human'] as const;

export const triageSchema = z.object({
  outcome: z.enum(TRIAGE_OUTCOMES),
  urgent: z.boolean(),
  summary: z.string().trim().min(1).max(4000),
  question_for_human: z.string().trim().min(1).max(4000).nullable().optional(),
  suggested_reply: z.string().trim().min(1).max(20_000).nullable().optional(),
  // Projects the email is about beyond those of the tasks it links (each in
  // the email's project scope). project_id is the older single-project form.
  project_ids: z.array(z.string().uuid()).max(20).optional(),
  project_id: z.string().uuid().nullable().optional(),
  links: z.array(z.object({
    task_id: z.string().uuid(),
    // related: about the task, asks for no change.
    relation: z.enum(['created', 'updated', 'related']),
  }).strict()).max(50).default([]),
  // One line on where the whole conversation stands; replaces the thread's last one.
  thread_summary: z.string().trim().min(1).max(300).nullable().optional(),
  // A retry with the same key on the same email returns the first triage.
  idempotency_key: z.string().min(8).max(100).nullable().optional(),
  // What the email is: work, fyi (needs nothing), or outreach (someone
  // selling to us). Outreach is filtered unless something guards it.
  category: z.enum(TRIAGE_CATEGORIES).nullable().optional(),
}).strict().superRefine((body, ctx) => {
  // A pitch asks nothing of anyone: it never needs a person, a reply or a task.
  if (body.category !== 'outreach') return;
  if (body.outcome !== 'no_action') ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'Outreach is no_action: a pitch never needs a person, a reply or a task' });
  if (body.urgent) ctx.addIssue({ code: 'custom', path: ['urgent'], message: 'Outreach is never urgent' });
  if (body.links.length > 0) ctx.addIssue({ code: 'custom', path: ['links'], message: 'Outreach links no task' });
  if (body.question_for_human) ctx.addIssue({ code: 'custom', path: ['question_for_human'], message: 'Outreach asks no question' });
  if (body.suggested_reply) ctx.addIssue({ code: 'custom', path: ['suggested_reply'], message: 'Outreach gets no reply' });
});
export type TriageRequest = z.infer<typeof triageSchema>;

export const attachmentLabelSchema = z.object({
  agent_label: z.string().trim().min(1).max(200).nullable(),
}).strict();

export const markSummarizedSchema = z.object({
  triage_ids: z.array(z.string().uuid()).min(1).max(500),
}).strict();

// -- Inbox UI (session routes, people only) ---------------------------------

const projectIdList = z.array(z.string().uuid()).min(1).max(20);

/** Rule 7: only a person creates a mapping, and only through these. */
export const setThreadProjectSchema = z.object({
  project_id: z.string().uuid(),
  remember_sender: z.object({
    address: z.string().trim().min(3).max(320),
    project_ids: projectIdList,
  }).strict().nullable().optional(),
  remember_domain: z.object({
    domain: z.string().trim().min(3).max(253),
    project_ids: projectIdList,
  }).strict().nullable().optional(),
}).strict();

export const sendBackSchema = z.object({
  message_id: z.string().uuid().nullable().optional(),
}).strict();

/** A person's answer to the agent's question on an email (the newest one asking, by default). */
export const answerQuestionSchema = z.object({
  message_id: z.string().uuid().nullable().optional(),
  answer: z.string().trim().min(1).max(2000),
}).strict();

export const clientDomainSchema = z.object({
  domain: z.string().trim().min(1).max(253),
}).strict();

export const clientSenderSchema = z.object({
  address: z.string().trim().min(1).max(320),
}).strict();

export const relayDomainSchema = z.object({
  domain: z.string().trim().min(3).max(253),
}).strict();

/** A routing local part: empty (take the default) or letters, digits, dots, dashes, underscores. */
const routingLocalPart = z.string().trim().toLowerCase().max(64)
  .regex(/^([a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?)?$/, 'Use letters, numbers, dots, dashes or underscores');

export const inboxSettingsSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  address: z.string().trim().toLowerCase().min(3).max(320),
  routing_local_part: routingLocalPart,
  routing_domain: z.string().trim().toLowerCase().max(253),
  handler_member_id: z.string().uuid().nullable(),
  enabled: z.boolean(),
  retention_days: z.number().int().min(1).max(3650),
  max_attachment_mb: z.number().int().min(1).max(50),
  agent_readable_types: z.array(z.enum(['image', 'pdf', 'text'])).max(3),
  summary_interval_minutes: z.number().int().min(5).max(1440),
  filter_auto_mail: z.boolean(),
  /** Addresses that reach the inbox without being its own; left out, they stay as they are. */
  aliases: z.array(z.string().trim().toLowerCase().max(320)).max(20).optional(),
  /** Which triage runs the inbox: the older one, both (plans in shadow, for comparing), or plans. Left out, it stays. */
  triage_mode: z.enum(['legacy', 'shadow', 'plans']).optional(),
  access_member_ids: z.array(z.string().uuid()).max(100),
}).strict();
export type InboxSettingsRequest = z.infer<typeof inboxSettingsSchema>;

/**
 * A project's own email address. The routing local part follows the inbox
 * rules; left empty, it takes the public address's local part. The routing
 * domain is the relay domain when the address is created, and stays.
 */
export const projectAddressSchema = z.object({
  inbox_id: z.string().uuid(),
  routing_local_part: routingLocalPart,
  public_address: z.string().trim().toLowerCase().max(320).nullable(),
  enabled: z.boolean(),
}).strict();
export type ProjectAddressRequest = z.infer<typeof projectAddressSchema>;

export const projectAddressPatchSchema = projectAddressSchema.partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change');
export type ProjectAddressPatch = z.infer<typeof projectAddressPatchSchema>;

/** One of your addresses: what people write to, its project (if any) and whose it is (a person, or null for the company). */
export const yourAddressSchema = z.object({
  address: z.string().trim().toLowerCase().min(3).max(320),
  project_id: z.string().uuid().nullable(),
  owner_member_id: z.string().uuid().nullable(),
  inbox_id: z.string().uuid().optional(),
}).strict();
export type YourAddressRequest = z.infer<typeof yourAddressSchema>;

/** A domain of yours, or an address that is not yours. */
export const ownDomainSchema = z.object({ domain: z.string().trim().toLowerCase().min(3).max(253) }).strict();
export const ignoredAddressSchema = z.object({ address: z.string().trim().toLowerCase().min(3).max(320) }).strict();

export const yourAddressPatchSchema = z.object({
  project_id: z.string().uuid().nullable(),
  owner_member_id: z.string().uuid().nullable(),
  enabled: z.boolean(),
  inbox_id: z.string().uuid(),
}).partial().strict()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change');
export type YourAddressPatch = z.infer<typeof yourAddressPatchSchema>;
