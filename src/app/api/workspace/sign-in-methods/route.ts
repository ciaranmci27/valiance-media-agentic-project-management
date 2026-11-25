import { z } from 'zod';
import { forbidden } from '@/lib/api/errors';
import { googleProviderState, readSignInMethods, setSignInMethods, strandedByMethods } from '@/lib/api/sign-in';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { SIGN_IN_METHODS } from '@/lib/sign-in';

export const dynamic = 'force-dynamic';

const methodsSchema = z.object({ methods: z.enum(SIGN_IN_METHODS) }).strict();

/**
 * How people sign in (business_settings.sign_in_methods): password (the
 * default), google or both. Any member reads it; only an Owner changes it,
 * written as them so the audit log records who, and Google only needs the
 * Owner's own Google linked first, email and password only a password of
 * their own. Answers { ready, methods, google_provider, stranded } (ready:
 * the migration has run; google_provider: on, off or unknown in Supabase;
 * stranded: for each choice, who it would leave with no way in, for the
 * Owner to see before saving; null for anyone else).
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    const [state, provider, stranded] = await Promise.all([
      readSignInMethods(service),
      googleProviderState(),
      // People's names: only an Owner, who changes the setting, sees them.
      access.role === 'owner' ? strandedByMethods(service) : Promise.resolve(null),
    ]);
    return { ready: state.ready, methods: state.methods, google_provider: provider, stranded };
  }, { noStore: true });
}

export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, access, authUserId }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes how people sign in', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, methodsSchema);
    const state = await setSignInMethods(service, { authUserId }, body.methods);
    const [provider, stranded] = await Promise.all([googleProviderState(), strandedByMethods(service)]);
    return { ready: state.ready, methods: state.methods, google_provider: provider, stranded };
  }, { noStore: true });
}
