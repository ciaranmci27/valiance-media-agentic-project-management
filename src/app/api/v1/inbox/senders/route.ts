// The channel-neutral path; /api/v1/inbound-emails/senders serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { GET } from '../../inbound-emails/senders/route';
