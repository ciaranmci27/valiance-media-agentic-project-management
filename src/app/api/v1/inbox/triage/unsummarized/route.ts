// The channel-neutral path; /api/v1/inbound-emails/triage/unsummarized serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { GET } from '../../../inbound-emails/triage/unsummarized/route';
