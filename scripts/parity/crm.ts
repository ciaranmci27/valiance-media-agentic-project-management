import type { Handler, Harness } from './harness';

type Row = Record<string, unknown>;
const h_ = (handler: unknown) => handler as Handler;

/**
 * Contacts, leads, identities, templates and the routes decision 1 opens to
 * MCP: allowed and refused calls over REST and MCP, each with the thing
 * really changed (or left alone) in the database.
 */
export async function crmArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const contacts = await import('../../src/app/api/v1/contacts/route');
  const contact = await import('../../src/app/api/v1/contacts/[id]/route');
  const contactEmails = await import('../../src/app/api/v1/contacts/[id]/emails/route');
  const leadArchive = await import('../../src/app/api/v1/leads/[id]/archive/route');
  const identities = await import('../../src/app/api/v1/identities/route');
  const identityMove = await import('../../src/app/api/v1/identities/[id]/move/route');
  const templateRuns = await import('../../src/app/api/v1/task-templates/[id]/runs/route');
  const projectInvoices = await import('../../src/app/api/v1/projects/[id]/invoices/route');
  const timeReview = await import('../../src/app/api/v1/projects/[id]/time-entries/review/route');

  const ownerKey = await key(members.owner, [
    'contacts.read', 'contacts.read_all', 'contacts.manage', 'leads.read', 'leads.read_all', 'leads.manage', 'team.read', 'team.manage',
    'identities.read', 'tasks.read', 'tasks.create', 'templates.manage', 'projects.read', 'projects.read_all', 'projects.manage', 'invoices.read',
  ]);
  const readerKey = await key(members.owner, ['contacts.read', 'contacts.read_all', 'leads.read', 'leads.read_all', 'identities.read', 'projects.read']);

  // Contacts: REST
  const restMade = await call(h_(contacts.POST), ownerKey, 'POST', '/api/v1/contacts', {}, { name: 'Crm Quill Harbor', email: 'quill@harbor.example' });
  check('crm contacts: REST create with contacts.manage is 201', restMade.status === 201 && restMade.json.data?.name === 'Crm Quill Harbor', restMade.json);
  const C = restMade.json.data?.id as string;
  const restRefused = await call(h_(contacts.POST), readerKey, 'POST', '/api/v1/contacts', {}, { name: 'Crm Not Made' });
  check('crm contacts: REST create without contacts.manage is 403, nothing made', restRefused.status === 403
    && (await q("SELECT 1 FROM pm.contacts WHERE name = 'Crm Not Made'")).length === 0, restRefused.json);
  const restEdit = await call(h_(contact.PATCH), readerKey, 'PATCH', `/api/v1/contacts/${C}`, { id: C }, { company: 'Nope' });
  check('crm contacts: REST update without contacts.manage is 403', restEdit.status === 403, restEdit.json);

  // Contacts: MCP
  const made = await tool(ownerKey, 'create_contact', { name: 'Crm Wren Lattice', phone: '555-0101' });
  check('crm contacts mcp: create_contact is listed and makes the contact', made.listed && made.result.ok === true
    && (await q("SELECT 1 FROM pm.contacts WHERE name = 'Crm Wren Lattice' AND phone = '555-0101'")).length === 1, made.result);
  const W = made.result.data?.id as string;
  const edited = await tool(ownerKey, 'update_contact', { contact_id: W, company: 'Lattice Works' });
  check('crm contacts mcp: update_contact changes it in the database', edited.result.ok === true
    && (await q<{ company: string }>('SELECT company FROM pm.contacts WHERE id = $1', [W]))[0]?.company === 'Lattice Works', edited.result);
  const got = await tool(readerKey, 'get_contact', { contact_id: W });
  check('crm contacts mcp: get_contact reads it with contacts.read', got.listed && got.result.ok === true && got.result.data?.company === 'Lattice Works', got.result);
  const mcpRefused = await tool(readerKey, 'create_contact', { name: 'Crm Not Made Either' });
  check('crm contacts mcp: create_contact is not listed without contacts.manage and refuses', !mcpRefused.listed && mcpRefused.result.ok !== true
    && (await q("SELECT 1 FROM pm.contacts WHERE name = 'Crm Not Made Either'")).length === 0, mcpRefused.result);

  // Contact emails: several per contact, primary mirrored to contacts.email
  const saved = await call(h_(contactEmails.PUT), ownerKey, 'PUT', `/api/v1/contacts/${C}/emails`, { id: C }, {
    emails: [{ email: 'Quill@Harbor.example', label: 'Work' }, { email: 'billing@harbor.example', label: 'Billing', is_primary: true }],
  });
  const rows = await q<{ id: string; email: string; label: string | null; is_primary: boolean }>('SELECT id, email, label, is_primary FROM pm.contact_emails WHERE contact_id = $1 ORDER BY email', [C]);
  check('crm emails: REST saves two addresses, the marked one primary and the contact\'s email', saved.status === 200 && rows.length === 2
    && rows.find((row) => row.email === 'billing@harbor.example')?.is_primary === true
    && rows.find((row) => row.email === 'quill@harbor.example')?.label === 'Work'
    && (await q<{ email: string }>('SELECT email FROM pm.contacts WHERE id = $1', [C]))[0]?.email === 'billing@harbor.example'
    && saved.json.data?.[0]?.email === 'billing@harbor.example', { saved: saved.json, rows });
  const work = rows.find((row) => row.email === 'quill@harbor.example')!;
  const trimmed = await tool(ownerKey, 'set_contact_emails', { contact_id: C, emails: [{ id: work.id, email: 'quill@harbor.example', label: 'Main', is_primary: true }] });
  const after = await q<{ id: string; label: string | null; is_primary: boolean }>('SELECT id, label, is_primary FROM pm.contact_emails WHERE contact_id = $1', [C]);
  check('crm emails mcp: set_contact_emails keeps the row by id, relabels it, drops the one left out', trimmed.listed && trimmed.result.ok === true
    && after.length === 1 && after[0].id === work.id && after[0].label === 'Main' && after[0].is_primary === true, { trimmed: trimmed.result, after });
  const listedEmails = await tool(readerKey, 'list_contact_emails', { contact_id: C });
  check('crm emails mcp: list_contact_emails reads them with contacts.read', listedEmails.result.ok === true && listedEmails.result.data?.length === 1, listedEmails.result);
  const twice = await call(h_(contactEmails.PUT), ownerKey, 'PUT', `/api/v1/contacts/${C}/emails`, { id: C }, { emails: [{ email: 'a@x.example' }, { email: 'A@x.example' }] });
  check('crm emails: the same address twice is 409 and nothing changes', twice.status === 409
    && (await q('SELECT 1 FROM pm.contact_emails WHERE contact_id = $1', [C])).length === 1, twice.json);
  const emailsRefused = await call(h_(contactEmails.PUT), readerKey, 'PUT', `/api/v1/contacts/${C}/emails`, { id: C }, { emails: [] });
  check('crm emails: REST save without contacts.manage is 403', emailsRefused.status === 403
    && (await q('SELECT 1 FROM pm.contact_emails WHERE contact_id = $1', [C])).length === 1, emailsRefused.json);

  // Leads
  const lead = await tool(ownerKey, 'create_lead', { name: 'Crm Orchard Lead', company: 'Orchard Ltd', status: 'qualified' });
  const L = lead.result.data?.id as string;
  check('crm leads mcp: create_lead makes the lead', lead.listed && lead.result.ok === true
    && (await q<{ status: string }>('SELECT status FROM pm.leads WHERE id = $1', [L]))[0]?.status === 'qualified', lead.result);
  const archived = await tool(ownerKey, 'archive_lead', { lead_id: L });
  check('crm leads mcp: archive_lead sets archived_at', archived.result.ok === true
    && !!(await q<{ archived_at: string | null }>('SELECT archived_at FROM pm.leads WHERE id = $1', [L]))[0]?.archived_at, archived.result);
  const unarchived = await tool(ownerKey, 'unarchive_lead', { lead_id: L });
  check('crm leads mcp: unarchive_lead clears it', unarchived.result.ok === true
    && (await q<{ archived_at: string | null }>('SELECT archived_at FROM pm.leads WHERE id = $1', [L]))[0]?.archived_at === null, unarchived.result);
  const archiveRefused = await call(h_(leadArchive.POST), readerKey, 'POST', `/api/v1/leads/${L}/archive`, { id: L });
  check('crm leads: REST archive without leads.manage is 403, still live', archiveRefused.status === 403
    && (await q<{ archived_at: string | null }>('SELECT archived_at FROM pm.leads WHERE id = $1', [L]))[0]?.archived_at === null, archiveRefused.json);
  const fields = await tool(ownerKey, 'set_lead_fields', { lead_id: L, fields: [{ field_key: 'budget', value: '20k' }] });
  check('crm leads mcp: set_lead_fields writes a custom field', fields.result.ok === true
    && (await q("SELECT 1 FROM pm.lead_fields WHERE lead_id = $1 AND field_key = 'budget' AND value = '20k'", [L])).length === 1, fields.result);
  const proposal = await tool(ownerKey, 'create_lead_proposal', { lead_id: L, title: 'Crm phase one', estimated_value: 20000 });
  check('crm leads mcp: create_lead_proposal adds a proposal', proposal.result.ok === true
    && (await q("SELECT 1 FROM pm.lead_proposals WHERE lead_id = $1 AND title = 'Crm phase one'", [L])).length === 1, proposal.result);
  const linked = await tool(ownerKey, 'add_lead_contact', { lead_id: L, contact_id: W, role: 'Decision maker' });
  const leadContacts = await tool(readerKey, 'list_lead_contacts', { lead_id: L });
  check('crm leads mcp: add_lead_contact links a contact, list_lead_contacts reads it', linked.result.ok === true && leadContacts.result.ok === true
    && (leadContacts.result.data ?? []).some((row: Row) => row.contact_id === W), { linked: linked.result, list: leadContacts.result });
  await tool(ownerKey, 'log_lead_interaction', { lead_id: L, title: 'Crm intro call', type: 'call' });
  const interactions = await tool(readerKey, 'list_lead_interactions', { lead_id: L, type: 'call' });
  const I = (interactions.result.data ?? [])[0]?.id as string;
  const interactionEdit = await tool(ownerKey, 'update_lead_interaction', { lead_id: L, interaction_id: I, completed: true });
  check('crm leads mcp: list_lead_interactions finds it and update_lead_interaction completes it', interactions.result.ok === true && !!I
    && interactionEdit.result.ok === true && (await q<{ completed: boolean }>('SELECT completed FROM pm.lead_interactions WHERE id = $1', [I]))[0]?.completed === true,
  { interactions: interactions.result, edit: interactionEdit.result });
  const readerLeadWrite = await tool(readerKey, 'update_lead', { lead_id: L, notes: 'x' });
  check('crm leads mcp: update_lead is not listed for a read-only key and refuses', !readerLeadWrite.listed && readerLeadWrite.result.ok !== true, readerLeadWrite.result);
  const converted = await tool(ownerKey, 'convert_lead', { lead_id: L, project_name: 'Crm Orchard Build' });
  const project = (await q<{ id: string }>("SELECT id FROM pm.projects WHERE name = 'Crm Orchard Build' AND deleted_at IS NULL"))[0];
  check('crm leads mcp: convert_lead makes the project and marks the lead won', converted.result.ok === true && !!project
    && converted.result.data?.project?.id === project?.id
    && (await q<{ status: string }>('SELECT status FROM pm.leads WHERE id = $1', [L]))[0]?.status === 'won', converted.result);
  const convertedAgain = await tool(ownerKey, 'convert_lead', { lead_id: L, project_name: 'Crm Orchard Build Again' });
  check('crm leads mcp: converting twice is 409', convertedAgain.result.ok !== true && convertedAgain.result.status === 409, convertedAgain.result);

  // Identities
  const addedId = await tool(ownerKey, 'add_identity', { identities: [{ member_id: members.member, provider: 'slack', external_id: 'U-CRM-1', workspace_id: 'T-CRM' }] });
  const identity = (await q<{ id: string; member_id: string }>("SELECT id, member_id FROM pm.member_identities WHERE external_id = 'U-CRM-1'"))[0];
  check('crm identities mcp: add_identity links the account to the member', addedId.listed && addedId.result.ok === true && identity?.member_id === members.member, addedId.result);
  const moved = await tool(ownerKey, 'move_identity', { identity_id: identity.id, to_member_id: members.admin });
  check('crm identities mcp: move_identity moves it to another member', moved.result.ok === true
    && (await q<{ member_id: string }>("SELECT member_id FROM pm.member_identities WHERE external_id = 'U-CRM-1'"))[0]?.member_id === members.admin, moved.result);
  const memberTeamKey = await key(members.member, ['team.read', 'team.manage', 'identities.read']);
  const idRefused = await call(h_(identities.POST), memberTeamKey, 'POST', '/api/v1/identities', {}, { identities: [{ member_id: members.member, provider: 'slack', external_id: 'U-CRM-2' }] });
  check('crm identities: REST add from a member (no team.manage on the api) is 403, nothing linked', idRefused.status === 403
    && (await q("SELECT 1 FROM pm.member_identities WHERE external_id = 'U-CRM-2'")).length === 0, idRefused.json);
  const movedId = (await q<{ id: string }>("SELECT id FROM pm.member_identities WHERE external_id = 'U-CRM-1'"))[0].id;
  const moveRefused = await call(h_(identityMove.POST), readerKey, 'POST', `/api/v1/identities/${movedId}/move`, { id: movedId }, { member_id: members.member });
  check('crm identities: REST move without team.manage is 403', moveRefused.status === 403, moveRefused.json);
  const removed = await tool(ownerKey, 'remove_identity', { identity_id: movedId });
  check('crm identities mcp: remove_identity unlinks it', removed.result.ok === true
    && (await q("SELECT 1 FROM pm.member_identities WHERE external_id = 'U-CRM-1'")).length === 0, removed.result);

  // Templates: runs
  const template = (await q<{ id: string }>(`INSERT INTO pm.task_templates (name, fields, key_dates, roles, items, created_by) VALUES ('Crm Launch Kit', '[]', '[{"key":"start","label":"Start"}]', '[]', '[{"key":"a","title":"A"}]', $1) RETURNING id`, [members.owner]))[0].id;
  const run = (await q<{ id: string }>(`INSERT INTO pm.task_template_runs (template_id, template_version, snapshot, project_id, via, key_dates, task_ids, start_date)
    VALUES ($1, 1, '{}', $2, 'api', '{"start":"2027-02-01"}', '{}', '2027-02-01') RETURNING id`, [template, project.id]))[0].id;
  const runs = await tool(ownerKey, 'list_template_runs', { template_id: template });
  check('crm templates mcp: list_template_runs lists the run', runs.listed && runs.result.ok === true
    && (runs.result.data ?? []).some((row: Row) => row.id === run), runs.result);
  const runsRefused = await call(h_(templateRuns.GET), readerKey, 'GET', `/api/v1/task-templates/${template}/runs`, { id: template });
  check('crm templates: REST runs without tasks.create or templates.manage is 403', runsRefused.status === 403, runsRefused.json);

  // Move to Trash
  const deleteRefused = await tool(readerKey, 'delete_contact', { contact_id: W });
  check('crm trash mcp: delete_contact is not listed without contacts.manage, and the contact stays live', !deleteRefused.listed && deleteRefused.result.ok !== true
    && (await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.contacts WHERE id = $1', [W]))[0]?.deleted_at === null, deleteRefused.result);
  const deleted = await tool(ownerKey, 'delete_contact', { contact_id: W });
  check('crm trash mcp: delete_contact moves the contact to Trash (deleted_at set)', deleted.listed && deleted.result.ok === true
    && !!(await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.contacts WHERE id = $1', [W]))[0]?.deleted_at, deleted.result);
  const back = await tool(ownerKey, 'restore_from_trash', { record_type: 'contacts', id: W });
  check('crm trash mcp: restore_from_trash brings it back', back.result.ok === true
    && (await q<{ deleted_at: string | null }>('SELECT deleted_at FROM pm.contacts WHERE id = $1', [W]))[0]?.deleted_at === null, back.result);
  const restDeleteRefused = await call(h_(contact.DELETE), readerKey, 'DELETE', `/api/v1/contacts/${W}`, { id: W });
  check('crm trash: REST delete without contacts.manage is 403', restDeleteRefused.status === 403, restDeleteRefused.json);

  // Money and team writes: no agent holds them by default
  const agentMoneyKey = await key(members.agent, ['invoices.read', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'time.approve', 'team.manage', 'projects.read']);
  const agentTools = await toolNames(agentMoneyKey);
  const moneyTools = ['create_invoice', 'update_invoice', 'delete_invoice', 'record_invoice_payment', 'add_hourly_rate', 'review_time_entries', 'add_team_member', 'update_team_member', 'remove_team_member', 'add_identity'];
  check('crm money: an agent key sees no money or team write tool, even with those scopes on the key', moneyTools.every((name) => !agentTools.includes(name)), agentTools.filter((name) => moneyTools.includes(name)));
  const agentInvoice = await tool(agentMoneyKey, 'create_invoice', { project_id: project.id, invoice_number: 'CRM-1', amount: 0, date: '2027-02-01' });
  const restAgentInvoice = await call(h_(projectInvoices.POST), agentMoneyKey, 'POST', `/api/v1/projects/${project.id}/invoices`, { id: project.id }, { invoice_number: 'CRM-2', amount: 0, date: '2027-02-01' });
  check('crm money: create_invoice and its REST route refuse an agent key, nothing made', agentInvoice.result.ok !== true && restAgentInvoice.status === 403
    && (await q("SELECT 1 FROM pm.project_invoices WHERE invoice_number IN ('CRM-1', 'CRM-2')")).length === 0, { mcp: agentInvoice.result, rest: restAgentInvoice.json });
  const agentReview = await call(h_(timeReview.POST), agentMoneyKey, 'POST', `/api/v1/projects/${project.id}/time-entries/review`, { id: project.id }, { entry_ids: [project.id], decision: 'approved' });
  check('crm money: time review refuses an agent key (403)', agentReview.status === 403, agentReview.json);
  const invoicesOver = await tool(ownerKey, 'list_invoices', { project_id: project.id });
  check('crm money mcp: list_invoices answers for an invoices.read key', invoicesOver.listed && invoicesOver.result.ok === true && Array.isArray(invoicesOver.result.data), invoicesOver.result);
  const held = await q<{ permission_key: string }>(`SELECT permission_key FROM pm.role_permissions WHERE role = 'agent' AND access_channel = 'api'
    AND permission_key IN ('team.manage', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'time.approve')`);
  check('crm money: the agent role\'s api defaults hold none of team.manage, invoices.manage, invoices.record_payments, billing.manage, time.approve', held.length === 0, held);
}
