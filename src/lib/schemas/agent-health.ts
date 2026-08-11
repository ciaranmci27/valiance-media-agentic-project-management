import { z } from 'zod';

/**
 * One heartbeat per agent from the VPS publisher. The publisher owns the
 * container-to-member mapping (it lives beside the containers), so rows
 * arrive keyed by member_id; the endpoint verifies each id is a real agent.
 */
export const agentHealthReportSchema = z.object({
  reports: z
    .array(
      z.object({
        member_id: z.string().uuid(),
        container: z.string().min(1).max(64),
        container_running: z.boolean(),
        turn_running: z.boolean(),
        // Absent when no turn is in flight. The publisher reads this from the
        // agent's execution ledger, so it is a fact, not an estimate.
        turn_started_at: z.string().datetime({ offset: true }).nullable().optional(),
      })
    )
    .min(1)
    .max(32),
});
