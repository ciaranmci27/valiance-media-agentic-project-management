import type { SupabaseClient } from '@supabase/supabase-js';
import { domainOf, organizationalDomain } from './email/addresses';
import { resolveMapping, type MappingResult } from './mapping';
import { comms } from './db';

export interface AddressMapping {
  mapping: MappingResult;
  /** Each person's address with exactly one contact, for participants.contact_id. */
  recipientContacts: { address: string; contact_id: string }[];
  /** The contacts behind the mapping addresses. */
  senderContactIds: string[];
  /** Projects a mapping address is a client sender address on (archived or not). */
  senderProjectIds: string[];
}

/**
 * The projects a message's mapping addresses lead to, the same for every
 * channel: every contact that has the address (contact_emails, through
 * project_contacts), the address's domain and organizational domain
 * (client_domains), and the exact address on a project (client_addresses).
 * Archived projects and projects in Trash are no candidates. `people` are
 * every outside address on the message, for their contact ids.
 */
export async function mapAddresses(
  supabase: SupabaseClient,
  mappingAddresses: readonly string[],
  people: readonly string[],
): Promise<AddressMapping> {
  const { data: contactRows, error: contactError } = people.length
    ? await supabase.from('contact_emails').select('contact_id, email, contact:contacts!inner(id)').in('email', [...people]).is('contact.deleted_at', null)
    : { data: [], error: null };
  if (contactError) throw contactError;
  const contactsByAddress = new Map<string, Set<string>>();
  for (const row of (contactRows ?? []) as { contact_id: string; email: string }[]) {
    if (!contactsByAddress.has(row.email)) contactsByAddress.set(row.email, new Set());
    contactsByAddress.get(row.email)!.add(row.contact_id);
  }
  const recipientContacts = [...contactsByAddress.entries()]
    .filter(([, ids]) => ids.size === 1)
    .map(([address, ids]) => ({ address, contact_id: [...ids][0] }));
  const senderContactIds = [...new Set(mappingAddresses.flatMap((address) => [...(contactsByAddress.get(address) ?? [])]))];
  const mappingDomains = [...new Set(mappingAddresses.flatMap((address) => [domainOf(address), organizationalDomain(domainOf(address))]))];
  const [contactProjects, domainProjects, senderProjects] = await Promise.all([
    senderContactIds.length
      ? supabase.from('project_contacts').select('project_id').in('contact_id', senderContactIds)
      : Promise.resolve({ data: [], error: null }),
    mappingDomains.length
      ? comms(supabase).from('client_domains').select('project_id').in('domain', mappingDomains)
      : Promise.resolve({ data: [], error: null }),
    mappingAddresses.length
      ? comms(supabase).from('client_addresses').select('project_id').in('address', [...mappingAddresses])
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactProjects.error) throw contactProjects.error;
  if (domainProjects.error) throw domainProjects.error;
  if (senderProjects.error) throw senderProjects.error;
  const projectIdsOf = (result: { data: unknown }) => ((result.data ?? []) as { project_id: string }[]).map((row) => row.project_id);
  const everyProject = [...new Set([...projectIdsOf(contactProjects), ...projectIdsOf(domainProjects), ...projectIdsOf(senderProjects)])];
  // Archived projects, and projects in Trash, take no new mail.
  const { data: liveProjects, error: projectError } = everyProject.length
    ? await supabase.from('projects').select('id, status, archived_at').in('id', everyProject).is('deleted_at', null)
    : { data: [], error: null };
  if (projectError) throw projectError;
  const live = new Set(((liveProjects ?? []) as { id: string; status: string; archived_at: string | null }[])
    .filter((project) => !project.archived_at && project.status !== 'archived')
    .map((project) => project.id));
  const mapping = resolveMapping({
    contactProjectIds: projectIdsOf(contactProjects).filter((id) => live.has(id)),
    domainProjectIds: projectIdsOf(domainProjects).filter((id) => live.has(id)),
    senderProjectIds: projectIdsOf(senderProjects).filter((id) => live.has(id)),
  });
  return { mapping, recipientContacts, senderContactIds, senderProjectIds: projectIdsOf(senderProjects) };
}
