import type { InvoicePdfData, InvoicePdfOptions } from '@/lib/invoice-pdf/types';

export const CONTACT_ROLES = ['Client', 'Primary Contact', 'Technical Contact', 'Billing Contact', 'Stakeholder', 'Other'] as const;
export type ContactRole = typeof CONTACT_ROLES[number];

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  status: 'active' | 'completed' | 'archived';
  start_date: string | null;
  due_date: string | null;
  hourly_tracking: boolean;
  hourly_rate: number | null;
  time_tracking_enabled?: boolean;
  client_time_billing?: 'hourly' | 'included';
  budget_type: 'hours' | 'amount' | null;
  budget_value: number | null;
  autonomous_enabled: boolean;
  /** May the merge gate auto-merge green contained PRs on this project. */
  auto_merge_enabled: boolean;
  /** Where the dev agent clones, branches, and PRs; the only legal merge target. */
  integration_branch: string;
  /** Declared ship-to-users branch; the merge gate refuses it unconditionally. */
  production_branch: string;
  /** Max suggestions awaiting review (pending + needs_info) before the auditor pauses. */
  suggestion_queue_cap: number;
  /** Minimum hours between audit cycles on this project. */
  audit_interval_hours: number;
  // Case-insensitive regex over changed file paths; matches never auto-merge.
  // One source of truth shared by the merge gate and the app's lane forecasts.
  sensitive_paths?: string;
  suggestions_per_cycle: number;
  repo_path: string | null;
  billing_address?: string | null;
  billing_email?: string | null;
  tax_rate?: number | null;
  /** Per-project PDF rendering toggles. Optional in app types since older
   *  rows / demo data may not have it; readers should merge with
   *  DEFAULT_INVOICE_PDF_OPTIONS. */
  invoice_pdf_options?: InvoicePdfOptions;
  member_ids: string[];
  created_by?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** One row in the analytics exclusion list. Admin-managed list of IPs that
 *  should be filtered out of portal analytics by default — typically team
 *  members' home/office IPs and known dev environments. The label is free
 *  text so admins can tell entries apart in the settings UI. */
export interface ExcludedIp {
  ip: string;
  label: string;
}

