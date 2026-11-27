/**
 * The safe defaults a new company agent starts with, in one place (deep
 * security review of 2.0.50, finding 9). The hire screen pre-fills each one
 * and an Owner may clear or change it there or later under Limits; hiring
 * over the API (hire_agent, create_agent) without limits gets them too.
 * Agents and keys made before these existed keep what they had.
 *
 * - No spend budget: spend is whatever the agent's host reports (a
 *   subscription may report estimates or nothing), so a default cap could
 *   stop work for reasons nobody sees. An Owner sets one per agent.
 * - NEW_AGENT_WRITES_PER_MINUTE writes a minute, counted for the agent across
 *   all its keys (reads are not counted here).
 * - NEW_AGENT_SENDS_PER_MINUTE sends a minute, a smaller bucket of its own:
 *   chat messages out, notifications, questions and approvals (each one
 *   reaches a person).
 * - New agent keys end after NEW_AGENT_KEY_DAYS days unless the workspace
 *   sets its own agent key lifetime or the Owner clears it for that key.
 *   Replace key (rotate) or Renew gives it another stretch.
 */

/** Writes a minute a new agent may make, across all its keys. */
export const NEW_AGENT_WRITES_PER_MINUTE = 30;

/** Sends a minute (chat out, notifications, questions, approvals) a new agent may make. */
export const NEW_AGENT_SENDS_PER_MINUTE = 10;

/** Days a new agent key lasts when nothing else decides. */
export const NEW_AGENT_KEY_DAYS = 90;

/** The limits a new company agent starts with (a template's own limits are laid over these). */
export const NEW_AGENT_LIMITS = {
  write_rate_per_minute: NEW_AGENT_WRITES_PER_MINUTE,
  send_rate_per_minute: NEW_AGENT_SENDS_PER_MINUTE,
};
