/**
 * What the Inbox UI reads and sends: the session routes under
 * /api/workspace/inbox and /api/workspace/email-inboxes return these, and
 * demo mode builds the same shapes from fixtures. Client-safe (no server
 * imports). Nothing here sends email: the Inbox is read-only by design.
 */

import type { CandidateReason } from './mapping';

export const INBOX_TABS = ['all', 'needs_you', 'needs_reply', 'new', 'updates', 'handled', 'ignored', 'unassigned'] as const;
export type InboxTab = typeof INBOX_TABS[number];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  all: 'Inbox',
  needs_you: 'Needs you',
  needs_reply: 'Needs reply',
  new: 'New',
  updates: 'Updates',
  handled: 'Handled',
  ignored: 'Filtered',
  unassigned: 'Unassigned',
};

export type MessageStatus = 'new' | 'handled' | 'ignored' | 'needs_human';
export type TriageOutcome = 'no_action' | 'task' | 'needs_reply' | 'needs_human';
/**
 * How a thread got its project. inferred: the agent chose among the mapping
 * candidates; guessed: the agent chose with no candidates to go on; address:
 * sent to one of the project's own addresses.
 */
export type ProjectSource = 'mapped' | 'inferred' | 'guessed' | 'person' | 'address';

/** The agent's choice, inferred or guessed: shown as unsettled until a person confirms it. */
export function isAgentChoice(source: ProjectSource | null | undefined): boolean {
  return source === 'inferred' || source === 'guessed';
}
export type TrustLevel = 'trusted' | 'untrusted' | 'unknown';
/**
 * What decided a message's project candidates. sender: its From address.
 * The other two only for mail from a verified teammate: forwarded_original,
 * the original sender of the email they forwarded; team_recipients, the
 * client addresses in To and Cc of their own email, copied to the inbox.
 */
export type RoutingBasis = 'sender' | 'forwarded_original' | 'team_recipients';
/** The one state a thread shows, most pressing first. */
export type ThreadState = 'needs_you' | 'new' | 'needs_reply' | 'handled' | 'ignored';

export interface InboxSummary {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  handler: { id: string; name: string } | null;
}

export interface ThreadProject {
  id: string;
  name: string;
  source: ProjectSource;
  /** For source address, in thread detail: the address it came through (public, else routing), while it exists. */
  address?: string | null;
}

export interface InboxThreadSummary {
  id: string;
  inbox_id: string;
  inbox_name: string;
  subject: string;
  project: ThreadProject | null;
  /** Every project the thread is filed on, strongest first (project is the first of them). */
  projects: ThreadProject[];
  last_message_at: string;
  message_count: number;
  /** The latest message's sender: for a teammate's forward, the original sender. */
  sender: { name: string; address: string } | null;
  snippet: string;
  state: ThreadState;
  needs_you: boolean;
  needs_reply: boolean;
  has_new: boolean;
  urgent: boolean;
  untrusted: boolean;
  attachment_count: number;
  /** One line on where the conversation stands, kept by the agent. */
  summary: string | null;
  /** Live tasks the thread's emails created, updated or relate to. */
  task_count: number;
  /** Open reminders the thread's emails set. */
  reminder_count: number;
}

export type InboxTabCounts = Record<InboxTab, number>;

export interface InboxThreadList {
  inboxes: InboxSummary[];
  threads: InboxThreadSummary[];
  total: number;
  counts: InboxTabCounts;
}

export interface InboxPerson {
  address: string;
  name: string;
  contact_id: string | null;
}

/** How an email was sorted on arrival (sorting.ts). */
export interface InboxSorting {
  kind: 'person' | 'team' | 'meeting_notes' | 'notification' | 'marketing';
  topic: 'money' | 'account_risk' | 'security' | 'usage' | 'event' | 'newsletter' | 'promotion' | 'update' | null;
  action: 'ignore' | 'fyi' | 'always' | 'triage' | null;
  reason: string | null;
  rule_id: string | null;
  /** The newer alert that replaced this one. */
  superseded_by: string | null;
}

