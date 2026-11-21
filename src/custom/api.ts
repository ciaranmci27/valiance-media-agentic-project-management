import { defineApiRoutes } from '@/lib/extensions';

/**
 * This install's API endpoints, served at /api/x/<path>. Server only: import
 * database clients and secrets here, never in index.ts.
 *
 * Every route is protected unless it says otherwise:
 *   auth: 'session' (the default)  a signed-in member; add `permission` to narrow it
 *   auth: 'api-key'                an API key holding `permission` (required)
 *   auth: 'public'                 anyone; the handler checks what it needs
 *
 * Errors: throw ApiError (from '@/lib/api/errors') and the caller gets the
 * app's error envelope; answer with success() from '@/lib/api/response'.
 *
 * Crons: add the schedule to vercel.json (the upgrade keeps an install's
 * crons) pointing at an /api/x route with auth: 'public', and check the
 * secret yourself:
 *   if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) throw unauthorized();
 *
 * Examples:
 *   {
 *     path: 'reports/weekly',
 *     method: 'GET',
 *     permission: 'projects.read_all',
 *     handler: async ({ session }) => {
 *       const { data } = await session.client.from('projects').select('id, name');
 *       return success(data);
 *     },
 *   },
 *   {
 *     path: 'clients/:id/score',
 *     method: 'POST',
 *     auth: 'api-key',
 *     permission: 'projects.manage',
 *     handler: async ({ params, api }) => success({ id: params.id, member: api.teamMemberId }),
 *   },
 */
export default defineApiRoutes([]);
