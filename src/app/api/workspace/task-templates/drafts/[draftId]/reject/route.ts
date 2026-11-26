import { decideTemplateDraft } from '@/lib/api/template-drafts';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { decideTemplateDraftSchema } from '@/lib/task-templates';
import { kickWebhooks } from '@/lib/webhooks/kick';

/** A full-size playbook (200 tasks) is a few seconds; this is the ceiling, as for the MCP server. */
export const maxDuration = 60;

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ draftId: string }> };

/**
 * Rejects a draft as the signed-in member, by deciding its approval (the same
 * path as the approval card). Answers { draft, run, template_changed_since }.
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    const body = await readWorkspaceBody(request, decideTemplateDraftSchema);
    const result = await decideTemplateDraft({ db: service, access, memberId, channel: 'app' }, (await params).draftId, 'reject', body.note);
    kickWebhooks(access);
    return result;
  });
}
