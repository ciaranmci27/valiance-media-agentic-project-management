/**
 * What the Inbox UI reads and sends: the session routes under
 * /api/workspace/inbox and /api/workspace/email-inboxes return these, and
 * demo mode builds the same shapes from fixtures. Client-safe (no server
 * imports). Nothing here sends email: the Inbox is read-only by design.
 */

import type { CandidateReason } from './mapping';
import type { TriageCategory } from './outreach';

/**
 * Views (where a thread lives: Inbox, FYI, Updates, Codes, Filtered), then
 * filters: what waits on someone, wherever it lives, and the Inbox's handled
 * and unassigned threads.
 */
export const INBOX_VIEWS = ['all', 'fyi', 'updates', 'codes', 'ignored', 'everything'] as const;
export const INBOX_FILTERS = ['needs_you', 'needs_reply', 'new', 'handled', 'unassigned'] as const;
export const INBOX_TABS = [...INBOX_VIEWS, ...INBOX_FILTERS] as const;
export type InboxTab = typeof INBOX_TABS[number];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  all: 'Inbox',
  fyi: 'FYI',
  updates: 'Updates',
  codes: 'Codes',
  ignored: 'Filtered',
  everything: 'All',
  needs_you: 'Needs you',
  needs_reply: 'Needs reply',
  new: 'New',
  handled: 'Handled',
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

/** Where a conversation came in: an email thread, or a meeting (its transcript and notes). */
export type InboxChannel = 'email' | 'meeting';

/** Someone said a meeting asked for no new work. */
export interface MeetingDismissal {
  at: string;
  by: { id: string; name: string } | null;
}

/** What only a meeting has, as a list row shows it. */
export interface InboxMeetingSummary {
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  /** Who organized it: their address, and their name when an attendee row carries one. */
  organizer: { address: string; name: string } | null;
  /** The Google Doc with the notes or the transcript. */
  doc_url: string | null;
  dismissed: MeetingDismissal | null;
}

/** A meeting in thread detail: the summary plus everyone who was invited. */
export interface InboxMeeting extends InboxMeetingSummary {
  /** The organizer and guests, once each, organizer first. */
  attendees: { address: string; name: string }[];
}

/** Which package a meeting message is: the full transcript, or Gemini's notes. */
export type MeetingPackageKind = 'transcript' | 'notes';

/**
 * Read from the subject the meeting script gives each package
 * (meeting/ingest.ts meetingSubject): "Meeting transcript: ..." or
 * "Meeting summary: ...". Null for anything else.
 */
export function meetingPackageOf(subject: string | null | undefined): MeetingPackageKind | null {
  if (!subject) return null;
  if (subject.startsWith('Meeting transcript:')) return 'transcript';
  if (subject.startsWith('Meeting summary:')) return 'notes';
  return null;
}

export const MEETING_PACKAGE_LABELS: Record<MeetingPackageKind, string> = {
  transcript: 'Transcript',
  notes: "Gemini's notes",
};

export interface InboxSummary {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  handler: { id: string; name: string } | null;
  /** A personal inbox's person; null for a shared inbox. Shown as "Your inbox" or "<Name>'s inbox". */
  owner: { id: string; name: string } | null;
}

/** What an inbox is called to the person reading it: a personal one is "Your inbox" or "<Name>'s inbox". */
export function inboxDisplayName(inbox: Pick<InboxSummary, 'name' | 'owner'>, viewerId: string | null | undefined): string {
  if (!inbox.owner) return inbox.name;
  if (viewerId && inbox.owner.id === viewerId) return 'Your inbox';
  return `${inbox.owner.name}'s inbox`;
}

/** The one line a personal inbox's people see while Owners may read it. */
export const OWNERS_READ_PERSONAL_LINE = 'Owners in this workspace can read personal inboxes';

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
  channel: InboxChannel;
  /** A meeting's own details; null for email. */
  meeting: InboxMeetingSummary | null;
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
  /** The agent's suggestions still waiting for a person to add or skip (a meeting's checklist, a plan's proposals). */
  suggestion_count: number;
}

export type InboxTabCounts = Record<InboxTab, number>;

export interface InboxThreadList {
  inboxes: InboxSummary[];
  threads: InboxThreadSummary[];
  total: number;
  counts: InboxTabCounts;
  /** The newest one-time code, while it is fresh (CODE_PIN_MINUTES): pinned at the top of the Inbox. */
  latest_code: InboxLatestCode | null;
  /** A personal inbox is listed and the workspace lets Owners read personal inboxes: the Inbox says so. */
  owners_read_personal?: boolean;
}