export interface InboxAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number | null;
  kind: 'image' | 'pdf' | 'text' | 'other';
  /** Stored and downloadable. */
  available: boolean;
  skipped_reason: string | null;
  agent_label: string | null;
  /** The Content-ID an HTML body points at with cid:, lowercased and without brackets. */
  content_id: string | null;
  /** The stored bytes' hash: a reply that re-sends a file carries the same one. */
  sha256: string | null;
}

/** Why an attachment was not stored (communications.attachments.skipped_reason). */
export type AttachmentSkippedReason = 'over_size_cap' | 'download_failed';

export const ATTACHMENT_SKIPPED_LABELS: Record<AttachmentSkippedReason, string> = {
  over_size_cap: 'Not stored: it was over the size limit',
  download_failed: 'Not stored: it failed to download',
};

/** The words for a file that was not stored, whatever the reason. */
export function skippedReasonLabel(reason: string | null): string {
  return (reason && ATTACHMENT_SKIPPED_LABELS[reason as AttachmentSkippedReason]) || 'Not stored';
}

export interface InboxTriage {
  id: string;
  outcome: TriageOutcome;
  urgent: boolean;
  summary: string;
  question_for_human: string | null;
  suggested_reply: string | null;
  member: { id: string; name: string } | null;
  created_at: string;
}

export type TaskLinkRelation = 'created' | 'updated' | 'related';

export interface InboxLinkedTask {
  task_id: string;
  /** related: about the task, asks for no change. */
  relation: TaskLinkRelation;
  /** Who linked it: the agent at triage, or a person in the Inbox. */
  by: 'agent' | 'person';
  title: string | null;
  status: string | null;
  project_id: string | null;
  /** The task's project, or a neutral label when the member cannot reach it. */
  project_name: string | null;
}

export interface InboxAnswer {
  text: string;
  by: { id: string; name: string } | null;
  at: string;
}

export interface InboxMessage {
  id: string;
  status: MessageStatus;
  subject: string;
  received_at: string;
  sent_at: string | null;
  from: InboxPerson | null;
  to: InboxPerson[];
  cc: InboxPerson[];
  is_forward: boolean;
  routing_basis: RoutingBasis;
  /** The verified teammate who forwarded it or copied the inbox (null for sender, or once they are deleted). */
  forwarded_by: { member_id: string; name: string } | null;
  /** Who wrote the email a teammate forwarded (forwarded_original only); shown as the sender. */
  original_sender: { address: string; name: string } | null;
  /** The verdict on the outer message (From), whatever the routing basis. */
  trust: { level: TrustLevel; reason: string | null; spf: string | null; dkim: string | null; dmarc: string | null };
  auto_mail_reason: string | null;
  /** How it was sorted on arrival; null for mail from before sorting. */
  sorting: InboxSorting | null;
  new_text: string | null;
  text_body: string | null;
  html_body: string | null;
  attachments: InboxAttachment[];
  triage: InboxTriage | null;
  linked_tasks: InboxLinkedTask[];
  reminders: InboxReminder[];
  /** A person's answer to the question on the triage shown, if any. */
  answer?: InboxAnswer | null;
  /** The newest triage plan for it: what the agent did and proposed, item by item. */
  plan?: InboxPlan | null;
  /** What someone waits on a person (or the agent) for, raised by this email. */
  reply_points?: InboxReplyPoint[];
  reviewed_at: string | null;
  reviewed_by: { id: string; name: string } | null;
}

/** One item of a triage plan, as a person reads it. */
export interface InboxPlanItem {
  id: string;
  type: string;
  intent: string;
  decision: 'apply' | 'apply_unsure' | 'propose' | 'reject';
  /** Why the app decided so. */
  decision_reason: string | null;
  state: 'applying' | 'done' | 'failed' | 'pending' | 'accepted' | 'dismissed' | 'expired' | 'undone' | 'skipped';
  /** What it does, in a line: "New task: Add the size chart". */
  label: string;
  /** The words or attachment that justify it. */
  evidence: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  error: string | null;
}