export interface BusinessSettings {
  id: string;
  business_name: string;
  business_address: string;
  business_email: string;
  business_phone: string;
  payment_terms: string;
  payment_instructions: string;
  default_invoice_notes: string;
  excluded_ips: ExcludedIp[];
  api_enabled?: boolean;
  auto_approve_human_hours?: boolean;  // Default true; agent hours always queue for review
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  color: string;
  avatar_url: string;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectContact {
  id: string;
  project_id: string;
  contact_id: string;
  role: string;
  custom_role: string | null;
  is_primary_client: boolean;
  created_at: string;
  contact?: Contact;
}

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  source: 'referral' | 'website' | 'social' | 'cold_outreach' | 'event' | 'network' | 'other';
  status: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
  notes: string;
  assigned_to: string | null;
  member_ids: string[];
  contact_id: string | null;
  created_by?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export const LEAD_INTERACTION_TYPES = ['call', 'email', 'meeting', 'note', 'follow_up'] as const;
export type LeadInteractionType = typeof LEAD_INTERACTION_TYPES[number];

export interface LeadInteraction {
  id: string;
  lead_id: string;
  type: LeadInteractionType;
  title: string;
  description: string;
  occurred_at: string;
  scheduled_at: string | null;
  completed: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export const LEAD_PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'rejected'] as const;
export type LeadProposalStatus = typeof LEAD_PROPOSAL_STATUSES[number];

export interface LeadProposal {
  id: string;
  lead_id: string;
  title: string;
  description: string;
  estimated_value: number | null;
  status: LeadProposalStatus;
  sent_at: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// LEAD FIELDS
// ============================================================

export type LeadFieldType = 'text' | 'url' | 'textarea' | 'select' | 'multi_select';
export type LeadFieldCategory = 'Business Identity' | 'Opportunity' | 'Assessment' | 'Strategy';

export interface LeadFieldDefinition {
  key: string;
  label: string;
  type: LeadFieldType;
  category: LeadFieldCategory;
  options?: string[];
  allowCustom?: boolean;
  placeholder?: string;
}

export const LEAD_FIELD_DEFINITIONS: LeadFieldDefinition[] = [
  // Business Identity
  { key: 'website', label: 'Website', type: 'url', category: 'Business Identity', placeholder: 'https://example.com' },
  { key: 'industry', label: 'Industry', type: 'select', category: 'Business Identity', options: ['Tech', 'Healthcare', 'Retail', 'Hospitality', 'Real Estate', 'F&B', 'Entertainment', 'Education', 'Nonprofit', 'Professional Services', 'Construction', 'Fitness/Wellness', 'Automotive', 'Legal', 'Other'] },
  { key: 'product_service', label: 'Product / Service', type: 'text', category: 'Business Identity', placeholder: 'What they sell or provide' },
  { key: 'location', label: 'Location', type: 'text', category: 'Business Identity', placeholder: 'City, State' },

  // Opportunity
  { key: 'services_interested', label: 'Services Interested In', type: 'multi_select', category: 'Opportunity', options: ['Branding', 'Web Design', 'Web Dev', 'Social Media', 'Video', 'SEO', 'Paid Ads', 'Content Marketing', 'Email Marketing', 'Print Design', 'Photography', 'Consulting', 'Other'] },
  { key: 'budget_range', label: 'Budget Range', type: 'select', category: 'Opportunity', options: ['Under $1K', '$1K-$5K', '$5K-$15K', '$15K-$50K', '$50K-$100K', '$100K+'] },
  { key: 'timeline', label: 'Timeline', type: 'select', category: 'Opportunity', options: ['Immediate', '1-3 Months', '3-6 Months', '6+ Months', 'Exploratory'] },
  { key: 'referred_by', label: 'Referred By', type: 'text', category: 'Opportunity', placeholder: 'Name or source' },

  // Assessment
  { key: 'priority', label: 'Priority', type: 'select', category: 'Assessment', options: ['Hot', 'Warm', 'Cold'] },
  { key: 'pros', label: 'Pros', type: 'multi_select', category: 'Assessment', allowCustom: true, options: ['Clear Vision', 'Good Budget', 'Long-term Potential', 'Quick Decision Maker', 'Aligned Values', 'Exciting Brand', 'Growth Trajectory', 'Easy to Work With'] },
  { key: 'cons', label: 'Cons', type: 'multi_select', category: 'Assessment', allowCustom: true, options: ['Unclear Requirements', 'Low Budget', 'Difficult Timeline', 'Too Many Stakeholders', 'Scope Creep Risk', 'Unrealistic Expectations', 'Poor Communication', 'High Maintenance'] },

  // Strategy
  { key: 'goals', label: 'Goals', type: 'textarea', category: 'Strategy', placeholder: 'What are they trying to achieve?' },
  { key: 'pain_points', label: 'Pain Points', type: 'textarea', category: 'Strategy', placeholder: 'What problems are they facing?' },
  { key: 'first_analysis', label: 'First Analysis', type: 'textarea', category: 'Strategy', placeholder: 'Initial assessment and observations' },
];

export interface LeadField {
  id: string;
  lead_id: string;
  field_key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export interface LeadContact {
  id: string;
  lead_id: string;
  contact_id: string;
  role: string;
  custom_role: string | null;
  is_primary_client: boolean;
  created_at: string;
  contact?: Contact;
}

export const TASK_TYPES = ['engineering', 'research', 'audit', 'marketing', 'copywriting', 'operations', 'general'] as const;
export type TaskType = typeof TASK_TYPES[number];

export const AI_READINESS = ['ai_ready', 'human_only', 'hybrid'] as const;
export type AiReadiness = typeof AI_READINESS[number];

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_ids: string[];
  due_date: string | null;
  tags: string[];
  subtasks: Subtask[];
  comments: Comment[];
  sort_order?: number;
  task_type?: TaskType | null;
  ai_readiness?: AiReadiness | null;
  acceptance_criteria: AcceptanceCriterion[];
  /** Independent PR review rounds, newest last. Absent outside review flows. */
  reviews?: TaskReview[];
  blocked_by_ids: string[];
  created_by?: string | null;
  project_goal_id?: string | null;
  source_task_suggestion_id?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Subtask {
  id: string;
  task_id?: string;
  title: string;
  completed: boolean;
  sort_order?: number;
}

/**
 * One independent PR review round (written by the reviewer agent through the
 * v1 API). The newest row for a task is its current verdict; head_sha pins
 * the verdict to the exact commit reviewed.
 */
export interface TaskReview {
  id: string;
  task_id?: string;
  round: number;
  verdict: 'approved' | 'changes_requested';
  summary: string | null;
  pr_url: string | null;
  head_sha: string | null;
  reviewer_member_id: string | null;
  created_at: string;
}

export interface AcceptanceCriterion {
  id: string;
  task_id?: string;
  criterion: string;
  satisfied: boolean;
  sort_order?: number;
}

export interface Comment {
  id: string;
  task_id?: string;
  user_id: string;
  text: string;
  created_at: string;
}

// ============================================================
// NOTIFICATION PREFERENCES
// ============================================================

export type NotificationCategory =
  | 'task_created'
  | 'task_deleted'
  | 'task_status'
  | 'task_assignments'
  | 'task_updates'
  | 'task_subtasks'
  | 'task_comments'
  | 'project_created'
  | 'project_deleted'
  | 'project_updates'
  | 'project_contacts'
  | 'lead_created'
  | 'lead_deleted'
  | 'lead_status'
  | 'lead_updates'
  | 'lead_interactions'
  | 'lead_proposals'
  | 'lead_contacts'
  | 'lead_conversions'
  | 'contact_created'
  | 'contact_deleted'
  | 'contact_updates'
  | 'team_members'
  | 'portal_updates'
  | 'portal_settings'
  | 'time_entries'
  | 'entity_files'
  | 'api_keys'
  | 'agent_suggestions'
  | 'agent_activity'
  | 'agent_goals'
  | 'agent_autonomous';

export type NotificationPreferences = Partial<Record<NotificationCategory, boolean>>;

export interface TeamMember {
  id: string;
  auth_user_id?: string | null;
  name: string;
  email: string;
  avatar: string;
  role: 'owner' | 'admin' | 'member' | 'guest' | 'agent';
  /** Display title ("Auditor", "Developer") shown wherever the member acts. */
  title?: string | null;
  status?: 'active' | 'suspended';
  suspended_at?: string | null;
  suspended_by?: string | null;
  timezone?: string;
  notification_prefs?: NotificationPreferences;
  email_notifications_enabled?: boolean;
  email_notification_prefs?: NotificationPreferences;
  /** Explicit light/dark choice. null/undefined = follow the OS preference. */
  theme_preference?: 'light' | 'dark' | null;
  /** Multiplier applied to this member's time-entry rate snapshots (1.00 = parity). */
  billing_multiplier?: number;
}

export interface FilterState {
  status: string[];
  priority: string[];
  assigneeIds: string[];
  tags: string[];
  search: string;
}

export type ViewMode = 'list' | 'board' | 'calendar';

export interface Activity {
  id: string;
  type: 'task_completed' | 'task_updated' | 'task_created' | 'comment_added' | 'project_updated' | 'member_added';
  entity_id: string;
  entity_type: 'task' | 'project' | 'comment' | 'member';
  user_id: string;
  description: string;
  metadata?: Record<string, any>;
  created_at: string;
}

// ============================================================
// TIME ENTRIES
// ============================================================

/**
 * A single worked interval within a time entry. A timer that is paused and
 * later resumed produces multiple segments. The last segment's `end` is null
 * only when the timer is actively running.
 */
export interface TimeSegment {
  start: string;        // ISO datetime
  end: string | null;   // ISO datetime, or null if this segment is still open
}

export interface TimeEntry {
  id: string;
  project_id: string;
  member_id: string;
  start_time: string;       // ISO datetime (denormalized: first segment's start)
  end_time: string | null;  // ISO datetime (denormalized: last segment's end), null while unfinalized
  segments: TimeSegment[];  // Individual worked intervals; sum gives total worked time
  hourly_rate?: number;     // Immutable rate selected from this session's start time
  compensation_rate?: number;
  work_type?: 'client' | 'internal';
  approval_status?: 'draft' | 'pending' | 'approved' | 'rejected';
  submitted_at?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  rejection_reason?: string | null;
  description: string;
  task_ids?: string[];  // Tasks this session was spent on (one session can span several)
  billing_multiplier?: number;  // Snapshot at session start; agent sessions are converted at approval
  billing_converted_at?: string | null;  // Stamped when the agent billing conversion ran (single-shot)
  raw_time_snapshot?: {  // Immutable raw clock data captured before agent billing conversion
    version: number;
    start_time: string;
    end_time: string;
    segments: TimeSegment[];
    worked_ms: number;
    captured_at: string;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectHourlyRate {
  id: string;
  project_id: string;
  hourly_rate: number;
  effective_at: string;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTimeEntryAllocation {
  id?: string;
  invoice_id?: string;
  line_item_id: string;
  time_entry_id: string;
  /** Worked-hours offset where this billed slice begins within the session. */
  start_offset_hours: number;
  allocated_hours: number;
  allocated_amount: number;
  created_at?: string;
}

// ============================================================
// PROJECT INVOICES
// ============================================================

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const;
export type InvoiceStatus = typeof INVOICE_STATUSES[number];

export const INVOICE_TYPES = ['hourly', 'fixed', 'recurring'] as const;
export type InvoiceType = typeof INVOICE_TYPES[number];
export const INVOICE_LINE_ITEM_TYPES = ['hourly', 'fixed', 'recurring', 'reimbursement'] as const;
export type InvoiceLineItemType = typeof INVOICE_LINE_ITEM_TYPES[number];

export const RECURRENCE_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'annual'] as const;
export type RecurrenceFrequency = typeof RECURRENCE_FREQUENCIES[number];

export interface InvoiceLineItem {
  id: string;
  position: number;
  item_type: InvoiceLineItemType;
  amount: number;
  description: string;
  /** Inclusive YYYY-MM-DD; null means single-day (falls on parent invoice date). */
  service_start_date: string | null;
  service_end_date: string | null;
  /** Informational; the actual revenue spread uses service_start/end. */
  recurrence_frequency: RecurrenceFrequency | null;
}

export interface ProjectInvoice {
  id: string;
  project_id: string;
  invoice_number: string;
  amount: number;
  status: InvoiceStatus;
  /** Dominant line-item type by amount. Kept for back-compat with filters. */
  invoice_type: InvoiceType;
  line_items: InvoiceLineItem[];
  /** Persisted FIFO result for generated hourly line items. */
  time_allocations?: InvoiceTimeEntryAllocation[];
  date: string;
  due_date: string | null;
  paid_date: string | null;
  description: string;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// CLIENT PORTAL
// ============================================================

export type PortalSectionKey = 'show_progress' | 'show_hours' | 'show_updates' | 'show_files' | 'show_credentials' | 'show_invoices';

export const DEFAULT_SECTION_ORDER: PortalSectionKey[] = [
  'show_progress', 'show_hours', 'show_updates', 'show_files', 'show_credentials', 'show_invoices',
];

export const PORTAL_SECTION_LABELS: Record<PortalSectionKey, string> = {
  show_progress: 'Progress',
  show_hours: 'Hours',
  show_updates: 'Updates',
  show_files: 'Files',
  show_credentials: 'Credentials',
  show_invoices: 'Invoices',
};

export interface PortalSettings {
  id: string;
  project_id: string;
  enabled: boolean;
  token: string;
  pin: string | null;
  welcome_message: string;
  logo_url: string;
  accent_color: string;
  show_progress: boolean;
  show_files: boolean;
  show_hours: boolean;
  show_updates: boolean;
  show_credentials: boolean;
  show_invoices: boolean;
  section_order: PortalSectionKey[];
  notification_thresholds: number[];
  alert_mode: AlertMode;
  dollar_interval: number | null;
  require_alert_approval: boolean;
  rearm_thresholds_on_budget_change: boolean;
  created_at: string;
  updated_at: string;
}

export const ALERT_MODES = ['percentage', 'dollar_interval', 'none'] as const;
export type AlertMode = typeof ALERT_MODES[number];

export const CLIENT_COMM_TYPES = [
  'portal_welcome',
  'project_summary',
  'invoice',
  'budget_threshold',
  'dollar_interval',
  'budget_extended',
] as const;
export type ClientCommType = typeof CLIENT_COMM_TYPES[number];

export const CLIENT_COMM_STATUSES = ['pending', 'sent', 'failed', 'dismissed'] as const;
export type ClientCommStatus = typeof CLIENT_COMM_STATUSES[number];

export interface ClientCommRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface ClientCommunication {
  id: string;
  project_id: string;
  contact_id: string;
  notification_type: ClientCommType;
  status: ClientCommStatus;
  subject: string | null;
  rendered_html: string | null;
  slot_overrides: Record<string, string>;
  metadata: Record<string, any>;
  recipients: ClientCommRecipients;
  triggered_by: string | null;
  sent_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  contact?: { id: string; name: string; email: string };
}

export interface ProjectBudgetHistoryEntry {
  id: string;
  project_id: string;
  old_type: 'hours' | 'amount' | null;
  new_type: 'hours' | 'amount' | null;
  old_value: number | null;
  new_value: number | null;
  changed_by: string | null;
  created_at: string;
}

export const PORTAL_UPDATE_TYPES = ['general', 'milestone', 'deliverable', 'note'] as const;
export type PortalUpdateType = typeof PORTAL_UPDATE_TYPES[number];

export interface PortalUpdate {
  id: string;
  project_id: string;
  title: string;
  content: string;
  update_type: PortalUpdateType;
  author_id: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface PortalUpdateAttachment {
  id: string;
  update_id: string;
  name: string;
  file_url: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// PORTAL ANALYTICS
// ============================================================

export const PORTAL_EVENT_TYPES = [
  'portal_view',
  'pin_attempt',
  'section_view',
  'file_preview',
  'file_download',
  'invoice_view',
  'invoice_pdf_download',
  'credential_submit',
  'heartbeat',
] as const;
export type PortalEventType = typeof PORTAL_EVENT_TYPES[number];

/** Client-reported context attached to the first event of a session. Trusted
 *  for display only; never used for authorization. */
export interface PortalEventClientContext {
  timezone?: string | null;
  language?: string | null;
  screen_width?: number | null;
  screen_height?: number | null;
  viewport_width?: number | null;
  viewport_height?: number | null;
  connection_type?: string | null;
  color_scheme?: 'light' | 'dark' | null;
  reduced_motion?: boolean | null;
}

export interface PortalEvent {
  id: string;
  portal_settings_id: string;
  project_id: string;
  session_id: string;
  event_type: PortalEventType;
  ip_address: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  referrer: string | null;
  device_type: 'mobile' | 'tablet' | 'desktop' | null;
  browser: string | null;
  os: string | null;
  accept_language: string | null;
  timezone: string | null;
  language: string | null;
  screen_width: number | null;
  screen_height: number | null;
  viewport_width: number | null;
  viewport_height: number | null;
  connection_type: string | null;
  color_scheme: string | null;
  reduced_motion: boolean | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PortalSessionSummary {
  session_id: string;
  portal_settings_id: string;
  project_id: string;
  started_at: string;
  last_seen_at: string;
  duration_seconds: number;
  event_count: number;
  views: number;
  files_downloaded: number;
  files_previewed: number;
  invoices_viewed: number;
  invoice_pdfs_downloaded: number;
  sections_viewed: number;
  credentials_submitted: number;
  pin_failures: number;
  had_failed_pin: boolean;
  ip_address: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  referrer: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  accept_language: string | null;
  timezone: string | null;
  language: string | null;
  screen_width: number | null;
  screen_height: number | null;
  viewport_width: number | null;
  viewport_height: number | null;
  connection_type: string | null;
  color_scheme: string | null;
  reduced_motion: boolean | null;
}

/** Aggregated analytics payload returned to the admin dashboard. */
export interface PortalAnalyticsResponse {
  range_days: number;
  totals: {
    total_events: number;
    total_sessions: number;
    unique_ip_hashes: number;
    last_seen_at: string | null;
    avg_duration_seconds: number;
    total_pin_failures: number;
  };
  views_by_day: { date: string; views: number; sessions: number }[];
  sessions: PortalSessionSummary[];
  top_sections: { section: string; views: number }[];
  top_files: { file_id: string; name: string | null; mime_type: string | null; previews: number; downloads: number }[];
  top_invoices: { invoice_id: string; invoice_number: string | null; amount: number | null; views: number; pdf_downloads: number }[];
  pin_failures: {
    created_at: string;
    ip_address: string | null;
    ip_hash: string | null;
    user_agent: string | null;
    country_hint: string | null;
  }[];
}

// ============================================================
// ENTITY FILES (polymorphic attachments)
// ============================================================

export type EntityFileType = 'lead' | 'project' | 'contact';
export type EntityFileVisibility = 'internal' | 'external';

export interface EntityFile {
  id: string;
  entity_type: EntityFileType;
  entity_id: string;
  name: string;
  file_url: string;
  file_size: number;
  mime_type: string;
  visibility: EntityFileVisibility;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// NOTIFICATIONS
// ============================================================

export type NotificationEntityType = 'task' | 'project' | 'lead' | 'comment' | 'member' | 'contact' | 'suggestion' | 'goal';

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string | null;
  link: string | null;
  is_read: boolean;
  entity_type: NotificationEntityType | null;
  entity_id: string | null;
  created_at: string;
}

// ============================================================
// API KEYS
// ============================================================

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  permissions: 'full' | 'read_only' | 'scoped';
  scopes?: string[];
  expires_at?: string | null;
  disabled_at?: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  team_member_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RolePermission {
  role: 'admin' | 'member' | 'guest' | 'agent';
  permission_key: string;
  access_channel: 'app' | 'api';
  created_at: string;
  updated_at: string;
}

// ============================================================
// WEBHOOKS (generic outbound platform)
// ============================================================

export const WEBHOOK_EVENT_TYPES = ['invoice.paid', 'invoice.updated', 'invoice.deleted'] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivering', 'succeeded', 'failed'] as const;
export type WebhookDeliveryStatus = typeof WEBHOOK_DELIVERY_STATUSES[number];

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  /** Signing secret (whsec_...). Stored retrievably: needed to configure the receiver. */
  secret: string;
  events: string[];
  is_active: boolean;
  description: string;
  created_by: string | null;
  last_delivery_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_event_id: string;
  endpoint_id: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from webhook_events for display. */
  webhook_events?: { event_id: string; event_type: string; created_at: string } | null;
}

export interface TeamMemberPermission {
  member_id: string;
  permission_key: string;
  access_channel: 'app' | 'api';
  effect: 'allow' | 'deny';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberHourlyRate {
  id: string;
  member_id: string;
  hourly_rate: number;
  effective_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberEarningAdjustment {
  id: string;
  member_id: string;
  adjustment_type: 'bonus' | 'deduction';
  amount: number;
  effective_date: string;
  project_id: string | null;
  description: string;
  created_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberPayout {
  id: string;
  member_id: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  reference: string;
  notes: string;
  created_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberPayoutAllocation {
  id: string;
  payout_id: string;
  time_entry_id: string | null;
  adjustment_id: string | null;
  allocated_amount: number;
  created_at: string;
}

export interface EmployeeEarningsData {
  entries: TimeEntry[];
  rates: TeamMemberHourlyRate[];
  adjustments: TeamMemberEarningAdjustment[];
  payouts: TeamMemberPayout[];
  allocations: TeamMemberPayoutAllocation[];
}

// ============================================================
// PROJECT GOALS
// ============================================================

export interface ProjectGoal {
  id: string;
  project_id: string;
  title: string;
  description: string;
  target_date: string | null;
  status: 'active' | 'achieved' | 'paused' | 'abandoned';
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// TASK SUGGESTIONS
// ============================================================

export interface TaskSuggestion {
  id: string;
  project_id: string;
  goal_id: string;
  proposed_by: string;
  assigned_to: string | null;
  title: string;
  description: string;
  reasoning: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  effort_estimate: 'small' | 'medium' | 'large' | null;
  task_type?: TaskType | null;
  status: 'pending' | 'needs_info' | 'approved' | 'rejected' | 'declined';
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  info_request: string | null;
  converted_task_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

// ============================================================
// AGENT ACTIVITY
// ============================================================

export interface AgentActivity {
  id: string;
  agent_id: string;
  project_id: string | null;
  activity_type: 'suggestion_created' | 'task_started' | 'task_completed' | 'task_failed' | 'research_started' | 'research_completed' | 'suggestion_reviewed' | 'comment_added' | 'status_changed' | 'agent_spawned' | 'agent_completed' | 'agent_failed' | 'heartbeat' | 'system_check' | 'custom';
  title: string;
  description: string;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

// ============================================================
// API AUDIT LOG
// ============================================================

export interface ApiAuditEntry {
  id: string;
  timestamp: string;
  method: string;
  endpoint: string;
  entity_type: string | null;
  entity_id: string | null;
  api_key_id: string | null;
  team_member_id: string | null;
  request_body: Record<string, any> | null;
  before_snapshot: Record<string, any> | null;
  after_snapshot: Record<string, any> | null;
  status_code: number;
  error: string | null;
}

// ============================================================
// PROJECT CONTEXT
// ============================================================

export const PROJECT_CONTEXT_CATEGORIES = ['business_context', 'lesson_learned', 'technical_decision', 'constraint', 'existing_work'] as const;
export type ProjectContextCategory = typeof PROJECT_CONTEXT_CATEGORIES[number];

export const PROJECT_CONTEXT_SOURCES = ['human', 'agent', 'scan'] as const;
export type ProjectContextSource = typeof PROJECT_CONTEXT_SOURCES[number];

export interface ProjectContext {
  id: string;
  project_id: string;
  category: ProjectContextCategory;
  content: string;
  source: ProjectContextSource;
  file_path: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PortalData {
  project: {
    name: string;
    color: string;
    description: string;
    start_date: string | null;
    due_date: string | null;
    status: string;
  };
  settings: {
    welcome_message: string;
    logo_url: string;
    accent_color: string;
    show_progress: boolean;
    show_files: boolean;
    show_hours: boolean;
    show_updates: boolean;
    show_credentials: boolean;
    show_invoices: boolean;
    section_order: PortalSectionKey[];
  };
  progress: {
    percent: number;
    days_remaining: number | null;
    is_overdue: boolean;
  };
  files: {
    id: string;
    name: string;
    file_url: string;
    file_size: number;
    mime_type: string;
  }[];
  hours: {
    total_hours: number;
    entries: {
      id: string;
      start_time: string;
      end_time: string;
      hours: number;
      // Seconds of pause time within [start_time, end_time]. Always 0 for
      // single-segment entries; populated when pause/resume was used so the
      // client can reconcile the visible span against the worked hours.
      paused_seconds: number;
      // Individual worked intervals. Always length >= 1. For single-segment
      // entries there's one segment spanning start_time → end_time. For
      // multi-segment entries the frontend renders a per-session breakdown
      // with pause labels between segments. Portal only returns completed
      // entries, so every segment has a non-null end.
      segments: { start: string; end: string }[];
      description: string;
      member_name: string;
      // FIFO payment status against paid hourly line items. Null when the
      // project isn't hourly or has no rate set; the portal only renders
      // the badge on hourly projects.
      payment_status: 'paid' | 'partial' | 'unpaid' | null;
    }[];
  };
  updates: {
    id: string;
    title: string;
    content: string;
    update_type: PortalUpdateType;
    author_name: string;
    pinned: boolean;
    created_at: string;
    attachments: { id: string; name: string; file_url: string; file_size: number; mime_type: string }[];
  }[];
  billing: {
    hourly_tracking: boolean;
    hourly_rate: number;
    total_hours: number;
    billable_total: number;
  } | null;
  invoices: {
    id: string;
    invoice_number: string;
    amount: number;
    status: string;
    invoice_type: string;
    line_items: InvoiceLineItem[];
    date: string;
    due_date: string | null;
    paid_date: string | null;
    description: string;
    file_url: string | null;
    file_name: string | null;
    file_size: number | null;
    mime_type: string | null;
  }[];
  /** Server-built PDF data for each visible invoice, keyed by invoice id.
   *  Empty when invoices aren't shown. Lets the portal preview the same
   *  invoice PDF the admin sees, without requiring AppProvider/useApp(). */
  invoice_pdfs: Record<string, InvoicePdfData>;
  invoice_pdf_errors?: Record<string, string>;
  credentials_submitted_count: number;
  credentials_submitted: {
    id: string;
    label: string;
    category: CredentialCategory;
    created_at: string;
    updated_at: string;
  }[];
}

// ============================================================
// PROJECT CREDENTIALS
// ============================================================

// Each category has its own input fields (see lib/credential-fields.ts).
// Anything that is just username+password+url belongs under 'login'.
export const CREDENTIAL_CATEGORIES = [
  'login', 'api_key', 'ssh_key', 'database', 'credit_card', 'ach',
] as const;
export type CredentialCategory = typeof CREDENTIAL_CATEGORIES[number];

export interface ProjectCredential {
  id: string;
  project_id: string;
  label: string;
  category: CredentialCategory;
  encrypted_data: string;
  iv: string;
  submitted_by_client: boolean;
  submitted_by_name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Metadata-only view (no encrypted fields) — used in store and list views. */
export interface ProjectCredentialListItem {
  id: string;
  project_id: string;
  label: string;
  category: CredentialCategory;
  submitted_by_client: boolean;
  submitted_by_name: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  shared_member_ids?: string[];
}

/**
 * The decrypted payload returned by the reveal endpoint. Keys vary by
 * category (see lib/credential-fields.ts); legacy rows hold
 * username/password/url/notes.
 */
export type CredentialPayload = Record<string, string>;
