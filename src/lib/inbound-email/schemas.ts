import { z } from 'zod';

// -- Agent API -------------------------------------------------------------

export const AGENT_MESSAGE_STATUSES = ['new', 'handled', 'ignored', 'needs_ciaran'] as const;
export const TRIAGE_OUTCOMES = ['no_action', 'task', 'needs_reply', 'needs_ciaran'] as const;

export const triageSchema = z.object({
  outcome: z.enum(TRIAGE_OUTCOMES),
  urgent: z.boolean(),
  summary: z.string().trim().min(1).max(4000),
  question_for_ciaran: z.string().trim().min(1).max(4000).nullable().optional(),
  suggested_reply: z.string().trim().min(1).max(20_000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  links: z.array(z.object({
    task_id: z.string().uuid(),
    relation: z.enum(['created', 'updated']),
  }).strict()).max(50).default([]),
  // A retry with the same key on the same email returns the first triage.
  idempotency_key: z.string().min(8).max(100).nullable().optional(),
}).strict();
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
