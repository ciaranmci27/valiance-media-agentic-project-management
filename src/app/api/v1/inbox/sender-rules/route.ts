// The channel-neutral path; /api/v1/inbound-emails/sender-rules serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { GET, POST } from '../../inbound-emails/sender-rules/route';
