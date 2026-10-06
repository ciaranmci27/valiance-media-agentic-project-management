import { promises as dns } from 'node:dns';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { isHostname, normalizeAddress, validateClientSenderAddress } from './addresses';
import { mergeClientSenders, type ProjectContactAddress } from './mapping';
import { validateClientDomain } from './public-domains';
import { assertId, InboxError, ownAddresses, type InboxContext } from './inbox-service';
import type { InboxSettingsRequest, ProjectAddressPatch, ProjectAddressRequest } from './schemas';
import type {
  AgentReadableType, ClientEmailDomain, ClientSenderAddress, ClientSenderAddressList, InboxSettings, InboxSettingsList, MxStatus, ProjectEmailAddress, ProjectEmailAddressList,
} from './inbox-types';

/**
 * Settings > Email inboxes, and the client email domains and addresses on a project. Inboxes
 * are enabled or disabled, never deleted here: a message's inbox is ON DELETE
 * RESTRICT, and retention removes files before rows. Changing an inbox's
 * routing local part or domain clears verified_at (the database does it), so
 * the forwarder must be verified again.
 */

type Row = Record<string, unknown>;

const INBOX_COLUMNS = 'id, name, address, routing_local_part, routing_domain, routing_address, handler_member_id, enabled, retention_days, max_attachment_mb, agent_readable_types, summary_interval_minutes, filter_auto_mail, verification_code, verified_at, last_received_at, last_error, last_error_at, created_at';

function requireManage(ctx: InboxContext) {
  if (!accessAllows(ctx.access, 'inbound_email.manage')) throw new InboxError(403, 'Forbidden');
}

async function many<T extends Row>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

export async function relayDomain(service: SupabaseClient): Promise<{ id: unknown; domain: string } | null> {
  const { data, error } = await service.from('business_settings').select('id, inbound_email_domain').limit(1).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, domain: data.inbound_email_domain as string } : null;
}

async function messageCount(service: SupabaseClient, inboxId: string): Promise<number> {
  const { count, error } = await service.from('email_messages').select('id', { count: 'exact', head: true }).eq('inbox_id', inboxId);
  if (error) throw error;
  return count ?? 0;
}

async function projectAddressCount(service: SupabaseClient, inboxId: string): Promise<number> {
  const { count, error } = await service.from('email_project_addresses').select('id', { count: 'exact', head: true }).eq('inbox_id', inboxId);
  if (error) throw error;
  return count ?? 0;
}

