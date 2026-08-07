import { z } from 'zod';

export const createTaskReviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  summary: z.string().min(1, 'Summary is required'),
  // Required so the round counter can scope to the PR: a task whose first PR
  // was abandoned starts fresh on its replacement instead of inheriting rounds.
  pr_url: z.string().url(),
  // Full SHA only. The merge gate compares by strict equality with the PR
  // head; accepting an abbreviated SHA here would create approvals that can
  // never merge and re-reviews that inflate rounds.
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'head_sha must be a full 40-character git SHA'),
});
