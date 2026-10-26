// The channel-neutral path; /api/v1/inbound-emails/triage/mark-summarized serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { POST } from '../../../inbound-emails/triage/mark-summarized/route';
