import type { Harness } from './harness';

/**
 * Email setup over REST and MCP (Settings > Email, your own inbox, a
 * project's email), by the app's own functions: whoever manages inboxes
 * (an Owner on the API) sets up shared inboxes, addresses, domains and the
 * relay domain; an admin whose key carries the inbox scopes but who does not
 * manage inboxes is refused, as is an agent; a key without the scope is
 * refused by withApi. Your own inbox is a person's: a member's own key makes
 * one, an agent (company or personal) is refused and never sees the tools.
 * A project's sender domains and addresses are read by inbox readers and
 * written by people only, and refused while the Inbox is off.
 */
export async function emailArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const inboxes = await import('../../src/app/api/v1/inbox/inboxes/route');
  const inbox = await import('../../src/app/api/v1/inbox/inboxes/[id]/route');
  const mx = await import('../../src/app/api/v1/inbox/mx-check/route');
  const relay = await import('../../src/app/api/v1/inbox/relay-domain/route');
  const addresses = await import('../../src/app/api/v1/inbox/addresses/route');
  const domains = await import('../../src/app/api/v1/inbox/domains/route');
  const myInboxes = await import('../../src/app/api/v1/me/inboxes/route');
  const myInbox = await import('../../src/app/api/v1/me/inboxes/[id]/route');
  const projectDomains = await import('../../src/app/api/v1/projects/[id]/email-domains/route');
  const projectSenders = await import('../../src/app/api/v1/projects/[id]/email-senders/route');
  const projectAddresses = await import('../../src/app/api/v1/projects/[id]/email-addresses/route');

  const one = async <T = { id: string }>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const P = (await one("INSERT INTO pm.projects (name) VALUES ('Parity Email Co') RETURNING id")).id;
  // The agent works on the project, so what refuses its writes is the people-only rule, not its reach.
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [P, members.agent]);
  const INBOX_SCOPES = ['inbound_email.read', 'inbound_email.triage'];
  // The admin carries the inbox scopes on the API but does not manage inboxes there (Owners do by default).
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [members.admin, INBOX_SCOPES]);
  const settingsBefore = await one<{ inbound_email_domain: string | null; assistants_enabled: boolean }>('SELECT inbound_email_domain, assistants_enabled FROM pm.business_settings LIMIT 1');
  // A personal agent must be live to reach the people-only refusal.
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  const ownerKey = await key(members.owner, [...INBOX_SCOPES, 'tasks.read', 'projects.read', 'projects.read_all', 'contacts.read', 'contacts.manage']);
  const ownerReadOnly = await key(members.owner, ['inbound_email.read', 'tasks.read']);
  const adminKey = await key(members.admin, [...INBOX_SCOPES, 'tasks.read']);
  const memberKey = await key(members.member, ['tasks.read']);
  const agentKey = await key(members.agent, [...INBOX_SCOPES, 'tasks.read']);
  const personalKey = await key(members.personal, [...INBOX_SCOPES, 'tasks.read']);
  const form = (name: string, address: string) => ({
    name, address, routing_local_part: '', routing_domain: '', handler_member_id: null, enabled: true, retention_days: 30,
    max_attachment_mb: 10, agent_readable_types: [], summary_interval_minutes: 60, filter_auto_mail: true, access_member_ids: [],
  });
  const auditRows = async (endpoint: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await q<{ team_member_id: string }>('SELECT team_member_id FROM pm.api_audit_log WHERE endpoint = $1', [endpoint]);
      if (rows.length) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [];
  };

  try {
    // ── The relay domain and shared inboxes ───────────────────────────
    const relaySet = await call(relay.PUT, ownerKey, 'PUT', '/api/v1/inbox/relay-domain', {}, { domain: 'relay.parity.example' });
    check('email setup: an Owner sets the relay domain', relaySet.status === 200 && relaySet.json.data?.relay_domain === 'relay.parity.example', relaySet.json);
    const relayAdmin = await call(relay.PUT, adminKey, 'PUT', '/api/v1/inbox/relay-domain', {}, { domain: 'relay.other.example' });
    check('email setup: an admin with the inbox scopes who does not manage inboxes is refused (403)', relayAdmin.status === 403, relayAdmin.json);
    const relayNoScope = await call(relay.PUT, ownerReadOnly, 'PUT', '/api/v1/inbox/relay-domain', {}, { domain: 'relay.other.example' });
    check('email setup: an Owner\'s key without inbound_email.triage is refused by withApi (403)', relayNoScope.status === 403, relayNoScope.json);

    const made = await call(inboxes.POST, ownerKey, 'POST', '/api/v1/inbox/inboxes', {}, form('Parity support', 'support@parity.example'));
    const inboxId = made.json.data?.id as string;
    check('email setup: an Owner makes a shared inbox, routed on the relay domain', made.status === 201 && !!inboxId
      && String(made.json.data?.routing_address ?? '').endsWith('@relay.parity.example'), made.json);
    check('email setup: the new inbox is in the audit log as the Owner', (await auditRows('/api/v1/inbox/inboxes')).some((row) => row.team_member_id === members.owner));
    const agentMade = await call(inboxes.POST, agentKey, 'POST', '/api/v1/inbox/inboxes', {}, form('Agent desk', 'agent-desk@parity.example'));
    check('email setup: an agent cannot make an inbox (403)', agentMade.status === 403, agentMade.json);
    const listed = await call(inboxes.GET, ownerKey, 'GET', '/api/v1/inbox/inboxes');
    check('email setup: the Owner lists the inboxes with the relay domain', listed.status === 200
      && JSON.stringify(listed.json.data ?? {}).includes(inboxId) && listed.json.data?.relay_domain === 'relay.parity.example', listed.json);
    const agentList = await call(inboxes.GET, agentKey, 'GET', '/api/v1/inbox/inboxes');
    check('email setup: an agent cannot read the inbox settings (403)', agentList.status === 403, agentList.json);

    const renamed = await tool(ownerKey, 'update_email_inbox', { inbox_id: inboxId, ...form('Parity help desk', 'support@parity.example') });
    const nameNow = (await one<{ name: string }>('SELECT name FROM pm.inboxes WHERE id = $1', [inboxId])).name;
    check('email setup mcp: update_email_inbox renames it', renamed.listed && renamed.result.ok === true && nameNow === 'Parity help desk', renamed.result);
    const mxBad = await call(mx.GET, ownerKey, 'GET', '/api/v1/inbox/mx-check?domain=not%20a%20domain');
    check('email setup: the MX check refuses a value that is not a domain (422), before any lookup', mxBad.status === 422, mxBad.json);
    const mxAgent = await call(mx.GET, agentKey, 'GET', '/api/v1/inbox/mx-check?domain=parity.example');
    check('email setup: an agent cannot run the MX check (403)', mxAgent.status === 403, mxAgent.json);

    // ── Your addresses and domains ─────────────────────────────────────
    const addedOver = await tool(ownerKey, 'add_email_address', { address: 'hello@parity.example', project_id: P, owner_member_id: null, inbox_id: inboxId });
    const addressId = addedOver.result.data?.id as string;
    check('email setup mcp: add_email_address adds an address on the project', addedOver.result.ok === true && !!addressId, addedOver.result);
    const addressList = await call(addresses.GET, ownerKey, 'GET', '/api/v1/inbox/addresses');
    check('email setup: the address is listed with its project', addressList.status === 200
      && (addressList.json.data?.addresses ?? []).some((row: { id: string; project_id?: string }) => row.id === addressId), addressList.json);
    const offOver = await tool(ownerKey, 'update_email_address', { address_id: addressId, enabled: false });
    check('email setup mcp: update_email_address turns it off', offOver.result.ok === true && offOver.result.data?.enabled === false, offOver.result);
    const agentAdd = await call(addresses.POST, agentKey, 'POST', '/api/v1/inbox/addresses', {}, { address: 'sneaky@parity.example', project_id: null, owner_member_id: null });
    check('email setup: an agent cannot add an address (403)', agentAdd.status === 403, agentAdd.json);
    const removedOver = await tool(ownerKey, 'remove_email_address', { address_id: addressId });
    check('email setup mcp: remove_email_address removes it', removedOver.result.ok === true
      && !(await q('SELECT 1 FROM pm.endpoints WHERE id = $1', [addressId])).length, removedOver.result);
    const domainMade = await call(domains.POST, ownerKey, 'POST', '/api/v1/inbox/domains', {}, { domain: 'parity.example' });
    check('email setup: an Owner adds a domain of theirs', domainMade.status === 201 && domainMade.json.data?.domain === 'parity.example', domainMade.json);
    const domainGone = await tool(ownerKey, 'remove_email_domain', { domain_id: domainMade.json.data?.id });
    check('email setup mcp: remove_email_domain removes it', domainGone.result.ok === true, domainGone.result);
    const ignored = await tool(ownerKey, 'ignore_email_address', { address: 'noreply@parity.example' });
    check('email setup mcp: ignore_email_address marks an address not yours', ignored.result.ok === true
      && (await q("SELECT 1 FROM pm.ignored_addresses WHERE address = 'noreply@parity.example'")).length === 1, ignored.result);

    // ── Your own inbox ─────────────────────────────────────────────────
    const mine = await call(myInboxes.POST, memberKey, 'POST', '/api/v1/me/inboxes', {}, { address: 'max@parity-mail.example', handler_member_id: null, enabled: true, access_member_ids: [] });
    const mineId = mine.json.data?.id as string;
    check('my inbox: a member connects their own inbox with their own key', mine.status === 201 && !!mineId
      && (await one<{ owner_member_id: string }>('SELECT owner_member_id FROM pm.inboxes WHERE id = $1', [mineId]))?.owner_member_id === members.member, mine.json);
    const mineList = await call(myInboxes.GET, memberKey, 'GET', '/api/v1/me/inboxes');
    check('my inbox: they list it', mineList.status === 200 && JSON.stringify(mineList.json.data ?? {}).includes(mineId), mineList.json);
    const agentMine = await call(myInboxes.GET, agentKey, 'GET', '/api/v1/me/inboxes');
    const personalMine = await call(myInboxes.POST, personalKey, 'POST', '/api/v1/me/inboxes', {}, { address: 'pa@parity-mail.example', handler_member_id: null, enabled: true, access_member_ids: [] });
    check('my inbox: agents, company and personal, are refused (403 people_only)', agentMine.status === 403 && agentMine.json.error?.details?.reason === 'people_only'
      && personalMine.status === 403 && personalMine.json.error?.details?.reason === 'people_only', { agentMine: agentMine.json, personalMine: personalMine.json });
    const memberTools = await toolNames(memberKey);
    const agentTools = await toolNames(agentKey);
    const personalTools = await toolNames(personalKey);
    check('my inbox mcp: a member sees list_my_inboxes, agents do not', memberTools.includes('list_my_inboxes')
      && !agentTools.includes('list_my_inboxes') && !personalTools.includes('create_my_inbox'), { memberTools: memberTools.filter((n) => /inbox/.test(n)) });
    const switched = await call(inbox.PATCH, ownerKey, 'PATCH', `/api/v1/inbox/inboxes/${mineId}`, { id: mineId }, { enabled: false });
    check('email setup: whoever manages inboxes turns a personal inbox off', switched.status === 200
      && (await one<{ enabled: boolean }>('SELECT enabled FROM pm.inboxes WHERE id = $1', [mineId])).enabled === false, switched.json);
    const agentSwitch = await call(inbox.PATCH, agentKey, 'PATCH', `/api/v1/inbox/inboxes/${mineId}`, { id: mineId }, { enabled: true });
    check('email setup: an agent cannot turn it back on (403)', agentSwitch.status === 403, agentSwitch.json);
    const removedMine = await tool(memberKey, 'remove_my_inbox', { inbox_id: mineId });
    check('my inbox mcp: remove_my_inbox removes it while it holds no mail', removedMine.result.ok === true
      && !(await q('SELECT 1 FROM pm.inboxes WHERE id = $1', [mineId])).length, removedMine.result);
    const strangerRemove = await call(myInbox.DELETE, memberKey, 'DELETE', `/api/v1/me/inboxes/${inboxId}`, { id: inboxId });
    check('my inbox: a shared inbox is never "yours" to remove', strangerRemove.status >= 400 && (await q('SELECT 1 FROM pm.inboxes WHERE id = $1', [inboxId])).length === 1, strangerRemove.json);

    // ── A project's email ──────────────────────────────────────────────
    const domainAdded = await call(projectDomains.POST, ownerKey, 'POST', `/api/v1/projects/${P}/email-domains`, { id: P }, { domain: 'parity-client.example' });
    check('project email: an Owner maps a sender domain to the project', domainAdded.status === 201 && domainAdded.json.data?.domain === 'parity-client.example', domainAdded.json);
    const agentDomain = await call(projectDomains.POST, agentKey, 'POST', `/api/v1/projects/${P}/email-domains`, { id: P }, { domain: 'agent-client.example' });
    check('project email: an agent cannot map one (403 people_only)', agentDomain.status === 403 && agentDomain.json.error?.details?.reason === 'people_only', agentDomain.json);
    const memberDomains = await call(projectDomains.GET, memberKey, 'GET', `/api/v1/projects/${P}/email-domains`, { id: P });
    check('project email: a key with neither contacts.read nor inbound_email.read is refused (403)', memberDomains.status === 403, memberDomains.json);
    const domainList = await tool(ownerKey, 'list_project_email_domains', { project_id: P });
    check('project email mcp: list_project_email_domains lists it', domainList.result.ok === true
      && (domainList.result.data ?? []).some((row: { domain: string }) => row.domain === 'parity-client.example'), domainList.result);
    const senderOver = await tool(ownerKey, 'add_project_email_sender', { project_id: P, address: 'dana@parity-other.example' });
    check('project email mcp: add_project_email_sender maps a sender address', senderOver.result.ok === true, senderOver.result);
    const senders = await call(projectSenders.GET, ownerKey, 'GET', `/api/v1/projects/${P}/email-senders`, { id: P });
    const senderId = (senders.json.data?.addresses ?? []).find((row: { address: string }) => row.address === 'dana@parity-other.example')?.id;
    const senderGone = await tool(ownerKey, 'remove_project_email_sender', { project_id: P, sender_id: senderId });
    check('project email mcp: remove_project_email_sender removes it', !!senderId && senderGone.result.ok === true, { senders: senders.json, senderGone: senderGone.result });
    const projectAddress = await call(projectAddresses.POST, ownerKey, 'POST', `/api/v1/projects/${P}/email-addresses`, { id: P }, { inbox_id: inboxId, routing_local_part: 'parity-email-co', public_address: null, enabled: true });
    check('project email: an Owner gives the project its own address', projectAddress.status === 201 && !!projectAddress.json.data?.id, projectAddress.json);
    check('project email mcp: agents do not see the people-only project email writes', !agentTools.includes('add_project_email_domain') && agentTools.includes('list_project_email_domains'),
      agentTools.filter((n) => /project_email/.test(n)));

    // The Inbox switched off: its settings on a project go with it.
    await q("INSERT INTO pm.workspace_modules (module_id, enabled) VALUES ('inbox', false) ON CONFLICT (module_id) DO UPDATE SET enabled = false");
    try {
      const off = await call(projectDomains.GET, ownerKey, 'GET', `/api/v1/projects/${P}/email-domains`, { id: P });
      const offMine = await call(myInboxes.GET, memberKey, 'GET', '/api/v1/me/inboxes');
      check('project email: with the Inbox off a project\'s email and your own inbox are refused (MODULE_OFF)', off.status === 403 && off.json.error?.code === 'MODULE_OFF'
        && offMine.status === 403 && offMine.json.error?.code === 'MODULE_OFF', { off: off.json, offMine: offMine.json });
      check('project email mcp: with the Inbox off the tools are not listed', !(await toolNames(ownerKey)).includes('list_project_email_domains'));
    } finally {
      await q("UPDATE pm.workspace_modules SET enabled = true WHERE module_id = 'inbox'");
    }
  } finally {
    await q('UPDATE pm.business_settings SET inbound_email_domain = $1, assistants_enabled = $2', [settingsBefore.inbound_email_domain, settingsBefore.assistants_enabled]);
  }
}