function present(row: Row, access: string[], messages: number, projectAddresses: number): InboxSettings {
  return {
    id: row.id as string,
    name: row.name as string,
    address: row.address as string,
    routing_local_part: row.routing_local_part as string,
    routing_domain: row.routing_domain as string,
    routing_address: row.routing_address as string,
    handler_member_id: (row.handler_member_id as string | null) ?? null,
    enabled: Boolean(row.enabled),
    retention_days: Number(row.retention_days),
    max_attachment_mb: Number(row.max_attachment_mb),
    agent_readable_types: ((row.agent_readable_types as string[] | null) ?? []) as AgentReadableType[],
    summary_interval_minutes: Number(row.summary_interval_minutes),
    filter_auto_mail: Boolean(row.filter_auto_mail),
    verification_code: row.verification_code as string,
    verified_at: (row.verified_at as string | null) ?? null,
    last_received_at: (row.last_received_at as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    last_error_at: (row.last_error_at as string | null) ?? null,
    access_member_ids: access,
    message_count: messages,
    project_address_count: projectAddresses,
    created_at: row.created_at as string,
  };
}

export async function listInboxSettings(ctx: InboxContext): Promise<InboxSettingsList> {
  requireManage(ctx);
  const [relay, inboxes, access] = await Promise.all([
    relayDomain(ctx.service),
    many<Row>(ctx.service.from('email_inboxes').select(INBOX_COLUMNS).order('created_at')),
    many<{ inbox_id: string; member_id: string }>(ctx.service.from('email_inbox_access').select('inbox_id, member_id')),
  ]);
  const [counts, addressCounts] = await Promise.all([
    Promise.all(inboxes.map((inbox) => messageCount(ctx.service, inbox.id as string))),
    Promise.all(inboxes.map((inbox) => projectAddressCount(ctx.service, inbox.id as string))),
  ]);
  return {
    relay_domain: relay?.domain ?? '',
    inboxes: inboxes.map((inbox, index) => present(
      inbox,
      access.filter((row) => row.inbox_id === inbox.id).map((row) => row.member_id),
      counts[index],
      addressCounts[index],
    )),
  };
}

async function validate(ctx: InboxContext, input: InboxSettingsRequest) {
  const address = normalizeAddress(input.address);
  if (!address) throw new InboxError(422, 'Enter the public address clients write to, such as ashley@yourdomain.com.');
  if (input.routing_domain && !isHostname(input.routing_domain)) throw new InboxError(422, 'Enter a routing domain such as relay.yourdomain.com.');
  const memberIds = [...new Set([...input.access_member_ids, ...(input.handler_member_id ? [input.handler_member_id] : [])])];
  if (memberIds.length) {
    const found = await many<{ id: string }>(ctx.service.from('team_members').select('id').in('id', memberIds));
    if (found.length !== memberIds.length) throw new InboxError(422, 'Every person with access must be a team member');
  }
  return { address, memberIds };
}

async function setAccess(ctx: InboxContext, inboxId: string, memberIds: string[]) {
  const current = (await many<{ member_id: string }>(ctx.service.from('email_inbox_access').select('member_id').eq('inbox_id', inboxId)))
    .map((row) => row.member_id);
  const removed = current.filter((id) => !memberIds.includes(id));
  const added = memberIds.filter((id) => !current.includes(id));
  if (removed.length) {
    const { error } = await ctx.service.from('email_inbox_access').delete().eq('inbox_id', inboxId).in('member_id', removed);
    if (error) throw error;
  }
  if (added.length) {
    const { error } = await ctx.service.from('email_inbox_access').insert(added.map((member_id) => ({ inbox_id: inboxId, member_id, created_by: ctx.memberId })));
    if (error) throw error;
  }
}

function friendly(error: unknown): never {
  const value = error as { code?: string; message?: string };
  if (value?.code === '23505') {
    // email_routing_address_guard: the address belongs to the other table.
    if (value.message?.includes('EMAIL_ROUTING_ADDRESS_TAKEN')) {
      throw new InboxError(409, value.message.includes('project email address')
        ? 'A project email address already uses that routing address.'
        : 'An inbox already uses that routing address.');
    }
    if (value.message?.includes('email_project_addresses_routing_address_key')) throw new InboxError(409, 'Another project email address already uses that routing address.');
    if (value.message?.includes('routing_address')) throw new InboxError(409, 'Another inbox already uses that routing address.');
    throw new InboxError(409, 'That value is already in use.');
  }
  if (value?.code === '23514') throw new InboxError(422, 'One of the values is not allowed. Check the address, routing address and limits.');
  throw error;
}

async function inboxById(ctx: InboxContext, id: string): Promise<InboxSettings> {
  const { data, error } = await ctx.service.from('email_inboxes').select(INBOX_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new InboxError(404, 'Inbox not found');
  const access = (await many<{ member_id: string }>(ctx.service.from('email_inbox_access').select('member_id').eq('inbox_id', id))).map((row) => row.member_id);
  const [messages, projectAddresses] = await Promise.all([messageCount(ctx.service, id), projectAddressCount(ctx.service, id)]);
  return present(data as Row, access, messages, projectAddresses);
}

export async function createInbox(ctx: InboxContext, input: InboxSettingsRequest): Promise<InboxSettings> {
  requireManage(ctx);
  const { address, memberIds } = await validate(ctx, input);
  const { data, error } = await ctx.service.from('email_inboxes').insert({
    name: input.name,
    address,
    // Empty values take the defaults: the address's local part, the relay domain.
    routing_local_part: input.routing_local_part || '',
    routing_domain: input.routing_domain || '',
    handler_member_id: input.handler_member_id,
    enabled: input.enabled,
    retention_days: input.retention_days,
    max_attachment_mb: input.max_attachment_mb,
    agent_readable_types: input.agent_readable_types,
    summary_interval_minutes: input.summary_interval_minutes,
    filter_auto_mail: input.filter_auto_mail,
    created_by: ctx.memberId,
  }).select('id').single();
  if (error) friendly(error);
  const id = (data as { id: string }).id;
  await setAccess(ctx, id, memberIds);
  return inboxById(ctx, id);
}

export async function updateInbox(ctx: InboxContext, inboxId: string, input: InboxSettingsRequest): Promise<InboxSettings> {
  requireManage(ctx);
  const id = assertId(inboxId, 'inbox id');
  await inboxById(ctx, id);
  const { address, memberIds } = await validate(ctx, input);
  const { error } = await ctx.service.from('email_inboxes').update({
    name: input.name,
    address,
    routing_local_part: input.routing_local_part || '',
    routing_domain: input.routing_domain || '',
    handler_member_id: input.handler_member_id,
    enabled: input.enabled,
    retention_days: input.retention_days,
    max_attachment_mb: input.max_attachment_mb,
    agent_readable_types: input.agent_readable_types,
    summary_interval_minutes: input.summary_interval_minutes,
    filter_auto_mail: input.filter_auto_mail,
  }).eq('id', id);
  if (error) friendly(error);
  await setAccess(ctx, id, memberIds);
  return inboxById(ctx, id);
}

export async function setRelayDomain(ctx: InboxContext, domain: string): Promise<{ relay_domain: string }> {
  requireManage(ctx);
  const value = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!isHostname(value)) throw new InboxError(422, 'Enter a domain such as relay.yourdomain.com.');
  const current = await relayDomain(ctx.service);
  if (!current) throw new InboxError(404, 'Business settings not found');
  const { error } = await ctx.service.from('business_settings').update({ inbound_email_domain: value }).eq('id', current.id as string);
  if (error) friendly(error);
  return { relay_domain: value };
}

/** Is there an MX record for the routing domain? A server-side DNS lookup, never cached. */
export async function lookupMx(ctx: InboxContext, domainInput: string, resolve: (domain: string) => Promise<{ exchange: string; priority: number }[]> = dns.resolveMx): Promise<MxStatus> {
  requireManage(ctx);
  const domain = domainInput.trim().toLowerCase().replace(/\.$/, '');
  if (!isHostname(domain)) throw new InboxError(422, 'Enter a domain such as relay.yourdomain.com.');
  try {
    const records = await Promise.race([
      resolve(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), 5000)),
    ]);
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    return { domain, found: sorted.length > 0, records: sorted, error: null };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') return { domain, found: false, records: [], error: null };
    return { domain, found: false, records: [], error: code === 'ETIMEOUT' ? 'The DNS lookup timed out' : 'The DNS lookup failed' };
  }
}

