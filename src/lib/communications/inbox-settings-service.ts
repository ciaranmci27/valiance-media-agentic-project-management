import { comms } from '@/lib/communications/db';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { domainOf, isHostname, normalizeAddress, validateClientSenderAddress } from './email/addresses';
import { mergeClientSenders, type ProjectContactAddress } from './mapping';
import { isPublicEmailDomain, validateClientDomain } from './email/public-domains';
import { assertId, InboxError, ownAddresses, type InboxContext } from './inbox-service';
import type { InboxSettingsRequest, ProjectAddressPatch, ProjectAddressRequest, YourAddressPatch, YourAddressRequest } from './schemas';
import type {
  AgentReadableType, ClientEmailDomain, ClientSenderAddress, ClientSenderAddressList, InboxSettings, InboxSettingsList, MxStatus, ProjectEmailAddress, ProjectEmailAddressList,
  OwnDomain, UnlistedAddress, UnlistedDomain, YourAddress, YourAddressList,
} from './inbox-types';

/**
 * Settings > Email inboxes, and the client email domains and addresses on a project. Inboxes
 * are enabled or disabled, never deleted here: a message's inbox is ON DELETE
 * RESTRICT, and retention removes files before rows. Changing an inbox's
 * routing local part or domain clears verified_at (the database does it), so
 * the forwarder must be verified again.
 */

type Row = Record<string, unknown>;

const INBOX_COLUMNS = 'id, name, address, routing_local_part, routing_domain, routing_address, handler_member_id, enabled, retention_days, max_attachment_mb, agent_readable_types, summary_interval_minutes, filter_auto_mail, aliases, triage_mode, verification_code, verified_at, last_received_at, last_error, last_error_at, created_at';

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
  const { count, error } = await comms(service).from('messages').select('id', { count: 'exact', head: true }).eq('inbox_id', inboxId);
  if (error) throw error;
  return count ?? 0;
}

async function projectAddressCount(service: SupabaseClient, inboxId: string): Promise<number> {
  const { count, error } = await comms(service).from('endpoints').select('id', { count: 'exact', head: true }).eq('inbox_id', inboxId);
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
    aliases: (row.aliases as string[] | null) ?? [],
    triage_mode: ((row.triage_mode as string | null) ?? 'legacy') as InboxSettings['triage_mode'],
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
    many<Row>(comms(ctx.service).from('inboxes').select(INBOX_COLUMNS).order('created_at')),
    many<{ inbox_id: string; member_id: string }>(comms(ctx.service).from('inbox_access').select('inbox_id, member_id')),
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
  let aliases: string[] | undefined;
  if (input.aliases) {
    aliases = [];
    for (const value of input.aliases) {
      const alias = normalizeAddress(value);
      if (!alias) throw new InboxError(422, `"${value}" is not an email address.`);
      if (alias !== address && !aliases.includes(alias)) aliases.push(alias);
    }
  }
  return { address, memberIds, aliases };
}

async function setAccess(ctx: InboxContext, inboxId: string, memberIds: string[]) {
  const current = (await many<{ member_id: string }>(comms(ctx.service).from('inbox_access').select('member_id').eq('inbox_id', inboxId)))
    .map((row) => row.member_id);
  const removed = current.filter((id) => !memberIds.includes(id));
  const added = memberIds.filter((id) => !current.includes(id));
  if (removed.length) {
    const { error } = await comms(ctx.service).from('inbox_access').delete().eq('inbox_id', inboxId).in('member_id', removed);
    if (error) throw error;
  }
  if (added.length) {
    const { error } = await comms(ctx.service).from('inbox_access').insert(added.map((member_id) => ({ inbox_id: inboxId, member_id, created_by: ctx.memberId })));
    if (error) throw error;
  }
}

function friendly(error: unknown): never {
  const value = error as { code?: string; message?: string };
  if (value?.code === '23505') {
    // email_routing_address_guard: the address belongs to the other table.
    if (value.message?.includes('EMAIL_ROUTING_ADDRESS_TAKEN')) {
      throw new InboxError(409, value.message.includes('project email address')
        ? 'A project email address already uses that relay address.'
        : 'An inbox already uses that relay address.');
    }
    if (value.message?.includes('email_project_addresses_routing_address_key')) throw new InboxError(409, 'Another project email address already uses that relay address.');
    if (value.message?.includes('routing_address')) throw new InboxError(409, 'Another inbox already uses that relay address.');
    throw new InboxError(409, 'That value is already in use.');
  }
  if (value?.code === '23514') throw new InboxError(422, 'One of the values is not allowed. Check the address, relay address and limits.');
  throw error;
}

