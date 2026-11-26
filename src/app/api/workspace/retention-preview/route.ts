import { z } from 'zod';
import { forbidden } from '@/lib/api/errors';
import { retentionPreview, type RetentionPreviewKey } from '@/lib/api/data-retention';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { DATA_RETENTION_KEYS } from '@/lib/data-retention';

export const dynamic = 'force-dynamic';

const period = z.number().int().min(1).max(3650).nullable().optional();
const previewSchema = z.object(Object.fromEntries(
  [...DATA_RETENTION_KEYS, 'audit_retention_days'].map((key) => [key, period]),
) as Record<RetentionPreviewKey, typeof period>).strict();

/**
 * Before an Owner shortens a period in Settings > Security (Keeping data,
 * Keeping the log): about how many rows each new period would remove at the
 * next daily cleanup. Body: the periods being saved, in days (null: forever).
 * Owner only; changes nothing. Answers { rows: { <setting>: count | null } }.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, access }) => {
    if (access.role !== 'owner') throw forbidden('Only an Owner changes how long data is kept', { reason: 'owner_only' });
    const body = await readWorkspaceBody(request, previewSchema);
    return { rows: await retentionPreview(service, body) };
  }, { noStore: true });
}
