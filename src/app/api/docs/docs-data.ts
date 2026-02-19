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
    ],
  },
  { method: 'POST', path: '/api/v1/projects', description: 'Create a project', group: 'Projects',
    body: [
      { name: 'name', type: 'string', required: true, description: 'Project name' },
      { name: 'description', type: 'string', required: false, description: 'Description' },
      { name: 'color', type: 'string', required: false, description: 'Hex color' },
      { name: 'status', type: 'string', required: false, description: 'Status (default active)' },
      { name: 'member_ids', type: 'uuid[]', required: false, description: 'Team member IDs' },
    ],
  },
  { method: 'GET', path: '/api/v1/projects/:id', description: 'Get a project', group: 'Projects' },
  { method: 'PATCH', path: '/api/v1/projects/:id', description: 'Update a project', group: 'Projects' },
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

  // Tasks
  { method: 'GET', path: '/api/v1/tasks', description: 'List all tasks', group: 'Tasks',
    queryParams: [
      { name: 'status', type: 'string', description: 'Filter by status (todo, in_progress, in_review, done)' },
      { name: 'priority', type: 'string', description: 'Filter by priority (low, medium, high, urgent)' },
      { name: 'project_id', type: 'uuid', description: 'Filter by project' },
      { name: 'assignee_id', type: 'uuid', description: 'Filter by assignee' },
    ],
  },
  { method: 'POST', path: '/api/v1/tasks', description: 'Create a task', group: 'Tasks',
    body: [
      { name: 'project_id', type: 'uuid', required: true, description: 'Project ID' },
      { name: 'title', type: 'string', required: true, description: 'Task title' },
      { name: 'status', type: 'string', required: false, description: 'Status (default todo)' },
      { name: 'priority', type: 'string', required: false, description: 'Priority (default medium)' },
      { name: 'assignee_ids', type: 'uuid[]', required: false, description: 'Assignee member IDs' },
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
  { method: 'PATCH', path: '/api/v1/leads/:id/interactions/:interactionId', description: 'Update an interaction', group: 'Lead Interactions' },
  { method: 'DELETE', path: '/api/v1/leads/:id/interactions/:interactionId', description: 'Delete an interaction', group: 'Lead Interactions' },

  // Lead Proposals
  { method: 'GET', path: '/api/v1/leads/:id/proposals', description: 'List lead proposals', group: 'Lead Proposals',
    queryParams: [{ name: 'status', type: 'string', description: 'Filter by status (draft, sent, accepted, rejected)' }],
  },
  { method: 'POST', path: '/api/v1/leads/:id/proposals', description: 'Create a proposal', group: 'Lead Proposals' },
  { method: 'PATCH', path: '/api/v1/leads/:id/proposals/:proposalId', description: 'Update a proposal', group: 'Lead Proposals' },
  { method: 'DELETE', path: '/api/v1/leads/:id/proposals/:proposalId', description: 'Delete a proposal', group: 'Lead Proposals' },

  // Lead Fields
  { method: 'GET', path: '/api/v1/leads/:id/fields', description: 'List lead fields', group: 'Lead Fields' },
  { method: 'PUT', path: '/api/v1/leads/:id/fields', description: 'Upsert lead fields', group: 'Lead Fields',
    body: [{ name: 'fields', type: 'array', required: true, description: 'Array of { field_key, value }' }],
  },
  { method: 'DELETE', path: '/api/v1/leads/:id/fields/:fieldId', description: 'Delete a lead field', group: 'Lead Fields' },
];

export const groups = [...new Set(endpoints.map(e => e.group))];

export const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-orange-100 text-orange-700',
  DELETE: 'bg-red-100 text-red-700',
};