// -- Client email domains (on a project) -----------------------------------

function canReadDomains(ctx: InboxContext): boolean {
  return ['contacts.read', 'contacts.read_all', 'contacts.manage', 'inbound_email.read', 'inbound_email.manage']
    .some((key) => accessAllows(ctx.access, key as Parameters<typeof accessAllows>[1]));
}

function canManageDomains(ctx: InboxContext): boolean {
  return ctx.access.role !== 'agent'
    && (accessAllows(ctx.access, 'contacts.manage') || accessAllows(ctx.access, 'inbound_email.manage'));
}

function requireProject(ctx: InboxContext, projectId: string): string {
  const id = assertId(projectId, 'project id');
  if (!accessAllowsProject(ctx.access, id)) throw new InboxError(403, 'Project access denied');
  return id;
}

export async function listClientDomains(ctx: InboxContext, projectId: string): Promise<ClientEmailDomain[]> {
  const id = requireProject(ctx, projectId);
  if (!canReadDomains(ctx)) throw new InboxError(403, 'Forbidden');
  return many<ClientEmailDomain & Row>(ctx.service.from('email_client_domains').select('id, domain, project_id, created_at').eq('project_id', id).order('domain'));
}

export async function addClientDomain(ctx: InboxContext, projectId: string, input: string): Promise<ClientEmailDomain> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const valid = validateClientDomain(input);
  if (!valid.ok) throw new InboxError(422, valid.error);
  const existing = await many<{ id: string }>(ctx.service.from('email_client_domains').select('id').eq('project_id', id).eq('domain', valid.domain));
  if (existing.length) throw new InboxError(409, `${valid.domain} is already on this project.`);
  const { data, error } = await ctx.service.from('email_client_domains')
    .insert({ domain: valid.domain, project_id: id, created_by: ctx.memberId })
    .select('id, domain, project_id, created_at').single();
  if (error) friendly(error);
  return data as ClientEmailDomain;
}

