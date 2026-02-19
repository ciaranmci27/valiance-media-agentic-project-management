// ProjectEM PM - TypeScript Interfaces

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
  member_ids: string[];
  created_by?: string | null;
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
  source: 'referral' | 'website' | 'social' | 'cold_outreach' | 'event' | 'other';
  status: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
  value: number | null;
  equity: number | null;
  notes: string;
  assigned_to: string | null;
  member_ids: string[];
  contact_id: string | null;
  created_by?: string | null;
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
  created_by?: string | null;
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

export interface TeamMember {
  id: string;
  auth_user_id?: string | null;
  name: string;
  email: string;
  avatar: string;
  role: 'admin' | 'member' | 'guest';
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
