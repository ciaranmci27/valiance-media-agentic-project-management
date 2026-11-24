import { z } from 'zod';

/**
 * How often an agent may promise a heartbeat, in seconds: from every 30
 * seconds (a fleet publisher) to once a day (an agent run by a daily cron).
 * The database checks the same range.
 */
export const HEARTBEAT_INTERVAL_MIN_SECONDS = 30;
export const HEARTBEAT_INTERVAL_MAX_SECONDS = 86_400;
/** The publisher's beat, and what a row that never declared one promises. */
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const STATUS_NOTE_MAX = 280;

const expectedIntervalSeconds = z
  .number()
  .int()
  .min(HEARTBEAT_INTERVAL_MIN_SECONDS)
  .max(HEARTBEAT_INTERVAL_MAX_SECONDS);

/**
 * One heartbeat per agent from a fleet publisher. The publisher owns the
 * container-to-member mapping (it lives beside the containers), so rows
 * arrive keyed by member_id; the endpoint verifies each id is a real agent.
 */
export const agentHealthReportSchema = z.object({
  reports: z
    .array(
      z.object({
        member_id: z.string().uuid(),
        // Optional for publishers that watch something other than containers.
        container: z.string().min(1).max(64).optional(),
        container_running: z.boolean(),
        turn_running: z.boolean(),
        // Absent when no turn is in flight. The publisher reads this from the
        // agent's execution ledger, so it is a fact, not an estimate.
        turn_started_at: z.string().datetime({ offset: true }).nullable().optional(),
        // How often this publisher beats for this agent; 60 when left out.
        expected_interval_seconds: expectedIntervalSeconds.optional(),
      })
    )
    .min(1)
    .max(32),
});

/**
 * An agent's own heartbeat, sent with its own key. It reports only its own
 * row: member_id, when sent, must be the key's member.
 */
export const agentHeartbeatSchema = z.object({
  member_id: z.string().uuid().optional(),
  // Whether a turn is running right now. Left out: not working.
  working: z.boolean().optional(),
  // When the running turn began. Left out while working: kept from the last
  // beat of the same turn, or now.
  turn_started_at: z.string().datetime({ offset: true }).nullable().optional(),
  // How often this agent promises to beat. Left out: as last declared (60 at first).
  expected_interval_seconds: expectedIntervalSeconds.optional(),
  // What it is doing, in a line. Each beat replaces it; left out clears it.
  status_note: z.string().trim().min(1).max(STATUS_NOTE_MAX).nullable().optional(),
});
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
