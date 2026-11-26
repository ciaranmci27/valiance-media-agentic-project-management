/**
 * The public contract's version: the v1 REST routes, the MCP tool names and
 * the webhook event payloads, together. Date style. It changes only on a
 * breaking change, which also needs a new major path (/api/v2); adding a
 * field, a route, a tool or an event never changes it.
 *
 * It is sent as the X-PM-API-Version header on every /api/v1 answer (withApi),
 * as api_version on GET /api/v1/mcp/tools, and as api_version on every
 * webhook envelope. The database stamps the envelope itself, with the same
 * value written once in pm.webhook_envelope_api_version()
 * (20261125001200_contract_cleanup.sql); a test checks the two agree.
 */
export const API_VERSION = '2026-11-25';

export const API_VERSION_HEADER = 'X-PM-API-Version';

/**
 * When the legacy triage pieces go (the older inbound-emails paths, the older
 * triage, its summaries, shadow mode, draft-notice relaying, legacy activity
 * types): once every harness that calls them runs on triage plans. Until
 * then they keep working unchanged.
 */
export const PLANS_CUTOVER_REMOVAL = 'after the triage plans cutover';
