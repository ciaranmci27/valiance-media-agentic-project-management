// The channel-neutral path; /api/v1/inbound-emails/[id]/tasks serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { POST } from '../../../../inbound-emails/[id]/tasks/route';
