// The channel-neutral path; /api/v1/inbound-emails/[id]/attachments/[aid] serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { PATCH } from '../../../../../inbound-emails/[id]/attachments/[aid]/route';
