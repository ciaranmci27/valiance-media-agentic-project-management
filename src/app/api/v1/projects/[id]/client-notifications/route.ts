import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success, errorResponse } from '@/lib/api/response';
import { sendPortalWelcome, sendProjectSummary } from '@/lib/email/client-notifications';

const schema = z.object({
  type: z.enum(['portal_welcome', 'project_summary']),
});

export const dynamic = 'force-dynamic';

export const POST = withApi(async ({ params, body }) => {
  const { id } = params as any;
  const { type } = body as z.infer<typeof schema>;

  let result: { success: boolean; error?: string };

  if (type === 'portal_welcome') {
    result = await sendPortalWelcome(id);
  } else {
    result = await sendProjectSummary(id);
  }

  if (!result.success) {
    return errorResponse(400, 'SEND_FAILED', result.error || 'Failed to send notification');
  }

  return success({ sent: true, type });
}, { schema });
