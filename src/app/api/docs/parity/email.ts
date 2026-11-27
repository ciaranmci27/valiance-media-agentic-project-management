import type { EndpointDoc } from '../docs-data';

const GROUP = 'Inbound Email';
const MANAGE_READ = ['inbound_email.read', 'the member also manages email inboxes (inbound_email.manage on the API: Owners by default)'];
const MANAGE_WRITE = ['inbound_email.triage', 'the member also manages email inboxes (inbound_email.manage on the API: Owners by default)'];
const MINE = ['tasks.read (any member)', "a person's own key or connected AI tool, never an agent (403 people_only)", 'the person may connect their own inbox (inbound_email.personal, as in the app)'];
const PROJECT_READ = ['contacts.read or inbound_email.read', 'the member reaches the project'];
const PROJECT_WRITE = ['contacts.manage or inbound_email.triage', 'a person who manages contacts or email inboxes (never an agent, 403 people_only)', 'the member reaches the project'];
const SETUP = 'Settings > Email over the API, by the same functions and checks as the app. Nothing here reads mail or handles a secret.';
const OFF = 'Refused (403 MODULE_OFF) while the Inbox is switched off.';

const inboxForm = [
  { name: 'name', type: 'string', required: true, description: 'Up to 100 characters' },
  { name: 'address', type: 'string', required: true, description: 'The address people write to' },
  { name: 'routing_local_part', type: 'string', required: true, description: "Empty takes the address's local part" },
  { name: 'routing_domain', type: 'string', required: true, description: 'Empty takes the relay domain' },
  { name: 'handler_member_id', type: 'uuid | null', required: true, description: 'The agent that sorts it, or null' },
  { name: 'enabled', type: 'boolean', required: true, description: 'false turns it off (inboxes are never deleted)' },
  { name: 'retention_days', type: 'number', required: true, description: '1 to 3650' },
  { name: 'max_attachment_mb', type: 'number', required: true, description: '1 to 50' },
  { name: 'agent_readable_types', type: "('image'|'pdf'|'text')[]", required: true, description: 'Attachment kinds its agent may read' },
  { name: 'summary_interval_minutes', type: 'number', required: true, description: '5 to 1440' },
  { name: 'filter_auto_mail', type: 'boolean', required: true, description: 'Set aside newsletters and automatic mail' },
  { name: 'access_member_ids', type: 'uuid[]', required: true, description: 'Who else reads it' },
  { name: 'handlers', type: '{ member_id | group_id }[]', required: false, description: 'Who else handles it; left out, they stay' },
  { name: 'aliases', type: 'string[]', required: false, description: 'Other addresses that reach it; left out, they stay' },
  { name: 'triage_mode', type: 'legacy|shadow|plans', required: false, description: 'Left out, it stays' },
  { name: 'default_assignee_member_id / default_assignee_group_id', type: 'uuid | null', required: false, description: 'Who new work goes to (one of the pair)' },
  { name: 'default_project_id', type: 'uuid | null', required: false, description: 'The project used when a request names none' },
  { name: 'decision_member_id / decision_group_id', type: 'uuid | null', required: false, description: "Who gets its decisions (one of the pair). An Owner's choice: anyone else sending a change is 403" },
];
const myInboxForm = [
  { name: 'address', type: 'string', required: true, description: 'Your address' },
  { name: 'handler_member_id', type: 'uuid | null', required: true, description: 'One of your agents to sort it, or nobody' },
  { name: 'enabled', type: 'boolean', required: true, description: 'On or off' },
  { name: 'access_member_ids', type: 'uuid[]', required: true, description: 'Who else reads it' },
];

