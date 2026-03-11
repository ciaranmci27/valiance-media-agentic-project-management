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
  fixed_price: number | null;
  autonomous_enabled: boolean;
  deployment_policy: 'playground' | 'production';
  member_ids: string[];
  created_by?: string | null;
  archived_at?: string | null;
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
  value: number | null;
  equity: number | null;
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
  task_type?: TaskType | null;
  ai_managed: boolean;
  created_by?: string | null;
  project_goal_id?: string | null;
  source_task_suggestion_id?: string | null;
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
  role: 'admin' | 'member' | 'guest' | 'agent';
  timezone?: string;
  notification_prefs?: NotificationPreferences;
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

export interface TimeEntry {
  id: string;
  project_id: string;
  member_id: string;
  start_time: string;       // ISO datetime
  end_time: string | null;  // null = timer currently running
  description: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// PROJECT INVOICES
// ============================================================

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const;
export type InvoiceStatus = typeof INVOICE_STATUSES[number];

export interface ProjectInvoice {
  id: string;
  project_id: string;
  invoice_number: string;
  amount: number;
  status: InvoiceStatus;
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
  created_at: string;
  updated_at: string;
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
  permissions: 'full' | 'read_only';
  last_used_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  team_member_id: string | null;
  created_at: string;
  updated_at: string;
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
  status: 'pending' | 'needs_info' | 'approved' | 'rejected';
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
      description: string;
      member_name: string;
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
  invoices: {
    id: string;
    invoice_number: string;
    amount: number;
    status: string;
    date: string;
    due_date: string | null;
    paid_date: string | null;
    description: string;
    file_url: string | null;
    file_name: string | null;
    file_size: number | null;
    mime_type: string | null;
  }[];
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

export const CREDENTIAL_CATEGORIES = [
  'login', 'api_key', 'ssh_key', 'database', 'hosting',
  'cms', 'ftp', 'dns', 'email', 'other',
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
}

/** The decrypted payload returned by the reveal endpoint. */
export interface CredentialPayload {
  username: string;
  password: string;
  url: string;
  notes: string;
}