async function inboxById(ctx: InboxContext, id: string): Promise<InboxSettings> {
  const { data, error } = await comms(ctx.service).from('inboxes').select(INBOX_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new InboxError(404, 'Inbox not found');
  const access = (await many<{ member_id: string }>(comms(ctx.service).from('inbox_access').select('member_id').eq('inbox_id', id))).map((row) => row.member_id);
  const [messages, projectAddresses] = await Promise.all([messageCount(ctx.service, id), projectAddressCount(ctx.service, id)]);
  return present(data as Row, access, messages, projectAddresses);
}

export async function createInbox(ctx: InboxContext, input: InboxSettingsRequest): Promise<InboxSettings> {
  requireManage(ctx);
  const { address, memberIds, aliases } = await validate(ctx, input);
  const { data, error } = await comms(ctx.service).from('inboxes').insert({
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
    ...(aliases ? { aliases } : {}),
    ...(input.triage_mode ? { triage_mode: input.triage_mode } : {}),
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
  const { address, memberIds, aliases } = await validate(ctx, input);
  const { error } = await comms(ctx.service).from('inboxes').update({
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
    ...(aliases ? { aliases } : {}),
    ...(input.triage_mode ? { triage_mode: input.triage_mode } : {}),
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
  return many<ClientEmailDomain & Row>(comms(ctx.service).from('client_domains').select('id, domain, project_id, created_at').eq('project_id', id).order('domain'));
}

export async function addClientDomain(ctx: InboxContext, projectId: string, input: string): Promise<ClientEmailDomain> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const valid = validateClientDomain(input);
  if (!valid.ok) throw new InboxError(422, valid.error);
  const existing = await many<{ id: string }>(comms(ctx.service).from('client_domains').select('id').eq('project_id', id).eq('domain', valid.domain));
  if (existing.length) throw new InboxError(409, `${valid.domain} is already on this project.`);
  const { data, error } = await comms(ctx.service).from('client_domains')
    .insert({ domain: valid.domain, project_id: id, created_by: ctx.memberId })
    .select('id, domain, project_id, created_at').single();
  if (error) friendly(error);
  return data as ClientEmailDomain;
}

export async function removeClientDomain(ctx: InboxContext, projectId: string, domainId: string): Promise<void> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  const target = assertId(domainId, 'domain id');
  const removed = await many<{ id: string }>(comms(ctx.service).from('client_domains').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Domain not found');
}

// -- Client email addresses (on a project) ----------------------------------
// Who sends the project mail, one exact address at a time: every address of
// the project's contacts (read here, managed in Contacts) and client email
// addresses added on the project (communications.client_addresses, public email
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
    many<{ id: string; name: string | null }>(service.from('contacts').select('id, name').in('id', ids).is('deleted_at', null)),
  ]);
  const nameOf = new Map(contacts.map((contact) => [contact.id, contact.name?.trim() || '']));
  // A contact in Trash no longer routes mail here, so its addresses are not listed.
  return emails
    .filter((row) => nameOf.has(row.contact_id))
    .map((row) => ({ address: row.email, contact_id: row.contact_id, contact_name: nameOf.get(row.contact_id) ?? '' }));
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
    many<{ id: string; address: string; created_at: string }>(comms(ctx.service).from('client_addresses').select(SENDER_COLUMNS).eq('project_id', id)),
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
    many<{ id: string }>(comms(ctx.service).from('client_addresses').select('id').eq('project_id', id).eq('address', valid.address)),
    projectContactAddresses(ctx.service, id),
  ]);
  if (existing.length) throw new InboxError(409, `${valid.address} is already on this project.`);
  if (contactAddresses.some((row) => row.address === valid.address)) {
    throw new InboxError(409, `${valid.address} belongs to a contact on this project, so it already routes here.`);
  }
  const { data, error } = await comms(ctx.service).from('client_addresses')
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
  const removed = await many<{ id: string }>(comms(ctx.service).from('client_addresses').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Address not found');
}

