// ProjectEM PM - TypeScript Interfaces

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  status: 'active' | 'completed' | 'archived';
  start_date: string | null;
  due_date: string | null;
  member_ids: string[];
  client_id: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Client {
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

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  source: 'referral' | 'website' | 'social' | 'cold_outreach' | 'event' | 'other';
  status: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';
  value: number | null;
  notes: string;
  assigned_to: string | null;
  client_id: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
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