export async function removeClientDomain(ctx: InboxContext, projectId: string, domainId: string): Promise<void> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const target = assertId(domainId, 'domain id');
  const removed = await many<{ id: string }>(ctx.service.from('email_client_domains').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Domain not found');
}

// -- Client email addresses (on a project) ----------------------------------
// Who sends the project mail, one exact address at a time: every address of
// the project's contacts (read here, managed in Contacts) and client email
// addresses added on the project (email_client_addresses, public email
// services included). The same people as client domains read and manage
// them; contact names and ids only reach members who can read contacts.

const SENDER_COLUMNS = 'id, address, project_id, created_at';

function canReadContacts(ctx: InboxContext): boolean {
  return ['contacts.read', 'contacts.read_all', 'contacts.manage']
    .some((key) => accessAllows(ctx.access, key as Parameters<typeof accessAllows>[1]));
}

/** Every address of every contact on the project. */
async function projectContactAddresses(service: SupabaseClient, projectId: string): Promise<ProjectContactAddress[]> {
  const links = await many<{ contact_id: string }>(service.from('project_contacts').select('contact_id').eq('project_id', projectId));
  const ids = [...new Set(links.map((link) => link.contact_id))];
  if (ids.length === 0) return [];
  const [emails, contacts] = await Promise.all([
    many<{ contact_id: string; email: string }>(service.from('contact_emails').select('contact_id, email').in('contact_id', ids)),
    many<{ id: string; name: string | null }>(service.from('contacts').select('id, name').in('id', ids)),
  ]);
  const nameOf = new Map(contacts.map((contact) => [contact.id, contact.name?.trim() || '']));
  return emails.map((row) => ({ address: row.email, contact_id: row.contact_id, contact_name: nameOf.get(row.contact_id) ?? '' }));
}

function presentSender(row: Row): ClientSenderAddress {
  return {
    address: row.address as string,
    source: 'manual',
    id: row.id as string,
    contact_id: null,
    contact_name: null,
    created_at: row.created_at as string,
  };
}

export async function listClientSenders(ctx: InboxContext, projectId: string): Promise<ClientSenderAddressList> {
  const id = requireProject(ctx, projectId);
  if (!canReadDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const [manual, contactAddresses] = await Promise.all([
    many<{ id: string; address: string; created_at: string }>(ctx.service.from('email_client_addresses').select(SENDER_COLUMNS).eq('project_id', id)),
    projectContactAddresses(ctx.service, id),
  ]);
  return { addresses: mergeClientSenders(contactAddresses, manual, canReadContacts(ctx)) };
}

export async function addClientSender(ctx: InboxContext, projectId: string, input: string): Promise<ClientSenderAddress> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const valid = validateClientSenderAddress(input);
  if (!valid.ok) throw new InboxError(422, valid.error);
  if ((await ownAddresses(ctx.service)).has(valid.address)) {
    throw new InboxError(422, `${valid.address} is one of your own addresses, not a client's.`);
  }
  const [existing, contactAddresses] = await Promise.all([
    many<{ id: string }>(ctx.service.from('email_client_addresses').select('id').eq('project_id', id).eq('address', valid.address)),
    projectContactAddresses(ctx.service, id),
  ]);
  if (existing.length) throw new InboxError(409, `${valid.address} is already on this project.`);
  if (contactAddresses.some((row) => row.address === valid.address)) {
    throw new InboxError(409, `${valid.address} belongs to a contact on this project, so it already routes here.`);
  }
  const { data, error } = await ctx.service.from('email_client_addresses')
    .insert({ address: valid.address, project_id: id, created_by: ctx.memberId })
    .select(SENDER_COLUMNS).single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new InboxError(409, `${valid.address} is already on this project.`);
    friendly(error);
  }
  return presentSender(data as Row);
}

export async function removeClientSender(ctx: InboxContext, projectId: string, senderId: string): Promise<void> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const target = assertId(senderId, 'sender id');
  const removed = await many<{ id: string }>(ctx.service.from('email_client_addresses').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Address not found');
}

// -- Project email addresses (on a project) ---------------------------------
// The same people as client domains: whoever reads those reads these, and
// whoever manages those manages these.

const ADDRESS_COLUMNS = 'id, project_id, inbox_id, routing_local_part, routing_domain, routing_address, public_address, enabled, last_received_at, created_at, updated_at';
const NEEDS_ROUTING = 'Enter the routing address, such as p4tf, or a public address to take it from.';

