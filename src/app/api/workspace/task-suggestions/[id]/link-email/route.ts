import { forbidden, notFound } from '@/lib/api/errors';
import { linkApprovedSuggestionEmail } from '@/lib/api/suggestion-email';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * After a person approves a suggestion an agent made from an email, links
 * the email to the new task (lib/api/suggestion-email.ts). Only the person
 * who approved it, while they can open the task and read the email's inbox:
 * 403 not_approver or inbox_not_readable otherwise, 404 when the suggestion
 * or its task is out of reach. Answers { linked: true, message_id, task_id },
 * or { linked: false, reason } when there is nothing to link (no email, not
 * approved yet, the email is gone).
 */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, access, memberId }) => {
    const { id } = await params;
    const result = await linkApprovedSuggestionEmail(service, { suggestionId: id, memberId, access, channel: 'app' });
    if (result.linked) return result;
    if (result.reason === 'not_found') throw notFound('Suggestion');
    if (result.reason === 'task_out_of_reach') throw notFound('Task');
    if (result.reason === 'not_approver') throw forbidden('Only the person who approved it links its email', { reason: 'not_approver' });
    if (result.reason === 'inbox_not_readable') throw forbidden('You cannot read the inbox this email is in', { reason: 'inbox_not_readable' });
    return result;
  });
}