export interface InboxPlan {
  id: string;
  status: 'applying' | 'applied' | 'partial' | 'undone';
  created_at: string;
  items: InboxPlanItem[];
}

export interface InboxReplyPoint {
  id: string;
  who: string;
  what: string;
  kind: 'info' | 'decision' | 'security' | 'schedule';
  by_when: string | null;
  urgent: boolean;
  /** Owed by the agent rather than a person (a teammate asked it). */
  to_agent: boolean;
  note: string | null;
  state: 'open' | 'resolved' | 'expired';
}

/** How a candidate's reason reads in the UI ("matched by contact and client email address"). */
export const CANDIDATE_REASON_LABELS: Record<CandidateReason, string> = {
  contact: 'contact',
  domain: 'client domain',
  sender: 'client email address',
};

export interface InboxCandidate {
  project_id: string;
  name: string | null;
  reasons: CandidateReason[];
}

/** A sender the thread could be remembered by: never a teammate or the inbox itself. */
export interface RememberableSender {
  address: string;
  name: string;
  domain: string;
  /** Public webmail: only the exact address can be remembered. */
  domain_is_public: boolean;
  contact_ids: string[];
  /** Projects this address already maps to through a contact or a client email address. */
  mapped_project_ids: string[];
  /** Projects the domain already maps to. */
  domain_project_ids: string[];
}

export interface InboxThreadDetail {
  id: string;
  inbox: InboxSummary;
  subject: string;
  project: ThreadProject | null;
  /** Every project the thread is filed on, strongest first (project is the first of them). */
  projects: ThreadProject[];
  state: ThreadState;
  urgent: boolean;
  untrusted: boolean;
  candidates: InboxCandidate[];
  messages: InboxMessage[];
  senders: RememberableSender[];
  /** One line on where the conversation stands, kept by the agent. */
  summary: string | null;
  /** The newest reply draft asked for on this thread. */
  reply_draft?: InboxReplyDraft | null;
}

/** A reply the agent drafted on request: copied into a person's own mail, never sent. */
export interface InboxReplyDraft {
  id: string;
  status: 'requested' | 'ready' | 'failed';
  instructions: string;
  body: string | null;
  failure: string | null;
  requested_by: { id: string; name: string } | null;
  drafted_by: { id: string; name: string } | null;
  created_at: string;
  completed_at: string | null;
}

/** A reminder that came from an email (reminders.source_message_id). */
export interface InboxReminder {
  id: string;
  title: string;
  remind_on: string | null;
  status: 'open' | 'done';
  task_id: string | null;
}

export interface SetThreadProjectRequest {
  project_id: string;
  remember_sender?: { address: string; project_ids: string[] } | null;
  remember_domain?: { domain: string; project_ids: string[] } | null;
}

export interface SetThreadProjectResult {
  project: ThreadProject;
  /** contact_id is null when every chosen project already had the address as a client email address, so no contact was needed. */
  remembered_sender: { contact_id: string | null; created_contact: boolean; linked_project_ids: string[] } | null;
  remembered_domain: { domain: string; added_project_ids: string[] } | null;
}

export interface TaskSourceEmail {
  message_id: string;
  thread_id: string;
  inbox_id: string;
  subject: string;
  from: { name: string; address: string } | null;
  received_at: string;
  relation: TaskLinkRelation;
  by: 'agent' | 'person';
  /** When it was linked to the task, and by which person (null for an agent's triage). */
  linked_at: string;
  linked_by: string | null;
}

export interface TaskSourceEmails {
  /** Every link the task has, readable or not. */
  link_count: number;
  emails: TaskSourceEmail[];
}

// -- Settings ---------------------------------------------------------------

export const AGENT_READABLE_TYPES = ['image', 'pdf', 'text'] as const;
export type AgentReadableType = typeof AGENT_READABLE_TYPES[number];

