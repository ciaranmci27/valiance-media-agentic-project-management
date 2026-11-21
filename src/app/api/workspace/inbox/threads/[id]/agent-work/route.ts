import { z } from 'zod';
import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { restoreAgentWork, undoAgentWork } from '@/lib/communications/agent-work';

export const dynamic = 'force-dynamic';

const undoSchema = z.object({
  message_ids: z.array(z.string()).max(200).nullable().default(null),
  task_id: z.string().nullable().default(null),
}).strict();

/** Undo all: everything the agent did with these emails (or the whole conversation) is taken back. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => undoAgentWork(ctx, id, await readBody(request, undoSchema)));
}

const restoreSchema = z.object({
  plan_items: z.array(z.string()).max(500),
  tasks: z.array(z.string()).max(500),
  reminders: z.array(z.string()).max(500),
  links: z.array(z.object({
    message_id: z.string(),
    task_id: z.string(),
    relation: z.enum(['created', 'updated', 'related']),
    triage_id: z.string().uuid().nullable(),
    linked_by: z.string().uuid().nullable(),
  })).max(500),
  kept: z.array(z.unknown()).optional(),
});

/** Restore all: what one Undo all took back, put back. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => restoreAgentWork(ctx, id, await readBody(request, restoreSchema)));
}
