import { addEntry, entryFiltersFrom, listEntries } from '@/lib/api/initiatives';
import { pageFrom, pageMeta, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { createInitiativeEntrySchema, INITIATIVE_READ_LIMITS } from '@/lib/initiatives';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; initiativeId: string }> };

/** An initiative's log, newest first, 50 a page (filters kind, status). Answers { entries, meta }. */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    const searchParams = new URL(request.url).searchParams;
    const { page, limit, offset } = pageFrom(searchParams, 100, INITIATIVE_READ_LIMITS.entriesPage);
    const { rows, total } = await listEntries(service, caller, id, initiativeId, { ...entryFiltersFrom(searchParams), offset, limit });
    return { entries: rows, meta: pageMeta(page, limit, total) };
  });
}

/** Adds an entry to the log as the signed-in member (never a guest). */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const { id, initiativeId } = await params;
    const body = await readWorkspaceBody(request, createInitiativeEntrySchema);
    return addEntry(service, caller, id, initiativeId, body);
  }, { status: 201 });
}
