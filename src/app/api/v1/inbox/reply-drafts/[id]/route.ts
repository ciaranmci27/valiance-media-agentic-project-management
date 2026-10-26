// The channel-neutral path; /api/v1/inbound-emails/reply-drafts/[id] serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { PUT } from '../../../inbound-emails/reply-drafts/[id]/route';
