export interface EndpointDoc {
  method: string;
  path: string;
  description: string;
  group: string;
  params?: { name: string; type: string; required: boolean; description: string }[];
  queryParams?: { name: string; type: string; description: string }[];
  body?: { name: string; type: string; required: boolean; description: string }[];
}

export const endpoints: EndpointDoc[] = [
  // Contacts
  { method: 'GET', path: '/api/v1/contacts', description: 'List all contacts', group: 'Contacts',
    queryParams: [
      { name: 'page', type: 'number', description: 'Page number (default 1)' },
      { name: 'limit', type: 'number', description: 'Items per page (default 25, max 100)' },
      { name: 'search', type: 'string', description: 'Search by name, email, or company' },
      { name: 'sort', type: 'string', description: 'Sort field (default created_at)' },
      { name: 'order', type: 'asc|desc', description: 'Sort order (default desc)' },
    ],
  },
  { method: 'POST', path: '/api/v1/contacts', description: 'Create a contact', group: 'Contacts',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Contact name' },
      { name: 'email', type: 'string', required: false, description: 'Email address' },
      { name: 'phone', type: 'string', required: false, description: 'Phone number' },
      { name: 'company', type: 'string', required: false, description: 'Company name' },
      { name: 'color', type: 'string', required: false, description: 'Hex color (default #6366F1)' },
    ],
  },
  { method: 'GET', path: '/api/v1/contacts/:id', description: 'Get a contact by ID', group: 'Contacts',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Contact ID' }],
  },
  { method: 'PATCH', path: '/api/v1/contacts/:id', description: 'Update a contact', group: 'Contacts',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Contact ID' }],
  },
  { method: 'DELETE', path: '/api/v1/contacts/:id', description: 'Delete a contact', group: 'Contacts',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Contact ID' }],
  },

  // Team Members
  { method: 'GET', path: '/api/v1/team-members', description: 'List all team members', group: 'Team Members',
    queryParams: [
      { name: 'page', type: 'number', description: 'Page number' },
      { name: 'limit', type: 'number', description: 'Items per page' },
      { name: 'search', type: 'string', description: 'Search by name or email' },
    ],
  },
  { method: 'POST', path: '/api/v1/team-members', description: 'Create a team member', group: 'Team Members',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Member name' },
      { name: 'email', type: 'string', required: true, description: 'Email address' },
      { name: 'role', type: 'admin|member|guest', required: false, description: 'Role (default member)' },
    ],
  },
  { method: 'GET', path: '/api/v1/team-members/:id', description: 'Get a team member', group: 'Team Members' },
  { method: 'PATCH', path: '/api/v1/team-members/:id', description: 'Update a team member', group: 'Team Members' },
  { method: 'DELETE', path: '/api/v1/team-members/:id', description: 'Delete a team member', group: 'Team Members' },

  // Activities
  { method: 'GET', path: '/api/v1/activities', description: 'List activities (audit log)', group: 'Activities',
    queryParams: [
      { name: 'entity_type', type: 'string', description: 'Filter by entity type (task, project, etc.)' },
      { name: 'entity_id', type: 'string', description: 'Filter by entity ID' },
      { name: 'type', type: 'string', description: 'Filter by activity type' },
    ],
  },

  // Projects
  { method: 'GET', path: '/api/v1/projects', description: 'List all projects', group: 'Projects',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status (active, completed, archived)' },
      { name: 'include_archived', type: 'boolean', description: 'Include soft-deleted projects' },
      { name: 'search', type: 'string', description: 'Search by name or description' },
      { name: 'autonomous_enabled', type: 'boolean', description: 'Filter by autonomous agents enabled/disabled' },
    ],
  },
  { method: 'POST', path: '/api/v1/projects', description: 'Create a project', group: 'Projects',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Project name' },
      { name: 'description', type: 'string', required: false, description: 'Description' },
      { name: 'color', type: 'string', required: false, description: 'Hex color' },
      { name: 'status', type: 'string', required: false, description: 'Status (default active)' },
      { name: 'member_ids', type: 'uuid[]', required: false, description: 'Team member IDs' },
      { name: 'autonomous_enabled', type: 'boolean', required: false, description: 'Enable autonomous agents (default false)' },
    ],
  },
  { method: 'GET', path: '/api/v1/projects/:id', description: 'Get a project', group: 'Projects' },
  { method: 'PATCH', path: '/api/v1/projects/:id', description: 'Update a project', group: 'Projects',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Project ID' }],
    body: [
      { name: 'autonomous_enabled', type: 'boolean', required: false, description: 'Enable/disable autonomous agents' },
    ],
  },
  { method: 'DELETE', path: '/api/v1/projects/:id', description: 'Soft-delete (archive) a project', group: 'Projects' },

  // Project Contacts
  { method: 'GET', path: '/api/v1/projects/:id/contacts', description: 'List project contacts', group: 'Project Contacts' },
  { method: 'POST', path: '/api/v1/projects/:id/contacts', description: 'Add contact to project', group: 'Project Contacts',
    body: [
      { name: 'contact_id', type: 'uuid', required: true, description: 'Contact ID' },
      { name: 'role', type: 'string', required: true, description: 'Role' },
      { name: 'is_primary_client', type: 'boolean', required: false, description: 'Set as primary client' },
    ],
  },
  { method: 'GET', path: '/api/v1/projects/:id/contacts/:contactId', description: 'Get a project contact', group: 'Project Contacts' },
  { method: 'PATCH', path: '/api/v1/projects/:id/contacts/:contactId', description: 'Update project contact role', group: 'Project Contacts' },
  { method: 'DELETE', path: '/api/v1/projects/:id/contacts/:contactId', description: 'Remove contact from project', group: 'Project Contacts' },

  // Portal
  { method: 'GET', path: '/api/v1/projects/:id/portal', description: 'Get portal settings', group: 'Portal' },
  { method: 'PUT', path: '/api/v1/projects/:id/portal', description: 'Update portal settings', group: 'Portal' },
  { method: 'POST', path: '/api/v1/projects/:id/portal/regenerate-token', description: 'Regenerate portal token', group: 'Portal' },
  { method: 'GET', path: '/api/v1/projects/:id/portal/files', description: 'List portal files', group: 'Portal' },
  { method: 'POST', path: '/api/v1/projects/:id/portal/files', description: 'Add a portal file', group: 'Portal' },
  { method: 'PATCH', path: '/api/v1/projects/:id/portal/files/:fileId', description: 'Rename a portal file', group: 'Portal' },
  { method: 'DELETE', path: '/api/v1/projects/:id/portal/files/:fileId', description: 'Delete a portal file', group: 'Portal' },

  // Time Entries
  { method: 'GET', path: '/api/v1/projects/:id/time-entries', description: 'List time entries for a project', group: 'Time Entries',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Project ID' }],
    queryParams: [
      { name: 'page', type: 'number', description: 'Page number (default 1)' },
      { name: 'limit', type: 'number', description: 'Items per page (default 25, max 100)' },
      { name: 'member_id', type: 'uuid', description: 'Filter by team member' },
      { name: 'running', type: 'boolean', description: 'Filter by running timers (true = only running, false = only completed)' },
    ],
  },
  { method: 'POST', path: '/api/v1/projects/:id/time-entries', description: 'Create a manual time entry or start a live timer', group: 'Time Entries',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Project ID (must have hourly_tracking enabled)' }],
    body: [
      { name: 'member_id', type: 'uuid', required: true, description: 'Team member ID' },
      { name: 'start_time', type: 'string', required: false, description: 'ISO datetime (omit to start a live timer with current time)' },
      { name: 'end_time', type: 'string', required: false, description: 'ISO datetime (omit to start a live timer)' },
      { name: 'description', type: 'string', required: false, description: 'Entry description' },
    ],
  },
  { method: 'GET', path: '/api/v1/projects/:id/time-entries/:entryId', description: 'Get a single time entry', group: 'Time Entries',
    params: [
      { name: 'id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'entryId', type: 'uuid', required: true, description: 'Time entry ID' },
    ],
  },
  { method: 'PATCH', path: '/api/v1/projects/:id/time-entries/:entryId', description: 'Update a time entry', group: 'Time Entries',
    params: [
      { name: 'id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'entryId', type: 'uuid', required: true, description: 'Time entry ID' },
    ],
    body: [
      { name: 'member_id', type: 'uuid', required: false, description: 'Team member ID' },
      { name: 'start_time', type: 'string', required: false, description: 'ISO datetime' },
      { name: 'end_time', type: 'string|null', required: false, description: 'ISO datetime or null to re-open timer' },
      { name: 'description', type: 'string', required: false, description: 'Entry description' },
    ],
  },
  { method: 'DELETE', path: '/api/v1/projects/:id/time-entries/:entryId', description: 'Delete a time entry', group: 'Time Entries',
    params: [
      { name: 'id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'entryId', type: 'uuid', required: true, description: 'Time entry ID' },
    ],
  },
  { method: 'POST', path: '/api/v1/projects/:id/time-entries/:entryId/stop', description: 'Stop a running timer (sets end_time to now)', group: 'Time Entries',
    params: [
      { name: 'id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'entryId', type: 'uuid', required: true, description: 'Time entry ID (must be a running timer)' },
    ],
  },

  // Tasks
  { method: 'GET', path: '/api/v1/tasks', description: 'List all tasks', group: 'Tasks',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status (todo, in_progress, in_review, done)' },
      { name: 'priority', type: 'string', description: 'Filter by priority (low, medium, high, urgent)' },
      { name: 'project_id', type: 'uuid', description: 'Filter by project' },
      { name: 'assignee_id', type: 'uuid', description: 'Filter by assignee' },
      { name: 'task_type', type: 'string', description: 'Filter by task type (engineering, research, audit, marketing, copywriting, operations, general)' },
    ],
  },
  { method: 'POST', path: '/api/v1/tasks', description: 'Create a task', group: 'Tasks',
    body: [
      { name: 'project_id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'title', type: 'string', required: true, description: 'Task title' },
      { name: 'status', type: 'string', required: false, description: 'Status (default todo)' },
      { name: 'priority', type: 'string', required: false, description: 'Priority (default medium)' },
      { name: 'assignee_ids', type: 'uuid[]', required: false, description: 'Assignee member IDs' },
      { name: 'task_type', type: 'string', required: false, description: 'Task type (engineering, research, audit, marketing, copywriting, operations, general)' },
    ],
  },
  { method: 'GET', path: '/api/v1/tasks/:id', description: 'Get a task with subtasks and comments', group: 'Tasks' },
  { method: 'PATCH', path: '/api/v1/tasks/:id', description: 'Update a task', group: 'Tasks' },
  { method: 'DELETE', path: '/api/v1/tasks/:id', description: 'Delete a task', group: 'Tasks' },

  // Subtasks
  { method: 'GET', path: '/api/v1/tasks/:id/subtasks', description: 'List subtasks', group: 'Subtasks' },
  { method: 'POST', path: '/api/v1/tasks/:id/subtasks', description: 'Create a subtask', group: 'Subtasks',
    body: [{ name: 'title', type: 'string', required: true, description: 'Subtask title' }],
  },
  { method: 'PUT', path: '/api/v1/tasks/:id/subtasks/reorder', description: 'Reorder subtasks', group: 'Subtasks',
    body: [{ name: 'subtask_ids', type: 'uuid[]', required: true, description: 'Ordered array of subtask IDs' }],
  },
  { method: 'PATCH', path: '/api/v1/tasks/:id/subtasks/:subtaskId', description: 'Update a subtask', group: 'Subtasks' },
  { method: 'DELETE', path: '/api/v1/tasks/:id/subtasks/:subtaskId', description: 'Delete a subtask', group: 'Subtasks' },

  // Comments
  { method: 'GET', path: '/api/v1/tasks/:id/comments', description: 'List comments on a task', group: 'Comments' },
  { method: 'POST', path: '/api/v1/tasks/:id/comments', description: 'Add a comment', group: 'Comments',
    body: [
      { name: 'user_id', type: 'uuid', required: true, description: 'Author team member ID' },
      { name: 'text', type: 'string', required: true, description: 'Comment text' },
    ],
  },
  { method: 'PATCH', path: '/api/v1/tasks/:id/comments/:commentId', description: 'Update a comment', group: 'Comments' },
  { method: 'DELETE', path: '/api/v1/tasks/:id/comments/:commentId', description: 'Delete a comment', group: 'Comments' },

  // Leads
  { method: 'GET', path: '/api/v1/leads', description: 'List all leads', group: 'Leads',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status' },
      { name: 'source', type: 'string', description: 'Filter by source' },
      { name: 'assigned_to', type: 'uuid', description: 'Filter by assigned member' },
      { name: 'include_archived', type: 'boolean', description: 'Include soft-deleted leads' },
    ],
  },
  { method: 'POST', path: '/api/v1/leads', description: 'Create a lead', group: 'Leads',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Lead name' },
      { name: 'email', type: 'string', required: false, description: 'Email' },
      { name: 'company', type: 'string', required: false, description: 'Company' },
      { name: 'source', type: 'string', required: false, description: 'Source (default other)' },
      { name: 'status', type: 'string', required: false, description: 'Status (default new)' },
      { name: 'member_ids', type: 'uuid[]', required: false, description: 'Team member IDs' },
    ],
  },
  { method: 'GET', path: '/api/v1/leads/:id', description: 'Get a lead', group: 'Leads' },
  { method: 'PATCH', path: '/api/v1/leads/:id', description: 'Update a lead', group: 'Leads' },
  { method: 'DELETE', path: '/api/v1/leads/:id', description: 'Soft-delete (archive) a lead', group: 'Leads' },
  { method: 'POST', path: '/api/v1/leads/:id/convert', description: 'Convert lead to project', group: 'Leads',
    body: [
      { name: 'project_name', type: 'string', required: true, description: 'New project name' },
      { name: 'project_color', type: 'string', required: false, description: 'Hex color' },
      { name: 'project_description', type: 'string', required: false, description: 'Project description' },
    ],
  },

  // Lead Contacts
  { method: 'GET', path: '/api/v1/leads/:id/contacts', description: 'List lead contacts', group: 'Lead Contacts' },
  { method: 'POST', path: '/api/v1/leads/:id/contacts', description: 'Add contact to lead', group: 'Lead Contacts' },
  { method: 'GET', path: '/api/v1/leads/:id/contacts/:contactId', description: 'Get a lead contact', group: 'Lead Contacts' },
  { method: 'PATCH', path: '/api/v1/leads/:id/contacts/:contactId', description: 'Update lead contact', group: 'Lead Contacts' },
  { method: 'DELETE', path: '/api/v1/leads/:id/contacts/:contactId', description: 'Remove contact from lead', group: 'Lead Contacts' },

  // Lead Interactions
  { method: 'GET', path: '/api/v1/leads/:id/interactions', description: 'List lead interactions', group: 'Lead Interactions',
    queryParams: [
      { name: 'type', type: 'string', description: 'Filter by type (call, email, meeting, note, follow_up)' },
      { name: 'completed', type: 'boolean', description: 'Filter by completion status' },
    ],
  },
  { method: 'POST', path: '/api/v1/leads/:id/interactions', description: 'Create an interaction', group: 'Lead Interactions' },
  { method: 'GET', path: '/api/v1/leads/:id/interactions/:interactionId', description: 'Get an interaction', group: 'Lead Interactions' },
  { method: 'PATCH', path: '/api/v1/leads/:id/interactions/:interactionId', description: 'Update an interaction', group: 'Lead Interactions' },
  { method: 'DELETE', path: '/api/v1/leads/:id/interactions/:interactionId', description: 'Delete an interaction', group: 'Lead Interactions' },

  // Lead Proposals
  { method: 'GET', path: '/api/v1/leads/:id/proposals', description: 'List lead proposals', group: 'Lead Proposals',
    queryParams: [{ name: 'status', type: 'string', description: 'Filter by status (draft, sent, accepted, rejected)' }],
  },
  { method: 'POST', path: '/api/v1/leads/:id/proposals', description: 'Create a proposal', group: 'Lead Proposals' },
  { method: 'GET', path: '/api/v1/leads/:id/proposals/:proposalId', description: 'Get a proposal', group: 'Lead Proposals' },
  { method: 'PATCH', path: '/api/v1/leads/:id/proposals/:proposalId', description: 'Update a proposal', group: 'Lead Proposals' },
  { method: 'DELETE', path: '/api/v1/leads/:id/proposals/:proposalId', description: 'Delete a proposal', group: 'Lead Proposals' },

  // Lead Fields
  { method: 'GET', path: '/api/v1/leads/:id/fields', description: 'List lead fields', group: 'Lead Fields' },
  { method: 'PUT', path: '/api/v1/leads/:id/fields', description: 'Upsert lead fields', group: 'Lead Fields',
    body: [{ name: 'fields', type: 'array', required: true, description: 'Array of { field_key, value }' }],
  },
  { method: 'GET', path: '/api/v1/leads/:id/fields/:fieldId', description: 'Get a lead field', group: 'Lead Fields' },
  { method: 'DELETE', path: '/api/v1/leads/:id/fields/:fieldId', description: 'Delete a lead field', group: 'Lead Fields' },

  // Project Goals (requires NEXT_PUBLIC_ENABLE_AGENTS=true)
  { method: 'GET', path: '/api/v1/projects/:id/goals', description: 'List goals for a project', group: 'Goals',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status (active, achieved, paused, abandoned)' },
      { name: 'page', type: 'number', description: 'Page number' },
      { name: 'limit', type: 'number', description: 'Items per page' },
    ],
  },
  { method: 'POST', path: '/api/v1/projects/:id/goals', description: 'Create a goal for a project', group: 'Goals',
    body: [
      { name: 'title', type: 'string', required: true, description: 'Goal title' },
      { name: 'description', type: 'string', required: false, description: 'Goal description' },
      { name: 'target_date', type: 'string', required: false, description: 'Target date (YYYY-MM-DD)' },
      { name: 'status', type: 'string', required: false, description: 'Status (default active)' },
    ],
  },
  { method: 'GET', path: '/api/v1/projects/:id/goals/:goalId', description: 'Get a goal with rollup stats', group: 'Goals' },
  { method: 'PATCH', path: '/api/v1/projects/:id/goals/:goalId', description: 'Update a goal', group: 'Goals' },
  { method: 'DELETE', path: '/api/v1/projects/:id/goals/:goalId', description: 'Archive a goal (soft delete)', group: 'Goals' },

  // Task Suggestions (requires NEXT_PUBLIC_ENABLE_AGENTS=true)
  { method: 'GET', path: '/api/v1/task-suggestions', description: 'List all task suggestions', group: 'Task Suggestions',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status (pending, needs_info, approved, rejected)' },
      { name: 'project_id', type: 'uuid', description: 'Filter by project' },
      { name: 'goal_id', type: 'uuid', description: 'Filter by goal' },
      { name: 'proposed_by', type: 'uuid', description: 'Filter by agent member ID' },
      { name: 'task_type', type: 'string', description: 'Filter by task type (engineering, research, audit, marketing, copywriting, operations, general)' },
      { name: 'page', type: 'number', description: 'Page number' },
      { name: 'limit', type: 'number', description: 'Items per page' },
    ],
  },
  { method: 'POST', path: '/api/v1/task-suggestions', description: 'Create a suggestion (agent only)', group: 'Task Suggestions',
    body: [
      { name: 'project_id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'goal_id', type: 'uuid', required: true, description: 'Goal ID' },
      { name: 'title', type: 'string', required: true, description: 'Suggestion title' },
      { name: 'description', type: 'string', required: true, description: 'Detailed description' },
      { name: 'reasoning', type: 'string', required: true, description: 'Why this task is needed' },
      { name: 'priority', type: 'string', required: false, description: 'Priority (default medium)' },
      { name: 'effort_estimate', type: 'string', required: false, description: 'Effort (small, medium, large)' },
      { name: 'assigned_to', type: 'uuid', required: false, description: 'Suggested assignee' },
      { name: 'task_type', type: 'string', required: false, description: 'Task type (engineering, research, audit, marketing, copywriting, operations, general)' },
      { name: 'metadata', type: 'object', required: false, description: 'Arbitrary metadata' },
    ],
  },
  { method: 'GET', path: '/api/v1/task-suggestions/:id', description: 'Get a suggestion', group: 'Task Suggestions' },
  { method: 'PATCH', path: '/api/v1/task-suggestions/:id', description: 'Update suggestion metadata', group: 'Task Suggestions' },
  { method: 'POST', path: '/api/v1/task-suggestions/:id/approve', description: 'Approve and create task', group: 'Task Suggestions',
    body: [
      { name: 'priority', type: 'string', required: false, description: 'Override priority' },
      { name: 'assigned_to', type: 'uuid', required: false, description: 'Override assignee' },
      { name: 'due_date', type: 'string', required: false, description: 'Set due date' },
      { name: 'project_id', type: 'uuid', required: false, description: 'Override project' },
      { name: 'task_type', type: 'string', required: false, description: 'Set task type for the created task' },
    ],
  },
  { method: 'POST', path: '/api/v1/task-suggestions/:id/reject', description: 'Reject a suggestion', group: 'Task Suggestions',
    body: [{ name: 'rejection_reason', type: 'string', required: false, description: 'Reason for rejection' }],
  },
  { method: 'POST', path: '/api/v1/task-suggestions/:id/request-info', description: 'Request more info on a suggestion', group: 'Task Suggestions',
    body: [{ name: 'info_request', type: 'string', required: true, description: 'What info is needed' }],
  },
  { method: 'POST', path: '/api/v1/task-suggestions/bulk-approve', description: 'Bulk approve suggestions', group: 'Task Suggestions',
    body: [{ name: 'ids', type: 'uuid[]', required: true, description: 'Array of suggestion IDs' }],
  },
  { method: 'POST', path: '/api/v1/task-suggestions/bulk-reject', description: 'Bulk reject suggestions', group: 'Task Suggestions',
    body: [
      { name: 'ids', type: 'uuid[]', required: true, description: 'Array of suggestion IDs' },
      { name: 'rejection_reason', type: 'string', required: false, description: 'Shared reason for rejection' },
    ],
  },

  // Agent Activity (requires NEXT_PUBLIC_ENABLE_AGENTS=true)
  { method: 'GET', path: '/api/v1/agent-activity', description: 'List agent activity', group: 'Agent Activity',
    queryParams: [
      { name: 'agent_id', type: 'uuid', description: 'Filter by agent' },
      { name: 'project_id', type: 'uuid', description: 'Filter by project' },
      { name: 'activity_type', type: 'string', description: 'Filter by type' },
      { name: 'page', type: 'number', description: 'Page number' },
      { name: 'limit', type: 'number', description: 'Items per page' },
    ],
  },
  { method: 'POST', path: '/api/v1/agent-activity', description: 'Log agent activity (agent only)', group: 'Agent Activity',
    body: [
      { name: 'activity_type', type: 'string', required: true, description: 'Activity type' },
      { name: 'title', type: 'string', required: true, description: 'Activity title' },
      { name: 'description', type: 'string', required: false, description: 'Activity description' },
      { name: 'project_id', type: 'uuid', required: false, description: 'Related project' },
      { name: 'reference_type', type: 'string', required: false, description: 'Reference entity type' },
      { name: 'reference_id', type: 'uuid', required: false, description: 'Reference entity ID' },
      { name: 'metadata', type: 'object', required: false, description: 'Arbitrary metadata' },
    ],
  },

  // Audit Log
  { method: 'GET', path: '/api/v1/audit-log', description: 'List API audit log entries', group: 'Audit Log',
    queryParams: [
      { name: 'entity_type', type: 'string', description: 'Filter by entity type' },
      { name: 'entity_id', type: 'uuid', description: 'Filter by entity ID' },
      { name: 'team_member_id', type: 'uuid', description: 'Filter by team member' },
      { name: 'method', type: 'string', description: 'Filter by HTTP method' },
      { name: 'page', type: 'number', description: 'Page number' },
      { name: 'limit', type: 'number', description: 'Items per page' },
    ],
  },
  { method: 'GET', path: '/api/v1/audit-log/:entityType/:entityId', description: 'Get change history for an entity', group: 'Audit Log' },

  // Entity Files (file attachments for contacts, leads, projects)
  { method: 'GET', path: '/api/v1/entity-files', description: 'List file attachments for an entity', group: 'Entity Files',
    queryParams: [
      { name: 'entity_type', type: 'string', description: 'Entity type: lead, project, or contact (required)' },
      { name: 'entity_id', type: 'uuid', description: 'Entity ID (required)' },
      { name: 'page', type: 'number', description: 'Page number (default 1)' },
      { name: 'limit', type: 'number', description: 'Items per page (default 25, max 100)' },
    ],
  },
  { method: 'POST', path: '/api/v1/entity-files', description: 'Attach a file to an entity', group: 'Entity Files',
    body: [
      { name: 'entity_type', type: 'string', required: true, description: 'Entity type: lead, project, or contact' },
      { name: 'entity_id', type: 'uuid', required: true, description: 'Entity ID' },
      { name: 'name', type: 'string', required: true, description: 'File display name' },
      { name: 'file_url', type: 'string', required: true, description: 'URL to the file' },
      { name: 'file_size', type: 'number', required: false, description: 'File size in bytes (default 0)' },
      { name: 'mime_type', type: 'string', required: false, description: 'MIME type (default application/octet-stream)' },
      { name: 'uploaded_by', type: 'uuid|null', required: false, description: 'Team member ID of uploader' },
    ],
  },
  { method: 'GET', path: '/api/v1/entity-files/:fileId', description: 'Get a file attachment by ID', group: 'Entity Files',
    params: [{ name: 'fileId', type: 'uuid', required: true, description: 'Entity file ID' }],
  },
  { method: 'PATCH', path: '/api/v1/entity-files/:fileId', description: 'Rename a file attachment', group: 'Entity Files',
    params: [{ name: 'fileId', type: 'uuid', required: true, description: 'Entity file ID' }],
    body: [
      { name: 'name', type: 'string', required: true, description: 'New file name' },
    ],
  },
  { method: 'DELETE', path: '/api/v1/entity-files/:fileId', description: 'Delete a file attachment', group: 'Entity Files',
    params: [{ name: 'fileId', type: 'uuid', required: true, description: 'Entity file ID' }],
  },
];

export const groups = [...new Set(endpoints.map(e => e.group))];

export const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-orange-100 text-orange-700',
  DELETE: 'bg-red-100 text-red-700',
};
