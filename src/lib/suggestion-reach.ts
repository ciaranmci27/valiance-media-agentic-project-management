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

/** The pending suggestions in reach, newest first: what the badges count and the inbox lists. */
export function pendingSuggestionsInReach<S extends Pick<TaskSuggestion, 'project_id' | 'status' | 'created_at'>>(
  suggestions: readonly S[],
  projects: readonly Pick<Project, 'id'>[],
): S[] {
  return suggestionsInReach(suggestions, projects)
    .filter((s) => s.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}
