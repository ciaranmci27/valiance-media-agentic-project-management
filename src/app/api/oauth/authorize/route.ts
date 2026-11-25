import { NextResponse, type NextRequest } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { foreignOrigin } from '@/lib/api/owner-route';
import { authorizeParamsFrom, checkAuthorizeRequest, connectAiState, issueCode, redirectBack } from '@/lib/api/connect-ai';
import { connectScopesFor } from '@/lib/connect-ai';

export const dynamic = 'force-dynamic';

/**
 * The consent screen's answer (Allow or Deny), from the signed-in person.
 * Everything the page showed is checked again here: the client and its exact
 * redirect address, PKCE, the resource, the workspace switch and what the
 * person may share. Answers { redirect }: back to the tool with a one-time
 * code (Allow) or error=access_denied (Deny, or nothing to share), plus state
 * and iss. A request whose client or redirect address is not valid is 400 and
 * goes nowhere.
 */
export async function POST(request: NextRequest) {
  if (foreignOrigin(request)) return NextResponse.json({ error: 'This origin may not sign in AI tools here.' }, { status: 403 });
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (body.decision !== 'allow' && body.decision !== 'deny')) {
    return NextResponse.json({ error: 'Send decision allow or deny with the sign-in request.' }, { status: 400 });
  }
  const origin = request.nextUrl.origin;
  try {
    const check = await checkAuthorizeRequest(service, authorizeParamsFrom(body), origin);
    if (check.kind === 'page_error') return NextResponse.json({ error: check.message }, { status: 400 });
    const back = (values: Record<string, string | null>) =>
      NextResponse.json({ redirect: redirectBack(check.redirectUri, origin, values) }, { headers: { 'Cache-Control': 'no-store' } });
    if (check.kind === 'redirect_error') return back({ error: check.error, error_description: check.description, state: check.state });
    if (body.decision === 'deny') return back({ error: 'access_denied', error_description: 'The person did not allow access.', state: check.state });
    const state = await connectAiState(service);
    if (!state.ready || !state.enabled || !state.apiEnabled) {
      return back({ error: 'access_denied', error_description: 'Connecting AI tools is turned off for this workspace.', state: check.state });
    }
    const scopes = connectScopesFor(access);
    if (access.role === 'agent' || scopes.length === 0) {
      return back({ error: 'access_denied', error_description: 'This person has no access to share with an AI tool.', state: check.state });
    }
    const code = await issueCode(service, { check, memberId, scopes });
    return back({ code, state: check.state });
  } catch (caught) {
    console.error('[connect-ai] authorize failed:', caught);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
