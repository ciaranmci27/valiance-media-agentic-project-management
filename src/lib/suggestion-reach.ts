import type { Project, TaskSuggestion } from '@/lib/types';

/**
 * Which agent suggestions a person reviews: every one in a project they
 * reach, from any agent (an auditing agent, inbox triage, an approval
 * policy). No project setting narrows it. The server returns only what the
 * viewer may see (suggestions.manage and project access); the viewer's own
 * project list is the same reach here, so a suggestion is never counted where
 * its project cannot be opened. The Needs you inbox, the review queue, My
 * Tasks and the sidebar badge all read this, so their counts agree.
 */
export function suggestionsInReach<S extends Pick<TaskSuggestion, 'project_id'>>(
  suggestions: readonly S[],
  projects: readonly Pick<Project, 'id'>[],
): S[] {
  const reach = new Set(projects.map((p) => p.id));
  return suggestions.filter((s) => reach.has(s.project_id));
}

/**
 * The proposing agent answers an info request by appending to the description
 * with this exact marker (its plugin owns the format).
 */
export const INFO_ANSWER_MARKER = '\n\n--- Answer to info request ---';

/**
 * A suggestion's description and the agent's answer to an info request, split
 * on the marker; answer is null while the agent has not answered. The answer
 * carries "Asked: ..." then "Answer: ..."; only the answer text is kept.
 */
export function splitInfoAnswer(s: Pick<TaskSuggestion, 'description'>): { description: string; answer: string | null } {
  const description = s.description ?? '';
  const idx = description.indexOf(INFO_ANSWER_MARKER);
  if (idx === -1) return { description, answer: null };
  const raw = description.slice(idx + INFO_ANSWER_MARKER.length).trim();
  const answer = raw.replace(/^Asked:[\s\S]*?\nAnswer:\s*/, '').replace(/^Answer:\s*/, '');
  return { description: description.slice(0, idx).trimEnd(), answer };
}

/**
 * Whether a suggestion waits on its reviewer: pending, or an info request the
 * agent has answered (the ball is back with the person). An unanswered info
 * request waits on the agent, so it is not counted.
 */
export function awaitsReviewer(s: Pick<TaskSuggestion, 'status'> & Partial<Pick<TaskSuggestion, 'description'>>): boolean {
  if (s.status === 'pending') return true;
  return s.status === 'needs_info' && splitInfoAnswer({ description: s.description ?? '' }).answer !== null;
}

/** The suggestions in reach waiting on the reviewer, newest first: what the badges count and the inbox lists. */
export function pendingSuggestionsInReach<S extends Pick<TaskSuggestion, 'project_id' | 'status' | 'created_at'> & Partial<Pick<TaskSuggestion, 'description'>>>(
  suggestions: readonly S[],
  projects: readonly Pick<Project, 'id'>[],
): S[] {
  return suggestionsInReach(suggestions, projects)
    .filter((s) => awaitsReviewer(s))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}
