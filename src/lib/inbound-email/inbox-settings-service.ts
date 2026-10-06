import { promises as dns } from 'node:dns';
import type { SupabaseClient } from '@supabase/supabase-js';
import { accessAllows, accessAllowsProject } from '@/lib/api/access';
import { isHostname, normalizeAddress } from './addresses';
import { validateClientDomain } from './public-domains';
import { assertId, InboxError, type InboxContext } from './inbox-service';
import type { InboxSettingsRequest } from './schemas';
import type { AgentReadableType, ClientEmailDomain, InboxSettings, InboxSettingsList, MxStatus } from './inbox-types';

/**
 * Settings > Email inboxes and the client email domains on a project. Inboxes
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

function present(row: Row, access: string[], messages: number): InboxSettings {
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
  const counts = await Promise.all(inboxes.map((inbox) => messageCount(ctx.service, inbox.id as string)));
  return {
    relay_domain: relay?.domain ?? '',
    inboxes: inboxes.map((inbox, index) => present(
      inbox,
      access.filter((row) => row.inbox_id === inbox.id).map((row) => row.member_id),
      counts[index],
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
  return present(data as Row, access, await messageCount(ctx.service, id));
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