// -- Project email addresses (on a project) ---------------------------------
// The same people as client domains: whoever reads those reads these, and
// whoever manages those manages these.

const ADDRESS_COLUMNS = 'id, project_id, inbox_id, routing_local_part, routing_domain, routing_address, public_address, owner_member_id, enabled, last_received_at, created_at, updated_at';
const NEEDS_ROUTING = 'Enter the relay address, such as p4tf, or a public address to take it from.';

function presentAddress(row: Row): ProjectEmailAddress {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    inbox_id: row.inbox_id as string,
    routing_local_part: row.routing_local_part as string,
    routing_domain: row.routing_domain as string,
    routing_address: row.routing_address as string,
    public_address: (row.public_address as string | null) ?? null,
    owner_member_id: (row.owner_member_id as string | null) ?? null,
    enabled: Boolean(row.enabled),
    last_received_at: (row.last_received_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

async function requireExistingProject(ctx: InboxContext, projectId: string): Promise<string> {
  const id = requireProject(ctx, projectId);
  const { data, error } = await ctx.service.from('projects').select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw new InboxError(404, 'Project not found');
  return id;
}

/** The checked values of a create or an edit; fields left out stay as they are. */
async function addressValues(ctx: InboxContext, input: ProjectAddressPatch): Promise<Row> {
  const values: Row = {};
  if (input.inbox_id !== undefined) {
    const { data, error } = await comms(ctx.service).from('inboxes').select('id').eq('id', input.inbox_id).maybeSingle();
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
    many<Row>(comms(ctx.service).from('endpoints').select(ADDRESS_COLUMNS).eq('project_id', id).order('created_at')),
    many<{ id: string; name: string; address: string; enabled: boolean }>(comms(ctx.service).from('inboxes').select('id, name, address, enabled').order('created_at')),
  ]);
  return { relay_domain: relay?.domain ?? '', addresses: addresses.map(presentAddress), inboxes };
}

export async function addProjectAddress(ctx: InboxContext, projectId: string, input: ProjectAddressRequest): Promise<ProjectEmailAddress> {
  const id = requireProject(ctx, projectId);
  if (!canManageDomains(ctx)) throw new InboxError(403, 'Forbidden');
  await requireExistingProject(ctx, id);
  const values = await addressValues(ctx, input);
  if (!values.routing_local_part && !values.public_address) throw new InboxError(422, NEEDS_ROUTING);
  const { data, error } = await comms(ctx.service).from('endpoints').insert({
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
  const { data: current, error: currentError } = await comms(ctx.service).from('endpoints')
    .select('public_address').eq('id', target).eq('project_id', id).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new InboxError(404, 'Address not found');
  const values = await addressValues(ctx, input);
  const publicAddress = values.public_address !== undefined ? values.public_address : current.public_address;
  if (values.routing_local_part === '' && !publicAddress) throw new InboxError(422, NEEDS_ROUTING);
  const { data, error } = await comms(ctx.service).from('endpoints').update(values)
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
  const removed = await many<{ id: string }>(comms(ctx.service).from('endpoints').delete().eq('id', target).eq('project_id', id).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Address not found');
}

// -- Your addresses (Settings > Email) -----------------------------------------
// Every address mail comes in on, with or without a project, whose it is and
// which inbox it delivers to; your domains (a catch-all); and addresses that
// are not yours. A project address here is the same row a project's
// Communication tab shows.

/** How far back unlisted addresses are looked for, and how many messages are read. */
const UNLISTED_DAYS = 60;
const UNLISTED_MESSAGES = 1000;
const UNLISTED_PER_DOMAIN = 25;

function presentYourAddress(row: Row): YourAddress {
  return {
    id: row.id as string,
    address: ((row.public_address as string | null) ?? (row.routing_address as string | null)) ?? '',
    project_id: (row.project_id as string | null) ?? null,
    owner_member_id: (row.owner_member_id as string | null) ?? null,
    routing_address: (row.routing_address as string | null) ?? null,
    inbox_id: row.inbox_id as string,
    enabled: Boolean(row.enabled),
    last_received_at: (row.last_received_at as string | null) ?? null,
  };
}

type InboxChoice = { id: string; name: string; address: string; routing_address: string; enabled: boolean; handler_member_id: string | null };

async function inboxChoices(service: SupabaseClient): Promise<InboxChoice[]> {
  return many<InboxChoice>(comms(service).from('inboxes').select('id, name, address, routing_address, enabled, handler_member_id').order('created_at'));
}

/**
 * Addresses mail was written to lately that nobody listed or dismissed, by
 * domain: on a domain of an address of yours with no project, or an inbox's.
 * Never a client's domain (ciaran@client.com sits there, its staff are not
 * yours), and nothing on a domain you already own (those are yours anyway).
 */
async function unlistedAddresses(service: SupabaseClient, rows: Row[], inboxes: InboxChoice[], ownDomains: string[]): Promise<UnlistedDomain[]> {
  const [relay, clientDomains, ignored] = await Promise.all([
    relayDomain(service),
    many<{ domain: string }>(comms(service).from('client_domains').select('domain')),
    many<{ address: string }>(comms(service).from('ignored_addresses').select('address')),
  ]);
  const ownDomainAddresses = rows
    .filter((row) => !row.project_id)
    .map((row) => row.public_address as string | null)
    .filter((value): value is string => !!value);
  const notOurs = new Set([relay?.domain ?? '', ...clientDomains.map((row) => row.domain), ...ownDomains]);
  // A public mail domain (gmail.com) is nobody's: its other users are not yours.
  const domains = new Set([...ownDomainAddresses, ...inboxes.map((row) => row.address)].map(domainOf)
    .filter((domain) => domain && !notOurs.has(domain) && !isPublicEmailDomain(domain)));
  if (domains.size === 0) return [];
  const since = new Date(Date.now() - UNLISTED_DAYS * 86_400_000).toISOString();
  const messages = await many<{ id: string; received_at: string; inbox_id: string }>(comms(service).from('messages')
    .select('id, received_at, inbox_id').gte('received_at', since).neq('status', 'receiving').order('received_at', { ascending: false }).limit(UNLISTED_MESSAGES));
  const own = await ownAddresses(service);
  const skip = new Set(ignored.map((row) => row.address));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const found = new Map<string, UnlistedAddress>();
  for (let start = 0; start < messages.length; start += 200) {
    const ids = messages.slice(start, start + 200).map((message) => message.id);
    const recipients = await many<{ message_id: string; address: string }>(comms(service).from('participants')
      .select('message_id, address').in('kind', ['to', 'cc']).in('message_id', ids));
    for (const row of recipients) {
      const address = row.address.toLowerCase();
      if (own.has(address) || skip.has(address) || !domains.has(domainOf(address))) continue;
      const message = byId.get(row.message_id);
      const at = message?.received_at ?? '';
      const entry = found.get(address) ?? { address, messages: 0, last_seen: at, inbox_id: message?.inbox_id ?? '' };
      entry.messages++;
      // The inbox its latest mail arrived at: where it is added.
      if (at > entry.last_seen) { entry.last_seen = at; entry.inbox_id = message?.inbox_id ?? entry.inbox_id; }
      found.set(address, entry);
    }
  }
  const byDomain = new Map<string, UnlistedAddress[]>();
  for (const entry of found.values()) {
    const list = byDomain.get(domainOf(entry.address)) ?? [];
    list.push(entry);
    byDomain.set(domainOf(entry.address), list);
  }
  return [...byDomain.entries()]
    .map(([domain, list]) => ({ domain, addresses: list.sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, UNLISTED_PER_DOMAIN) }))
    .sort((a, b) => b.addresses.length - a.addresses.length);
}

/** The list; the scan for unlisted addresses only when asked for (the review on the addresses page). */
export async function listYourAddresses(ctx: InboxContext, { review = false }: { review?: boolean } = {}): Promise<YourAddressList> {
  requireManage(ctx);
  const [relay, rows, inboxes, domains] = await Promise.all([
    relayDomain(ctx.service),
    many<Row>(comms(ctx.service).from('endpoints').select(ADDRESS_COLUMNS).order('created_at')),
    inboxChoices(ctx.service),
    many<{ id: string; domain: string; created_at: string }>(comms(ctx.service).from('own_domains').select('id, domain, created_at').order('domain')),
  ]);
  return {
    addresses: rows.map(presentYourAddress),
    domains,
    inboxes: inboxes.map(({ id, name, routing_address, enabled, handler_member_id }) => ({ id, name, routing_address, enabled, handler_member_id })),
    unlisted: review ? await unlistedAddresses(ctx.service, rows, inboxes, domains.map((row) => row.domain)) : [],
    relay_domain: relay?.domain ?? '',
  };
}

/** The project, person and inbox an address may name: a live project, an active member, an inbox that exists. */
async function addressOwnership(ctx: InboxContext, input: { project_id?: string | null; owner_member_id?: string | null; inbox_id?: string }): Promise<Row> {
  const values: Row = {};
  if (input.project_id !== undefined) {
    if (input.project_id) {
      const { data, error } = await ctx.service.from('projects').select('id').eq('id', input.project_id).is('deleted_at', null).maybeSingle();
      if (error) throw error;
      if (!data) throw new InboxError(422, 'Choose a project that exists.');
    }
    values.project_id = input.project_id;
  }
  if (input.owner_member_id !== undefined) {
    if (input.owner_member_id) {
      const { data, error } = await ctx.service.from('team_members').select('id').eq('id', input.owner_member_id).eq('status', 'active').maybeSingle();
      if (error) throw error;
      if (!data) throw new InboxError(422, 'Choose someone on the team, or the company.');
    }
    values.owner_member_id = input.owner_member_id;
  }
  if (input.inbox_id !== undefined) {
    const { data, error } = await comms(ctx.service).from('inboxes').select('id').eq('id', input.inbox_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new InboxError(422, 'Choose the inbox this address delivers to.');
    values.inbox_id = input.inbox_id;
  }
  return values;
}

/** A relay address taken by another address or an inbox: the database's 23505 from either side. */
function routingTaken(error: unknown): boolean {
  const value = error as { code?: string; message?: string };
  return value?.code === '23505' && /routing_address|EMAIL_ROUTING_ADDRESS_TAKEN/.test(value.message ?? '');
}

/** The local part a project address takes from its public address, stepping around one that is taken. */
function relayLocalPart(address: string, attempt: number): string {
  const base = (address.split('@')[0] ?? '').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 58) || 'mail';
  return attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
}

/**
 * Writes an address that is getting a project, giving it a relay address of
 * its own: hello@ and hello@ on two domains, or ashley@client.com beside the
 * inbox's ashley@, step around each other with a short suffix.
 */
async function withRelayAddress(write: (localPart: string | undefined) => PromiseLike<{ data: unknown; error: unknown }>, address: string): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await write(attempt === 0 ? undefined : relayLocalPart(address, attempt));
    if (!error) return data;
    if (!routingTaken(error)) friendly(error);
  }
  throw new InboxError(409, 'Could not find a free relay address for it. Try again.');
}

export async function addYourAddress(ctx: InboxContext, input: YourAddressRequest): Promise<YourAddress> {
  requireManage(ctx);
  const address = normalizeAddress(input.address);
  if (!address) throw new InboxError(422, 'Enter the address in full, such as hello@yourdomain.com.');
  const [listed, inboxes] = await Promise.all([
    many<{ id: string }>(comms(ctx.service).from('endpoints').select('id').eq('public_address', address)),
    inboxChoices(ctx.service),
  ]);
  if (listed.length) throw new InboxError(409, `${address} is already one of your addresses.`);
  if (inboxes.some((row) => row.address === address || row.routing_address === address)) {
    throw new InboxError(409, `${address} is an inbox's own address.`);
  }
  const inboxId = input.inbox_id ?? (inboxes.find((row) => row.enabled) ?? inboxes[0])?.id;
  if (!inboxId) throw new InboxError(422, 'Set up an inbox first.');
  const ownership = await addressOwnership(ctx, { ...input, inbox_id: inboxId });
  const insert = (localPart: string | undefined) => comms(ctx.service).from('endpoints').insert({
    ...ownership,
    public_address: address,
    // A project address takes the relay domain and its own local part
    // (endpoints_before_write); one with no project keeps none.
    routing_domain: input.project_id ? '' : null,
    ...(localPart ? { routing_local_part: localPart } : {}),
    created_by: ctx.memberId,
  }).select(ADDRESS_COLUMNS).single();
  const data = input.project_id ? await withRelayAddress(insert, address) : await (async () => {
    const { data: row, error } = await insert(undefined);
    if (error) friendly(error);
    return row;
  })();
  // Listed now, so no longer dismissed.
  await comms(ctx.service).from('ignored_addresses').delete().eq('address', address);
  return presentYourAddress(data as Row);
}

/**
 * Giving an address a project gives it a relay address of its own (its
 * forwarder must point there for mail to be filed). Taking the project away
 * keeps that relay address, so mail still arrives, unfiled.
 */
export async function updateYourAddress(ctx: InboxContext, addressId: string, input: YourAddressPatch): Promise<YourAddress> {
  requireManage(ctx);
  const target = assertId(addressId, 'address id');
  const { data: current, error: currentError } = await comms(ctx.service).from('endpoints')
    .select('public_address, routing_address').eq('id', target).maybeSingle();
  if (currentError) throw currentError;
  if (!current) throw new InboxError(404, 'Address not found');
  const values = await addressOwnership(ctx, input);
  if (input.enabled !== undefined) values.enabled = input.enabled;
  const update = (localPart: string | undefined) => comms(ctx.service).from('endpoints')
    .update({ ...values, ...(localPart ? { routing_local_part: localPart } : {}) }).eq('id', target).select(ADDRESS_COLUMNS);
  const gainsRelay = !!input.project_id && !current.routing_address;
  const data = gainsRelay ? await withRelayAddress(update, (current.public_address as string | null) ?? '') : await (async () => {
    const { data: rows, error } = await update(undefined);
    if (error) friendly(error);
    return rows;
  })();
  const row = ((data ?? []) as Row[])[0];
  if (!row) throw new InboxError(404, 'Address not found');
  return presentYourAddress(row);
}

/** Threads it filed keep their project; only the address goes, and it is not suggested again. */
export async function removeYourAddress(ctx: InboxContext, addressId: string): Promise<void> {
  requireManage(ctx);
  const target = assertId(addressId, 'address id');
  const removed = await many<{ id: string; public_address: string | null }>(comms(ctx.service).from('endpoints').delete().eq('id', target).select('id, public_address'));
  if (removed.length === 0) throw new InboxError(404, 'Address not found');
  const address = removed[0].public_address;
  if (address) await ignoreAddress(ctx, address);
}

/** Not yours: never suggested again. */
export async function ignoreAddress(ctx: InboxContext, input: string): Promise<void> {
  requireManage(ctx);
  const address = normalizeAddress(input);
  if (!address) throw new InboxError(422, 'Enter the address in full.');
  const { error } = await comms(ctx.service).from('ignored_addresses')
    .upsert({ address, ignored_by: ctx.memberId }, { onConflict: 'address', ignoreDuplicates: true });
  if (error) throw error;
}

/** A domain of yours: mail to any address on it reads as written to you. */
export async function addOwnDomain(ctx: InboxContext, input: string): Promise<OwnDomain> {
  requireManage(ctx);
  const domain = input.trim().toLowerCase().replace(/^@/, '');
  if (!isHostname(domain)) throw new InboxError(422, 'Enter a domain such as yourdomain.com.');
  const valid = validateClientDomain(domain);
  if (!valid.ok) throw new InboxError(422, 'A public email domain (like gmail.com) cannot be yours.');
  const { data: client, error: clientError } = await comms(ctx.service).from('client_domains').select('id').eq('domain', domain).limit(1);
  if (clientError) throw clientError;
  if ((client ?? []).length) throw new InboxError(409, `${domain} is a client's domain on a project.`);
  const { data, error } = await comms(ctx.service).from('own_domains')
    .insert({ domain, created_by: ctx.memberId }).select('id, domain, created_at').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new InboxError(409, `${domain} is already one of your domains.`);
    friendly(error);
  }
  return data as OwnDomain;
}

export async function removeOwnDomain(ctx: InboxContext, domainId: string): Promise<void> {
  requireManage(ctx);
  const target = assertId(domainId, 'domain id');
  const removed = await many<{ id: string }>(comms(ctx.service).from('own_domains').delete().eq('id', target).select('id'));
  if (removed.length === 0) throw new InboxError(404, 'Domain not found');
}
