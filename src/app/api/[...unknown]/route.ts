import { errorResponse } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

/**
 * Any API address with no route of its own. A JSON 404 in the API's own
 * envelope, never the page fallback (which redirects to the dashboard): an
 * agent or script calling a wrong or retired endpoint must read "not found",
 * not a login page.
 */
function notFound() {
  return errorResponse(404, 'not_found', 'No API endpoint at this address');
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
