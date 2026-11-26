import { getTemplateDraft } from '@/lib/api/template-drafts';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ draftId: string }> };

/** One draft, with its preview (added and removed steps marked) while it is pending. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => getTemplateDraft(service, caller, (await params).draftId));
}
