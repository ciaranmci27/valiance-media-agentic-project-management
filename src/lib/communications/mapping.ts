/**
 * Project mapping for a sender. Contact addresses (contact_emails, through
 * every contact that has the address, to their projects), client domains and
 * client sender addresses (email_client_addresses, one exact address on a
 * project, no contact needed) all yield candidates. One distinct candidate maps the message; several
 * leave the project for the agent to choose among them; none leaves it to
 * the agent to infer. A project address the email came through outranks
 * them all. A thread that already has a project keeps it.
 */

import type { ClientSenderAddress } from './inbox-types';

/** Why a sender maps to a project: a contact's address, a client domain, or a client sender address. */
export const CANDIDATE_REASONS = ['contact', 'domain', 'sender'] as const;
export type CandidateReason = typeof CANDIDATE_REASONS[number];

export interface MappingCandidate {
  project_id: string;
  reason: CandidateReason;
}

export interface MappingResult {
  candidates: MappingCandidate[];
  candidate_project_ids: string[];
  /** The single mapped project, or null when there are none or several. */
  project_id: string | null;
}

export function resolveMapping(input: {
  contactProjectIds: readonly string[];
  domainProjectIds: readonly string[];
  senderProjectIds?: readonly string[];
}): MappingResult {
  const candidates: MappingCandidate[] = [];
  const seen = new Set<string>();
  const add = (projectId: string, reason: MappingCandidate['reason']) => {
    const key = `${projectId}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ project_id: projectId, reason });
  };
  for (const id of input.contactProjectIds) add(id, 'contact');
  for (const id of input.domainProjectIds) add(id, 'domain');
  for (const id of input.senderProjectIds ?? []) add(id, 'sender');
  const distinct = [...new Set(candidates.map((candidate) => candidate.project_id))];
  return {
    candidates,
    candidate_project_ids: distinct,
    project_id: distinct.length === 1 ? distinct[0] : null,
  };
}

export interface ThreadProjectDecision {
  project_id: string | null;
  project_source: 'mapped' | 'address';
  project_address_id: string | null;
}

/**
 * What ingestion sets on the thread, only when it has no project: a project
 * address the email came through (a person's mapping, ahead of any contact,
 * domain or sender match, and whatever the project's status), else the mapping.
 */
export function threadProjectDecision(
  thread: { project_id: string | null } | null,
  mapping: MappingResult,
  projectAddress: { id: string; project_id: string } | null,
): ThreadProjectDecision {
  if (thread?.project_id) return { project_id: null, project_source: 'mapped', project_address_id: null };
  if (projectAddress) return { project_id: projectAddress.project_id, project_source: 'address', project_address_id: projectAddress.id };
  return { project_id: mapping.project_id, project_source: 'mapped', project_address_id: null };
}

/** An address of a contact on the project (contact_emails through project_contacts). */
export interface ProjectContactAddress {
  address: string;
  contact_id: string;
  contact_name: string;
}

/**
 * The Client email addresses list on a project: contact addresses first (by
 * contact name, then address), then client email addresses (manual rows) by
 * address. An address that is both shows once, as the contact's, keeping the
 * manual row's id so that row can still be removed. An address of several
 * contacts shows the first by name. showContacts false (a member who cannot
 * read contacts) keeps the addresses and drops contact names and ids.
 */
export function mergeClientSenders(
  contactAddresses: readonly ProjectContactAddress[],
  manual: readonly { id: string; address: string; created_at: string }[],
  showContacts: boolean,
): ClientSenderAddress[] {
  const manualByAddress = new Map(manual.map((row) => [row.address, row]));
  const firstContact = new Map<string, ProjectContactAddress>();
  const byName = [...contactAddresses].sort((a, b) => a.contact_name.localeCompare(b.contact_name) || a.contact_id.localeCompare(b.contact_id));
  for (const row of byName) if (!firstContact.has(row.address)) firstContact.set(row.address, row);
  const fromContacts: ClientSenderAddress[] = [...firstContact.values()]
    .map((row) => {
      const own = manualByAddress.get(row.address);
      return {
        address: row.address,
        source: 'contact' as const,
        id: own?.id ?? null,
        contact_id: showContacts ? row.contact_id : null,
        contact_name: showContacts ? row.contact_name : null,
        created_at: own?.created_at ?? null,
      };
    })
    .sort((a, b) => (a.contact_name ?? '').localeCompare(b.contact_name ?? '') || a.address.localeCompare(b.address));
  const standalone: ClientSenderAddress[] = manual
    .filter((row) => !firstContact.has(row.address))
    .map((row) => ({ address: row.address, source: 'manual' as const, id: row.id, contact_id: null, contact_name: null, created_at: row.created_at }))
    .sort((a, b) => a.address.localeCompare(b.address));
  return [...fromContacts, ...standalone];
}
