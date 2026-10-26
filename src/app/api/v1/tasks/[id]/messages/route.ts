// The channel-neutral path; /api/v1/tasks/[id]/emails serves the same handler until the older paths go.
export const dynamic = 'force-dynamic';
export { GET } from '../emails/route';
