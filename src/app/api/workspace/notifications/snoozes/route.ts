import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { listSnoozes, snoozeItem, snoozeSchema, unsnoozeItem, unsnoozeSchema } from '@/lib/api/notifications';

export const dynamic = 'force-dynamic';

/** The signed-in member's snoozes still in force, soonest to wake first. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => listSnoozes(service, memberId), { noStore: true });
}

/**
 * Snoozes one item for the signed-in member: { item_kind (question, task,
 * suggestion or notification), item_id, until }. It is hidden from their
 * Needs you or Updates until then; snoozing it again moves the time.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => snoozeItem(service, memberId, await readWorkspaceBody(request, snoozeSchema)));
}

/** Brings a snoozed item back now: { item_kind, item_id }. Answers { removed }. */
export async function DELETE(request: Request) {
  return workspaceRoute(request, async ({ service, memberId }) => unsnoozeItem(service, memberId, await readWorkspaceBody(request, unsnoozeSchema)));
}
