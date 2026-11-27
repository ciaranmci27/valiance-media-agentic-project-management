import type { EndpointDoc } from '../docs-data';

const OWNER = ["settings.manage (an Owner's key; every other member is refused, 403 owner_only)"];
const OWNER_NOTE = "Owner only, by role, as in Settings: a key whose member is not an Owner answers 403 owner_only, and the key must carry settings.manage.";
const FILE = 'multipart/form-data, one field named file';
const kindParam = { name: 'kind', type: 'light|dark|favicon', description: 'Which file: the logo, the dark logo or the favicon' };
const idParam = (what: string) => ({ name: 'id', type: 'uuid', required: true, description: what });

/** Your notification choices, the brand's files, pictures, and the remaining settings and team routes. */
export const SETTINGS_ENDPOINTS: EndpointDoc[] = [
  // ─── Your notifications ─────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/me/notification-preferences', group: 'Notifications', scopes: ['notifications.manage_own (your own only)'],
    description: "Settings > Notifications for the key's own member: in_app and email, each category on or off, email_enabled (the email switch) and email_available (whether the workspace can send email). No key reads anyone else's. MCP: get_notification_preferences.",
  },
  {
    method: 'PATCH', path: '/api/v1/me/notification-preferences', group: 'Notifications', scopes: ['notifications.manage_own (your own only)'],
    description: 'Changes only the categories sent, as the toggles do, and the email switch (409 email_not_set_up while the workspace sends no email). Audited. Answers as GET. MCP: update_notification_preferences.',
    body: [
      { name: 'in_app', type: 'object', required: false, description: 'Category to true (on) or false (off), like { "task_comments": false }' },
      { name: 'email_enabled', type: 'boolean', required: false, description: 'The email switch' },
      { name: 'email', type: 'object', required: false, description: 'Category to true or false, sent by email while email_enabled' },
    ],
  },

  // ─── Workspace ──────────────────────────────────────────────────────
  {
    method: 'POST', path: '/api/v1/workspace/brand/logo', group: 'Workspace', scopes: OWNER,
    description: `Uploads one of the brand's files by the same writer as Settings > Workspace > Brand (${FILE}): a logo or dark logo, PNG or JPG up to 2 MB; a favicon, PNG, JPG or ICO up to 512 KB (413 too large, 415 not an image). Each upload gets a new name, so no screen shows a stale logo; the one it replaces is removed. ${OWNER_NOTE} Audited. Answers as GET /api/v1/workspace/brand.`,
    queryParams: [kindParam],
    restOnly: 'A binary file upload (multipart), which an MCP tool call cannot carry; remove_brand_logo removes one (tools.ts: binary uploads stay off MCP).',
  },
  {
    method: 'DELETE', path: '/api/v1/workspace/brand/logo', group: 'Workspace', scopes: OWNER,
    description: `Removes one of the brand's files; the default shows again. ${OWNER_NOTE} Answers as GET /api/v1/workspace/brand. MCP: remove_brand_logo.`,
    queryParams: [kindParam],
  },
  {
    method: 'GET', path: '/api/v1/workspace/provider-plans', group: 'Workspace', scopes: ['tasks.read (any member but a guest)'],
    description: 'Settings > Workspace > AI provider plans: each provider subscription\'s monthly cost per seat in US dollars ({ id, provider, monthly_cost_usd, seats, notes }), for the estimate Agents > Analytics shows beside measured cost, never inside it. With the AI agents module on. MCP: list_provider_plans.',
  },
  {
    method: 'PUT', path: '/api/v1/workspace/provider-plans', group: 'Workspace', scopes: OWNER,
    description: `Saves a provider's plan: a provider already listed (in any case) has its plan changed, as in Settings. ${OWNER_NOTE} Audited. Answers the plan with created. MCP: save_provider_plan.`,
    body: [
      { name: 'provider', type: 'string', required: true, description: 'As your agents report it (1 to 100 characters)' },
      { name: 'monthly_cost_usd', type: 'number', required: true, description: 'Per seat, 0 to 1000000' },
      { name: 'seats', type: 'integer', required: false, description: '1 to 10000 (default 1)' },
      { name: 'notes', type: 'string', required: false, description: 'Up to 500 characters' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/workspace/provider-plans/:id', group: 'Workspace', scopes: OWNER,
    description: `Removes a provider's plan; Analytics stops estimating that subscription. ${OWNER_NOTE} MCP: remove_provider_plan.`,
    params: [idParam('The plan')],
  },
  {
    method: 'GET', path: '/api/v1/workspace/analytics-exclusions', group: 'Workspace', scopes: ['settings.manage'],
    description: "Settings > Client portal: the IPs (yours, your team's) left out of every project's portal analytics, { excluded_ips: [{ ip, label }] }. With the Client portal on. MCP: get_analytics_exclusions.",
  },
  {
    method: 'PUT', path: '/api/v1/workspace/analytics-exclusions', group: 'Workspace', scopes: ['settings.manage'],
    description: 'Replaces the whole list: read it, change it, send it back ([] excludes nobody). Each IP (IPv4 or IPv6) once, up to 100. Audited. MCP: set_analytics_exclusions.',
    body: [{ name: 'excluded_ips', type: '{ ip, label }[]', required: true, description: 'The whole list' }],
  },

  // ─── Pictures ───────────────────────────────────────────────────────
  {
    method: 'POST', path: '/api/v1/agents/:id/picture', group: 'Agent Setup', scopes: ['team.read (or team.manage)', 'whoever may change the agent: an Owner, team.manage, or one of its owners (403 not_agent_owner)'],
    description: `Uploads an agent's picture (${FILE}, PNG or JPG up to 2 MB), checked before it is stored, then set as update_agent sets avatar_url. With the AI agents module on. Answers the agent.`,
    params: [idParam('The agent')],
    restOnly: 'A binary file upload (multipart), which an MCP tool call cannot carry; update_agent takes a picture by link (tools.ts: binary uploads stay off MCP).',
  },
  {
    method: 'POST', path: '/api/v1/team-members/:id/avatar', group: 'Team Members', scopes: ['team.manage'],
    description: `Uploads a person's picture (${FILE}, PNG or JPG up to 2 MB), stored where the app stores it. An Owner's picture only with that Owner's own key (403 owner_protected); an agent's: POST /api/v1/agents/:id/picture. Audited. Answers the member.`,
    params: [idParam('The team member')],
    restOnly: 'A binary file upload (multipart), which an MCP tool call cannot carry (tools.ts: binary uploads stay off MCP).',
  },
  {
    method: 'POST', path: '/api/v1/contacts/:id/photo', group: 'Contacts', scopes: ['contacts.manage'],
    description: `Uploads a contact's photo (${FILE}, PNG or JPG up to 2 MB), stored where the app stores it and set as avatar_url. Audited. Answers the contact.`,
    params: [idParam('The contact')],
    restOnly: 'A binary file upload (multipart), which an MCP tool call cannot carry; update_contact takes a link (tools.ts: binary uploads stay off MCP).',
  },

  // ─── Keys, groups and people ────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/api-keys/:id/revoke', group: 'API Keys', scopes: ['api_keys.manage_all'],
    description: 'What revoking this key would also take down, without revoking (Settings names them before the Revoke confirm): every live key it made over the API and, through rotation, the keys it replaced. Answers { also: [{ id, name, member_name }] }. MCP: preview_api_key_revoke.',
    params: [idParam('API key ID')],
  },
  {
    method: 'GET', path: '/api/v1/groups/:id/usage', group: 'Groups', scopes: ['team.read', 'groups.manage'],
    description: 'What a group controls ("Used for" on its page): agents it owns and that escalate to it, inboxes it handles, is the default for or decides for, initiatives it owns, assistant setups that match it, each { total, names }. For whoever reads the group. MCP: get_group_usage.',
    params: [idParam('The group')],
  },
  {
    method: 'GET', path: '/api/v1/team-members/:id/profile', group: 'Team Members', scopes: ['team.read (or team.manage)'],
    description: "A member's profile by the app's own rules, on the API channel: view full for yourself or with team.manage (work, hours with Time on and time.read_all, usage for people), colleague with team.read, guest for a guest. Someone out of reach is 404, never 403. The activity section is left out: read it from GET /api/v1/activities. MCP: get_member_profile.",
    params: [idParam('The team member')],
  },
  {
    method: 'POST', path: '/api/v1/team-members/:id/invite', group: 'Team Members', scopes: ['team.manage'],
    description: "Resend invite: a fresh set-your-password link, emailed to someone who has not signed in yet; it replaces the earlier link. Only an Owner re-invites an Owner, an Admin or an agent; never a personal agent; 409 once they signed in. The link is never answered (it signs them in), so this is refused before a link is made when email cannot go out (409 email_not_set_up) and for an agent (422 agent_link_only: copy its link in the app). Answers { emailed, email_status }. MCP: resend_invite.",
    params: [idParam('The team member')],
  },
  {
    method: 'POST', path: '/api/v1/team-members/:id/email', group: 'Team Members', scopes: ["team.manage, on an Owner's key (403 owner_only)"],
    description: "Changes someone else's sign-in email, by the app's writer: only an Owner (it decides who can reset the password), never another Owner's (403 owner_protected) or a login another app owns (409). The old address is told who changed it. Your own: POST /api/v1/me/email (422 use_me_email here). Audited. MCP: change_member_email.",
    params: [idParam('The team member')],
    body: [{ name: 'new_email', type: 'string', required: true, description: 'The new sign-in email' }],
  },
  {
    method: 'POST', path: '/api/v1/me/email', group: 'Team Members', scopes: ["tasks.read (any member's own key)", 'a person, never an agent (403 people_only)'],
    description: "Changes your own sign-in email, by the app's writer. Proof it is you: your current password (403 wrong_password, current_password_required); an account with no password changes it in the app after signing in again (403 fresh_sign_in_required). The old address is told. The audit row never holds the password. Answers { id, email }.",
    body: [
      { name: 'new_email', type: 'string', required: true, description: 'Your new sign-in email' },
      { name: 'current_password', type: 'string', required: true, description: 'Your current password' },
    ],
    restOnly: 'It takes your current password, a secret that never goes through an MCP tool call or an AI model (tools.ts: what handles a credential stays off MCP).',
  },
];