function presentAddress(row: Row): ProjectEmailAddress {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    inbox_id: row.inbox_id as string,
    routing_local_part: row.routing_local_part as string,
    routing_domain: row.routing_domain as string,
    routing_address: row.routing_address as string,
    public_address: (row.public_address as string | null) ?? null,
    enabled: Boolean(row.enabled),
    last_received_at: (row.last_received_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function requireExistingProject(ctx: InboxContext, projectId: string): Promise<string> {
  const id = requireProject(ctx, projectId);
  const { data, error } = await ctx.service.from('projects').select('id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new InboxError(404, 'Project not found');
  return id;
}

/** The checked values of a create or an edit; fields left out stay as they are. */
async function addressValues(ctx: InboxContext, input: ProjectAddressPatch): Promise<Row> {
  const values: Row = {};
  if (input.inbox_id !== undefined) {
    const { data, error } = await ctx.service.from('email_inboxes').select('id').eq('id', input.inbox_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new InboxError(422, 'Choose the inbox that receives this address.');
    values.inbox_id = input.inbox_id;
  }
  if (input.public_address !== undefined) {
    if (!input.public_address) values.public_address = null;
    else {
      const address = normalizeAddress(input.public_address);
      if (!address) throw new InboxError(422, 'Enter the public address in full, such as p4tf@yourdomain.com.');
      values.public_address = address;
    }
  }
  if (input.routing_local_part !== undefined) values.routing_local_part = input.routing_local_part;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  return values;
}

export async function listProjectAddresses(ctx: InboxContext, projectId: string): Promise<ProjectEmailAddressList> {
  const id = requireProject(ctx, projectId);
  if (!canReadDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const [relay, addresses, inboxes] = await Promise.all([
    relayDomain(ctx.service),
    many<Row>(ctx.service.from('email_project_addresses').select(ADDRESS_COLUMNS).eq('project_id', id).order('created_at')),
    many<{ id: string; name: string; address: string; enabled: boolean }>(ctx.service.from('email_inboxes').select('id, name, address, enabled').order('created_at')),
  ]);
  return { relay_domain: relay?.domain ?? '', addresses: addresses.map(presentAddress), inboxes };
}

export async function addProjectAddress(ctx: InboxContext, projectId: string, input: ProjectAddressRequest): Promise<ProjectEmailAddress> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  await requireExistingProject(ctx, id);
  const values = await addressValues(ctx, input);
  if (!values.routing_local_part && !values.public_address) throw new InboxError(422, NEEDS_ROUTING);
  const { data, error } = await ctx.service.from('email_project_addresses').insert({
    ...values,
    project_id: id,
    // Empty takes the relay domain (email_project_addresses_before_write).
    routing_domain: '',
    created_by: ctx.memberId,
  }).select(ADDRESS_COLUMNS).single();
  if (error) friendly(error);
  return presentAddress(data as Row);
}

/** Edits in place: a new routing address retires the old one at once. */
export async function updateProjectAddress(ctx: InboxContext, projectId: string, addressId: string, input: ProjectAddressPatch): Promise<ProjectEmailAddress> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const target = assertId(addressId, 'address id');
  const { data: current, error: currentError } = await ctx.service.from('email_project_addresses')
    .select('public_address').eq('id', target).eq('project_id', id).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new InboxError(404, 'Address not found');
  const values = await addressValues(ctx, input);
  const publicAddress = values.public_address !== undefined ? values.public_address : current.public_address;
  if (values.routing_local_part === '' && !publicAddress) throw new InboxError(422, NEEDS_ROUTING);
  const { data, error } = await ctx.service.from('email_project_addresses').update(values)
    .eq('id', target).eq('project_id', id).select(ADDRESS_COLUMNS);
  if (error) friendly(error);
  const row = ((data ?? []) as Row[])[0];
  if (!row) throw new InboxError(404, 'Address not found');
  return presentAddress(row);
}

/** Threads it filed keep their project; only their link to the address goes. */
export async function removeProjectAddress(ctx: InboxContext, projectId: string, addressId: string): Promise<void> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const target = assertId(addressId, 'address id');
  const removed = await many<{ id: string }>(ctx.service.from('email_project_addresses').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Address not found');
}