export interface InboxSettings {
  id: string;
  name: string;
  address: string;
  routing_local_part: string;
  routing_domain: string;
  routing_address: string;
  handler_member_id: string | null;
  enabled: boolean;
  retention_days: number;
  max_attachment_mb: number;
  agent_readable_types: AgentReadableType[];
  summary_interval_minutes: number;
  filter_auto_mail: boolean;
  /** Addresses that reach the inbox without being its own (a personal address forwarding here). */
  aliases: string[];
  /** Which triage runs it: legacy (the older one), shadow (both; plans only recorded), plans. */
  triage_mode: 'legacy' | 'shadow' | 'plans';
  verification_code: string;
  verified_at: string | null;
  last_received_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  access_member_ids: string[];
  message_count: number;
  /** Project email addresses that deliver to this inbox. */
  project_address_count: number;
  created_at: string;
}

export interface InboxSettingsList {
  relay_domain: string;
  inboxes: InboxSettings[];
}

export interface InboxSettingsInput {
  name: string;
  address: string;
  routing_local_part: string;
  routing_domain: string;
  handler_member_id: string | null;
  enabled: boolean;
  retention_days: number;
  max_attachment_mb: number;
  agent_readable_types: AgentReadableType[];
  summary_interval_minutes: number;
  filter_auto_mail: boolean;
  aliases?: string[];
  triage_mode?: 'legacy' | 'shadow' | 'plans';
  access_member_ids: string[];
}

export interface MxStatus {
  domain: string;
  found: boolean;
  records: { exchange: string; priority: number }[];
  error: string | null;
}

export interface ClientEmailDomain {
  id: string;
  domain: string;
  project_id: string;
  created_at: string;
}

/**
 * An address whose mail maps to the project. source contact: an address of one
 * of the project's contacts, managed in Contacts (contact_id and contact_name
 * are null for a member who cannot read contacts). source manual: a client
 * email address added on the project (communications.client_addresses). id is the
 * manual row, set whenever one exists, so a contact address that is also a
 * manual row can still have that row removed.
 */
export interface ClientSenderAddress {
  address: string;
  source: 'contact' | 'manual';
  id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  created_at: string | null;
}

export interface ClientSenderAddressList {
  addresses: ClientSenderAddress[];
}

/** A project's own email address: mail to routing_address lands in the inbox, filed on the project. */
export interface ProjectEmailAddress {
  id: string;
  project_id: string;
  inbox_id: string;
  routing_local_part: string;
  routing_domain: string;
  routing_address: string;
  /** What clients see, e.g. p4tf@valiancemedia.com; display and forwarder instructions only. */
  public_address: string | null;
  enabled: boolean;
  /** When mail last came through this address; null until the first email. */
  last_received_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectEmailAddressInbox {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
}

export interface ProjectEmailAddressList {
  /** The domain a new address's routing address takes. */
  relay_domain: string;
  addresses: ProjectEmailAddress[];
  /** Inboxes an address can deliver to. */
  inboxes: ProjectEmailAddressInbox[];
}

export interface ProjectEmailAddressInput {
  inbox_id: string;
  routing_local_part: string;
  public_address: string | null;
  enabled: boolean;
}

/** Fired on window when inbox data may have changed (sidebar badge, open views). */
export const INBOX_UPDATED_EVENT = 'inbox-updated';

/**
 * The tables inbox views read from (communications schema, named
 * schema-qualified as live sync reports them): a cached inbox read goes stale
 * when any of them changes.
 */
export const INBOX_TABLES = [
  'communications.inboxes', 'communications.inbox_access', 'communications.client_domains', 'communications.client_addresses',
  'communications.endpoints', 'communications.conversations', 'communications.conversation_projects',
  'communications.messages', 'communications.participants', 'communications.message_candidates', 'communications.attachments',
  'communications.triage', 'communications.task_links',
] as const;
