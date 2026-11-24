import { z } from 'zod';

/**
 * A review verdict on a task. Two kinds, one table:
 *
 * - A pull request review sends pr_url and head_sha together. Everything about
 *   it is as it always was: one verdict per commit, rounds counted per pull
 *   request, and the merge gate reads head_sha.
 * - A review of any other work (a document, a data fix, a design) sends
 *   neither: a verdict and notes. Its rounds are counted across the task's
 *   reviews without a pull request, and it never carries a head_sha, so a
 *   merge gate that needs one fails closed on it.
 */
export const createTaskReviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  summary: z.string().min(1, 'Summary is required'),
  // Scopes the round counter to the PR: a task whose first PR was abandoned
  // starts fresh on its replacement instead of inheriting rounds.
  pr_url: z.string().url().nullish(),
  // Full SHA only. The merge gate compares by strict equality with the PR
  // head; accepting an abbreviated SHA here would create approvals that can
  // never merge and re-reviews that inflate rounds.
  head_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'head_sha must be a full 40-character git SHA').nullish(),
}).refine((review) => !review.pr_url === !review.head_sha, {
  message: 'A pull request review sends pr_url and head_sha together; a review of other work sends neither',
  path: ['head_sha'],
});
