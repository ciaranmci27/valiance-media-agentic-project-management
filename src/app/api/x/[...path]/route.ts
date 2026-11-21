import type { NextRequest } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { withApi } from '@/lib/api/middleware';
import { getServiceClient } from '@/lib/api/supabase-service';
import { moduleEnabled } from '@/lib/modules/server';
import { dispatchApiRoute, type ApiDispatchDeps } from '@/lib/extensions/api';
import apiRoutes from '@/custom/api';

export const dynamic = 'force-dynamic';

/**
 * The install's own endpoints (src/custom/api.ts), at /api/x/<path>. Each
 * route passes its declared auth before its handler runs: a session by
 * default, an API key with a permission, or nothing for `auth: 'public'`.
 */
const deps: ApiDispatchDeps = {
  requireSession: (permission) => requireSessionAccess({ permission }),
  withApiKey: (request, permission, run) => withApi((ctx) => run(ctx), { permission })(request),
  moduleEnabled: (id) => moduleEnabled(getServiceClient(), id),
};

async function handle(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return dispatchApiRoute(request, path, apiRoutes, deps);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
