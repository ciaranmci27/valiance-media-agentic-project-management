/**
 * Project mapping for a sender. Contact addresses (contact_emails, through
 * every contact that has the address, to their projects) and client domains
 * both yield candidates. One distinct candidate maps the message; several
 * leave the project for the agent to choose among them; none leaves it to
 * the agent to infer. A thread that already has a project keeps it.
 */

export interface MappingCandidate {
  project_id: string;
  reason: 'contact' | 'domain';
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
  const distinct = [...new Set(candidates.map((candidate) => candidate.project_id))];
  return {
    candidates,
    candidate_project_ids: distinct,
    project_id: distinct.length === 1 ? distinct[0] : null,
  };
}

/** The project a mapping sets on the thread: only when the thread has none. */
export function mappedProjectForThread(
  thread: { project_id: string | null } | null,
  mapping: MappingResult,
): string | null {
  if (thread?.project_id) return null;
  return mapping.project_id;
}