export interface InboxLatestCode {
  thread_id: string;
  sender: { name: string; address: string } | null;
  /** Null when neither the subject nor the text shows it: open the email. */
  code: string | null;
  received_at: string;
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

/** A decision the agent needs, with the choices it offers and the one it would pick. */
export interface InboxQuestion {
  question: string;
  why?: string | null;
  options: { label: string; detail?: string | null }[];
  /** Index into options. */
  recommended: number;
}

export interface InboxTriage {
  id: string;
  outcome: TriageOutcome;
  urgent: boolean;
  summary: string;
  question_for_human: string | null;
  /** The decisions behind question_for_human, answered together; null on older triage. */
  questions: InboxQuestion[] | null;
  suggested_reply: string | null;
  /** What the agent read it as; outreach is a pitch it filtered (or a guardrail kept). */
  category: TriageCategory | null;
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
  channel: InboxChannel;
  /** A meeting message: which package it is. Null for email. */
  meeting_package: MeetingPackageKind | null;
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
  /** A filtered pitch from a sender who pitched before and no rule filters yet. */
  repeat_pitch: boolean;
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
  state: 'applying' | 'done' | 'failed' | 'pending' | 'accepting' | 'accepted' | 'dismissed' | 'expired' | 'undone' | 'skipped';
  /** What it does, in a line: "New task: Add the size chart". */
  label: string;
  /** The words or attachment that justify it. */
  evidence: string | null;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  error: string | null;
  /** What it would add, in full: a comment's text, a new task's description, a reminder's notes. */
  body?: string | null;
  /** A suggested task or reminder's own title and a task's due date: what Change starts from. */
  title?: string | null;
  due_date?: string | null;
  /** A suggested reminder's day (YYYY-MM-DD), when it has one. */
  remind_on?: string | null;
  /** The task or reminder it made is finished since: it reads as done, with nothing to wave off. */
  target_done?: boolean;
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

/** How a candidate's reason reads in the UI ("matched by contact and sender address"). */
export const CANDIDATE_REASON_LABELS: Record<CandidateReason, string> = {
  contact: 'contact',
  domain: 'sender domain',
  sender: 'sender address',
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
  /**
   * The viewer may act on this thread (file it, mark it handled, send it back,
   * settle the agent's work): triage is per inbox. Left out by the demo and
   * older servers, where the role decides.
   */
  can_triage?: boolean;
  inbox: InboxSummary;
  channel: InboxChannel;
  /** A meeting's own details; null for email. */
  meeting: InboxMeeting | null;
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
  /** When a person first copied it; copied and then handled, it is taken as the reply that went out. */
  copied_at: string | null;
}

/** A reminder that came from an email (reminders.source_message_id). */
export interface InboxReminder {
  id: string;
  title: string;
  remind_on: string | null;
  status: 'open' | 'done';
  task_id: string | null;
  /** The viewer's own reminder (marking the thread handled closes their "Reply to ..." ones). */
  mine?: boolean;
  /** Who set it: an agent's reminder can be waved off as "Not needed". */
  created_by?: string | null;
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
  channel: InboxChannel;
  /** The meeting's title and start, for a meeting message; null for email. */
  meeting_title: string | null;
  meeting_starts_at: string | null;
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

/** "Add all" on a meeting: every waiting suggestion accepted, as the person's. */
export interface MeetingAddAllResult {
  /** The suggestions it added, in the order it added them (Undo goes in reverse). */
  added: string[];
  /** Ones that did not go through (a task gone since, no access): still waiting. */
  failed: { id: string; label: string; error: string }[];
}

/** A message "Nothing to do" marked handled, and the state it had before, for Undo. */
export interface MeetingHandledMessage {
  id: string;
  status: 'new' | 'needs_human' | 'handled';
  /** It had not been reviewed yet: Undo clears the review again. */
  unreviewed: boolean;
}

/**
 * "Nothing to do" on a meeting: what it skipped and handled, and the mark.
 * Nothing is created or trashed: the agent only suggests from a meeting.
 */
export interface MeetingDismissResult {
  /** The waiting suggestions (and any open question) it skipped. */
  skipped: string[];
  handled: MeetingHandledMessage[];
  dismissed: MeetingDismissal;
}

/** What Undo sends back: the same suggestions and messages, to put back as they were. */
export interface MeetingDismissUndo {
  skipped: string[];
  handled: MeetingHandledMessage[];
}

/**
 * What one "Undo all" on the agent's work took back, so "Restore all" can put
 * exactly that back: the plan items it undid, the tasks and reminders the
 * agent made that went to Trash, the links it removed, and what stayed.
 */
export interface AgentWorkUndo {
  plan_items: string[];
  tasks: string[];
  reminders: string[];
  links: { message_id: string; task_id: string; relation: TaskLinkRelation; triage_id: string | null; linked_by: string | null }[];
  /** What stayed as it was, and why ("done, so it stays"). */
  kept: { label: string; reason: string }[];
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
  /** A personal inbox's person; null for a shared inbox. */
  owner_member_id: string | null;
}

/**
 * A personal inbox as those who manage inboxes see it in Settings: that it
 * exists and how it is doing, never its mail, its routing or who reads it.
 */
export interface PersonalInboxHealth {
  id: string;
  name: string;
  address: string;
  owner: { id: string; name: string } | null;
  enabled: boolean;
  verified_at: string | null;
  last_received_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  message_count: number;
  created_at: string;
}

export interface InboxSettingsList {
  relay_domain: string;
  /** Shared inboxes (no owner), in full. */
  inboxes: InboxSettings[];
  /** Every personal inbox's health. Left out by older servers and the demo. */
  personal?: PersonalInboxHealth[];
  /** business_settings.owners_read_personal_inboxes. */
  owners_read_personal?: boolean;
}

/** Settings > Email > Your inbox: the signed-in person's own personal inboxes. */
export interface MyInboxList {
  relay_domain: string;
  inboxes: InboxSettings[];
  /** While true, every personal inbox's settings say Owners can read it. */
  owners_read_personal: boolean;
}

/** Connecting or changing one of your own inboxes. */
export interface MyInboxInput {
  address: string;
  handler_member_id: string | null;
  enabled: boolean;
  access_member_ids: string[];
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
  /** What clients write to, e.g. ciaran@plan4thefuture.com; mail to it reads as written to us. */
  public_address: string | null;
  /** Whose address it is: a person, or the company when null. */
  owner_member_id: string | null;
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

/**
 * One of your addresses (Settings > Email > Your addresses): mail comes in on
 * it and reads as written to you or the company. With a project, everything
 * sent to it is that project's, through its own relay address.
 */
export interface YourAddress {
  id: string;
  /** What people write to; the relay address when it has no public one. */
  address: string;
  project_id: string | null;
  /** Whose it is: a person, or the company when null. */
  owner_member_id: string | null;
  /** Its own relay address; null when it forwards to the inbox's. */
  routing_address: string | null;
  inbox_id: string;
  enabled: boolean;
  last_received_at: string | null;
}

/** An address of ours that mail arrived on but nobody listed yet. */
export interface UnlistedAddress {
  address: string;
  messages: number;
  last_seen: string;
  /** The inbox its latest mail arrived at: add it there. */
  inbox_id: string;
}

/** A domain of yours: any address on it reads as written to you, listed or not. */
export interface OwnDomain {
  id: string;
  domain: string;
  created_at: string;
}

/** An inbox an address can deliver to: where its forwarder points, and who handles it. */
export interface YourAddressInbox {
  id: string;
  name: string;
  routing_address: string;
  enabled: boolean;
  handler_member_id: string | null;
}

/** Unlisted addresses on one domain that is not yours yet (or is, with addresses to name). */
export interface UnlistedDomain {
  domain: string;
  addresses: UnlistedAddress[];
}

export interface YourAddressList {
  addresses: YourAddress[];
  domains: OwnDomain[];
  inboxes: YourAddressInbox[];
  /** Asked for with review: addresses mail arrived on, by domain, that nobody listed or dismissed. */
  unlisted: UnlistedDomain[];
  relay_domain: string;
}

/** A new one of your addresses; owner_member_id null is the company. inbox_id defaults to the first enabled inbox. */
export interface YourAddressInput {
  address: string;
  project_id: string | null;
  owner_member_id: string | null;
  inbox_id?: string;
}

export type YourAddressPatchInput = Partial<Pick<YourAddress, 'project_id' | 'owner_member_id' | 'enabled' | 'inbox_id'>>;

export interface ProjectEmailAddressInput {
  inbox_id: string;
  routing_local_part: string;
  public_address: string | null;
  enabled: boolean;
}

/** Fired on window when inbox data may have changed (sidebar badge, open views). */
export const INBOX_UPDATED_EVENT = 'inbox-updated';

/**
 * The tables inbox views read from (in pm since 2.0, labelled
 * communications.<name> as live sync reports them): a cached inbox read goes stale
 * when any of them changes.
 */
export const INBOX_TABLES = [
  'communications.inboxes', 'communications.inbox_access', 'communications.client_domains', 'communications.client_addresses',
  'communications.endpoints', 'communications.conversations', 'communications.conversation_projects',
  'communications.messages', 'communications.participants', 'communications.message_candidates', 'communications.attachments',
  'communications.triage', 'communications.task_links', 'communications.meetings',
  // Suggestions and replies owed: an Add, Skip or undo anywhere updates an open thread.
  'communications.plans', 'communications.plan_items', 'communications.reply_points',
] as const;