/** Email setup: Settings > Email, your own inbox, a project's email. */
export const EMAIL_ENDPOINTS: EndpointDoc[] = [
  // ─── Shared inboxes ─────────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/inbox/inboxes', group: GROUP, scopes: MANAGE_READ,
    description: `${SETUP} Answers the shared inboxes in full (address, routing address, handler, who reads it, defaults, verified_at), personal inboxes by health only (owner, on or off, counts, never their mail), relay_domain and owners_read_personal. MCP: list_email_inboxes.`,
  },
  {
    method: 'POST', path: '/api/v1/inbox/inboxes', group: GROUP, scopes: MANAGE_WRITE,
    description: `Makes a shared inbox from the whole form, as Settings sends it. ${SETUP} 201 with the inbox. MCP: create_email_inbox.`,
    body: inboxForm,
  },
  {
    method: 'PUT', path: '/api/v1/inbox/inboxes/:id', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Changes a shared inbox: send the whole form (optional fields left out stay as they are). A new routing address clears verified_at, so its forwarder is verified again. A personal inbox is 404 here. MCP: update_email_inbox.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The inbox' }],
    body: inboxForm,
  },
  {
    method: 'PATCH', path: '/api/v1/inbox/inboxes/:id', group: GROUP, scopes: MANAGE_WRITE,
    description: "Turns someone's personal inbox off or on (when they leave, say). Nothing else about it changes and its mail is never read. A shared inbox is 409: change it with PUT. Answers its health. MCP: set_personal_inbox_on.",
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The personal inbox' }],
    body: [{ name: 'enabled', type: 'boolean', required: true, description: 'true on, false off' }],
  },
  {
    method: 'GET', path: '/api/v1/inbox/mx-check', group: GROUP, scopes: MANAGE_READ,
    description: 'Whether a routing domain has an MX record, by a live DNS lookup (never cached). Answers { domain, found, records: [{ exchange, priority }], error }. MCP: check_email_mx.',
    queryParams: [{ name: 'domain', type: 'string', description: 'Like relay.yourdomain.com' }],
  },
  {
    method: 'PUT', path: '/api/v1/inbox/relay-domain', group: GROUP, scopes: MANAGE_WRITE,
    description: 'The default routing domain new inboxes and addresses take; existing inboxes keep theirs. Answers { relay_domain }. MCP: set_email_relay_domain.',
    body: [{ name: 'domain', type: 'string', required: true, description: 'Like relay.yourdomain.com' }],
  },

  // ─── Your addresses and domains ─────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/inbox/addresses', group: GROUP, scopes: MANAGE_READ,
    description: 'Settings > Email > Your addresses: addresses (each with project_id, owner_member_id, inbox and enabled), domains (yours: mail to any address on one reads as written to you), the inboxes an address may deliver to, relay_domain, and with review=true the addresses recent mail arrived on that nobody listed (unlisted). MCP: list_email_addresses.',
    queryParams: [{ name: 'review', type: 'boolean', description: 'true also scans recent mail for unlisted addresses' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/addresses', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Adds an address people write to. 409 when it is already listed or is an inbox\'s own address. 201 with the address. MCP: add_email_address.',
    body: [
      { name: 'address', type: 'string', required: true, description: 'In full, like hello@yourdomain.com' },
      { name: 'project_id', type: 'uuid | null', required: true, description: 'Its mail is filed on this project, or null' },
      { name: 'owner_member_id', type: 'uuid | null', required: true, description: "A person's, or null for the company" },
      { name: 'inbox_id', type: 'uuid', required: false, description: 'The inbox it delivers to (default the first one on)' },
    ],
  },
  {
    method: 'PATCH', path: '/api/v1/inbox/addresses/:id', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Changes one of your addresses; send only what changes. MCP: update_email_address.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The address' }],
    body: [
      { name: 'project_id', type: 'uuid | null', required: false, description: 'Its project' },
      { name: 'owner_member_id', type: 'uuid | null', required: false, description: 'Whose it is (null: the company)' },
      { name: 'enabled', type: 'boolean', required: false, description: 'On or off' },
      { name: 'inbox_id', type: 'uuid', required: false, description: 'The inbox it delivers to' },
    ],
  },
  {
    method: 'DELETE', path: '/api/v1/inbox/addresses/:id', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Removes one of your addresses; mail it already brought in stays where it is. Answers { removed: true }. MCP: remove_email_address.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The address' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/addresses/ignored', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Not yours: an address mail arrived on is never suggested again. 201 { ignored: true }. MCP: ignore_email_address.',
    body: [{ name: 'address', type: 'string', required: true, description: 'The address from the review' }],
  },
  {
    method: 'POST', path: '/api/v1/inbox/domains', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Adds a domain of yours: mail to any address on it reads as written to you. GET /api/v1/inbox/addresses lists them. 201 with the domain. MCP: add_email_domain.',
    body: [{ name: 'domain', type: 'string', required: true, description: 'Like yourdomain.com' }],
  },
  {
    method: 'DELETE', path: '/api/v1/inbox/domains/:id', group: GROUP, scopes: MANAGE_WRITE,
    description: 'Removes one of your domains. Answers { removed: true }. MCP: remove_email_domain.',
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The domain' }],
  },

  // ─── Your own inbox ─────────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/me/inboxes', group: GROUP, scopes: MINE,
    description: `Settings > Email > Your inbox: your own personal inboxes in full, the relay domain, and whether Owners may read personal inboxes. ${OFF} MCP: list_my_inboxes.`,
  },
  {
    method: 'POST', path: '/api/v1/me/inboxes', group: GROUP, scopes: MINE,
    description: `Connects your own inbox; forward your mail to the routing address in the answer. ${OFF} 201 with the inbox. MCP: create_my_inbox.`,
    body: myInboxForm,
  },
  {
    method: 'PUT', path: '/api/v1/me/inboxes/:id', group: GROUP, scopes: MINE,
    description: `Changes one of your own inboxes; send every field. ${OFF} MCP: update_my_inbox.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Your inbox' }],
    body: myInboxForm,
  },
  {
    method: 'DELETE', path: '/api/v1/me/inboxes/:id', group: GROUP, scopes: MINE,
    description: `Removes one of your own inboxes while it holds no mail (409: turn it off instead). ${OFF} MCP: remove_my_inbox.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Your inbox' }],
  },

  // ─── A project's email ──────────────────────────────────────────────
  {
    method: 'GET', path: '/api/v1/projects/:id/email-addresses', group: GROUP, scopes: PROJECT_READ,
    description: `A project's own email addresses: mail to one lands in its inbox, filed on this project. ${OFF} MCP: list_project_email_addresses.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/email-addresses', group: GROUP, scopes: PROJECT_WRITE,
    description: `Gives the project an address of its own, with a relay address of its own. ${OFF} 201 with the address. MCP: add_project_email_address.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
    body: [
      { name: 'inbox_id', type: 'uuid', required: true, description: 'The inbox its mail lands in' },
      { name: 'routing_local_part', type: 'string', required: true, description: "Empty takes public_address's local part" },
      { name: 'public_address', type: 'string | null', required: true, description: 'What people write to' },
      { name: 'enabled', type: 'boolean', required: true, description: 'On or off' },
    ],
  },
  {
    method: 'PATCH', path: '/api/v1/projects/:id/email-addresses/:addressId', group: GROUP, scopes: PROJECT_WRITE,
    description: `Changes a project's address in place (a new routing address retires the old one) or turns it on or off; send only what changes. ${OFF} MCP: update_project_email_address.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }, { name: 'addressId', type: 'uuid', required: true, description: 'The address' }],
  },
  {
    method: 'DELETE', path: '/api/v1/projects/:id/email-addresses/:addressId', group: GROUP, scopes: PROJECT_WRITE,
    description: `Removes a project's address; conversations it filed keep their project. ${OFF} MCP: remove_project_email_address.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }, { name: 'addressId', type: 'uuid', required: true, description: 'The address' }],
  },
  {
    method: 'GET', path: '/api/v1/projects/:id/email-domains', group: GROUP, scopes: PROJECT_READ,
    description: `Sender domains: mail from any address at one maps to this project. ${OFF} MCP: list_project_email_domains.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/email-domains', group: GROUP, scopes: PROJECT_WRITE,
    description: `Maps a sender domain to the project; public mail domains are refused. ${OFF} 201 with the mapping. MCP: add_project_email_domain.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
    body: [{ name: 'domain', type: 'string', required: true, description: 'Like client.com' }],
  },
  {
    method: 'DELETE', path: '/api/v1/projects/:id/email-domains/:domainId', group: GROUP, scopes: PROJECT_WRITE,
    description: `Removes a sender domain mapping. ${OFF} MCP: remove_project_email_domain.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }, { name: 'domainId', type: 'uuid', required: true, description: 'The mapping' }],
  },
  {
    method: 'GET', path: '/api/v1/projects/:id/email-senders', group: GROUP, scopes: PROJECT_READ,
    description: `Sender addresses that map to this project: those added by hand and the project's contacts' addresses (contact names only for whoever reads contacts). ${OFF} MCP: list_project_email_senders.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/email-senders', group: GROUP, scopes: PROJECT_WRITE,
    description: `Maps a sender address to the project. ${OFF} 201 with the mapping. MCP: add_project_email_sender.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }],
    body: [{ name: 'address', type: 'string', required: true, description: 'Like jane@client.com' }],
  },
  {
    method: 'DELETE', path: '/api/v1/projects/:id/email-senders/:senderId', group: GROUP, scopes: PROJECT_WRITE,
    description: `Removes a sender address mapping. ${OFF} MCP: remove_project_email_sender.`,
    params: [{ name: 'id', type: 'uuid', required: true, description: 'The project' }, { name: 'senderId', type: 'uuid', required: true, description: 'The mapping' }],
  },
];
