import type { EndpointDoc } from '../docs-data';

const OWNER = ["settings.manage (an Owner's key; every other member is refused, 403 owner_only)"];
const ANY_MEMBER = ['tasks.read (any member but a guest; no other scope needed)'];
const OWNER_NOTE = "Owner only, by role, as in Settings: a key whose member is not an Owner answers 403 owner_only, and the key must carry settings.manage (no role but Owner holds it on the API, so only an Owner's key can).";

const days = (name: string, description: string) => ({ name, type: 'number | null', required: false, description });

/** Pause every agent and workspace settings. */
export const WORKSPACE_ENDPOINTS: EndpointDoc[] = [
  // ─── Pause every agent ──────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/agents/pause-all', group: 'Agent Setup', scopes: ['tasks.read (any member but a guest, 403 for a guest)'],
    description: 'Whether every agent in the workspace is paused (the kill switch in Settings > Security and on the Agents home). Answers { paused_at, paused_by: { id, name } }, both null while agents run. While paused, agent keys still read, beat and report telemetry; every other agent write answers 423 agents_paused. MCP: get_agents_pause.',
  },
  {
    method: 'PUT', path: '/api/v1/agents/pause-all', group: 'Agent Setup', scopes: OWNER,
    description: `Pauses (paused true) or resumes (false) every agent at once. People's keys are never paused, so an Owner's key can always resume them. Pausing again keeps when and by whom it was first paused. ${OWNER_NOTE} Answers { paused_at, paused_by }. MCP: set_agents_pause.`,
    body: [{ name: 'paused', type: 'boolean', required: true, description: 'true pauses every agent, false resumes them' }],
  },

  // ─── Workspace settings ─────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/workspace/modules', group: 'Workspace', scopes: OWNER,
    description: `Settings > Features: which parts of the app the workspace uses. ${OWNER_NOTE} Answers { modules (the ids switched on), setupCompleted, setupCompletedAt }. MCP: get_workspace_modules.`,
  },
  {
    method: 'PUT', path: '/api/v1/workspace/modules', group: 'Workspace', scopes: OWNER,
    description: `Switches features to exactly the list sent (every id left out is switched off, for everyone). The same writer as Settings: a module whose requirements are off stays off (sales needs contacts; billing and team_pay need time), so read the answer. ${OWNER_NOTE} Answers the new state. MCP: set_workspace_modules.`,
    body: [
      { name: 'modules', type: 'string[]', required: true, description: 'Every module to have on: time, billing, team_pay, contacts, sales, portal, inbox, agents, credentials, webhooks' },
      { name: 'completeSetup', type: 'boolean', required: false, description: 'true marks first-run setup finished' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/workspace/brand', group: 'Workspace', scopes: OWNER,
    description: `Settings > Workspace > Brand. ${OWNER_NOTE} Answers { settings (as stored; null means the default), brand (resolved, defaults filled in), defaults }. MCP: get_workspace_brand.`,
  },
  {
    method: 'PATCH', path: '/api/v1/workspace/brand', group: 'Workspace', scopes: OWNER,
    description: `Changes only the brand fields sent, by the same checks and writer as Settings (null puts a text or color back to the default); everyone sees it on their next page load. Logos upload in Settings (multipart, not over the API). ${OWNER_NOTE} Answers as GET. MCP: update_workspace_brand.`,
    body: [
      { name: 'name', type: 'string | null', required: false, description: 'Up to 60 characters' },
      { name: 'tagline', type: 'string | null', required: false, description: 'Up to 60 characters' },
      { name: 'description', type: 'string | null', required: false, description: 'Up to 200 characters' },
      { name: 'brandColor', type: 'string | null', required: false, description: 'Hex color like #5B8A8A; the 50 to 700 scale is generated from it' },
      { name: 'brandShades', type: 'object | null', required: false, description: 'Shade to hex color, overriding the generated scale' },
      { name: 'accentColor', type: 'string | null', required: false, description: 'Hex color' },
      { name: 'invertLogoInSidebar', type: 'boolean', required: false, description: 'Show the logo inverted on the dark sidebar' },
      { name: 'showNameUnderLogo', type: 'boolean', required: false, description: 'Show the name under the logo' },
      { name: 'sidebarProjects', type: 'list|menu', required: false, description: 'How the sidebar shows projects' },
      { name: 'sidebarActiveProjects', type: 'boolean', required: false, description: 'Show the active projects section' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/workspace/region', group: 'Workspace', scopes: OWNER,
    description: `Settings > Workspace > Region. ${OWNER_NOTE} Answers { region: { currency, locale, weekStart }, defaults }. MCP: get_workspace_region.`,
  },
  {
    method: 'PATCH', path: '/api/v1/workspace/region', group: 'Workspace', scopes: OWNER,
    description: `Changes only the fields sent, by the same checks and writer as Settings; every amount, date and week follows at once. ${OWNER_NOTE} Answers as GET. MCP: update_workspace_region.`,
    body: [
      { name: 'currency', type: 'string', required: false, description: 'ISO 4217, like USD or EUR' },
      { name: 'locale', type: 'string', required: false, description: 'A language tag, like en-US or de-DE' },
      { name: 'weekStart', type: '0|1|6', required: false, description: '1 Monday, 0 Sunday, 6 Saturday' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/workspace/data-retention', group: 'Workspace', scopes: OWNER,
    description: `Keeping data (Settings > Security): how long webhook deliveries, agent uptime history, agent events, agent runs and chat message text are kept, in days, or null to keep forever. ${OWNER_NOTE} MCP: get_data_retention.`,
  },
  {
    method: 'PUT', path: '/api/v1/workspace/data-retention', group: 'Workspace', scopes: OWNER,
    description: `Changes the settings sent and leaves the rest; a daily job applies them (preview a shorter one with POST /api/v1/workspace/retention-preview first). Each has its own minimum (422 names it). ${OWNER_NOTE} Answers every setting. MCP: update_data_retention.`,
    body: [
      days('webhook_retention_days', 'Webhook deliveries'),
      days('agent_health_history_days', 'Agent uptime history'),
      days('agent_activity_retention_days', 'Agent events'),
      days('agent_run_retention_days', 'Agent runs'),
      days('chat_retention_days', 'Chat message text'),
    ],
  },

  // ─── Audit ──────────────────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/workspace/audit-settings', group: 'Audit Log', scopes: OWNER,
    description: `Keeping the log (Settings > Security): { retention_days (null keeps rows forever), redact_keys (the workspace's own field names to redact beside the built-in list) }. ${OWNER_NOTE} MCP: get_audit_settings.`,
  },
  {
    method: 'PUT', path: '/api/v1/workspace/audit-settings', group: 'Audit Log', scopes: OWNER,
    description: `Changes the audit log's retention or redacted field names (send at least one); the change is itself audited. ${OWNER_NOTE} Answers { retention_days, redact_keys }. MCP: update_audit_settings.`,
    body: [
      days('retention_days', '30 to 3650, or null to keep rows forever'),
      { name: 'redact_keys', type: 'string[]', required: false, description: 'Replaces the workspace\'s own field names to redact (letters, numbers, dots, dashes, underscores; up to 100)' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/workspace/retention-preview', group: 'Audit Log', scopes: OWNER,
    description: `Before a shorter keep period is saved: about how many rows each period sent would remove at the next daily cleanup. Changes nothing. ${OWNER_NOTE} Answers { rows: { <setting>: count | null } }. MCP: preview_retention.`,
    body: [
      days('webhook_retention_days', 'Days being considered'),
      days('agent_health_history_days', 'Days being considered'),
      days('agent_activity_retention_days', 'Days being considered'),
      days('agent_run_retention_days', 'Days being considered'),
      days('chat_retention_days', 'Days being considered'),
      days('audit_retention_days', 'Days being considered for the audit log'),
    ],
  },

  // ─── API keys ───────────────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/workspace/key-settings', group: 'API Keys', scopes: OWNER,
    description: `How long a new agent key lasts: { agent_key_lifetime_days } (null: until revoked, the default). ${OWNER_NOTE} MCP: get_key_settings.`,
  },
  {
    method: 'PATCH', path: '/api/v1/workspace/key-settings', group: 'API Keys', scopes: OWNER,
    description: `Sets how long a new agent key lasts. Keys made before keep their own expiry. ${OWNER_NOTE} Answers { agent_key_lifetime_days }. MCP: update_key_settings.`,
    body: [days('agent_key_lifetime_days', '1 to 3650, or null for until revoked')],
  },
  {
    method: 'GET', path: '/api/v1/workspace/key-settings/personal', group: 'API Keys', scopes: ANY_MEMBER,
    description: "How long a person's new key lasts unless they choose otherwise, and for anyone but an Owner the longest they may choose: { personal_key_lifetime_days } (null: until revoked, no limit). Any member reads it, as the New key dialog does. MCP: get_personal_key_settings.",
  },
  {
    method: 'PATCH', path: '/api/v1/workspace/key-settings/personal', group: 'API Keys', scopes: OWNER,
    description: `Sets how long a person's new key lasts. Keys made before keep their own expiry. ${OWNER_NOTE} Answers { personal_key_lifetime_days }. MCP: update_personal_key_settings.`,
    body: [days('personal_key_lifetime_days', '1 to 3650, or null for until revoked with no limit')],
  },

  // ─── Webhooks ───────────────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/workspace/webhook-retries', group: 'Webhook Endpoints', scopes: OWNER,
    description: `Whether failed webhook deliveries are retried. On by default: this turns them on by itself once the host has what they need, unless an Owner turned them off. ${OWNER_NOTE} Answers { on, source (app, env or null), turnedOff, appKey, appUrl, vault }. MCP: get_webhook_retries.`,
  },
  {
    method: 'PUT', path: '/api/v1/workspace/webhook-retries', group: 'Webhook Endpoints', scopes: OWNER,
    description: `on true sets retries up (a new scheduler secret, kept by the server and never answered; 409 says what the host lacks); false turns them off until an Owner turns them on again. ${OWNER_NOTE} Answers as GET. MCP: set_webhook_retries.`,
    body: [{ name: 'on', type: 'boolean', required: true, description: 'true turns retries on, false off' }],
  },
];
