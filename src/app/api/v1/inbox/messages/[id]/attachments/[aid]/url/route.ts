// The channel-neutral path; /api/v1/inbound-emails/[id]/attachments/[aid]/url serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { GET } from '../../../../../../inbound-emails/[id]/attachments/[aid]/url/route';
