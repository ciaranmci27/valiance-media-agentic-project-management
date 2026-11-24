import { addBriefEntry, readBrief } from '@/lib/api/project-brief';
import { ApiError } from '@/lib/api/errors';
import { pageFrom, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { isBriefSection } from '@/lib/project-brief';
import { createBriefEntrySchema } from '@/lib/schemas/agent-workspaces';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The project's brief: { sections: [{ key, label, entries, total }], goals,
 * omitted }. Each section holds its first 50 entries (pinned first, then the
 * newest); ?section=rules&page=2&limit=50 pages one section. For
 * project_context.read on a project the caller reaches.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const searchParams = new URL(request.url).searchParams;
    const section = searchParams.get('section');
    if (section && !isBriefSection(section)) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown brief section', { reason: 'invalid_section' });
    const { limit, offset } = pageFrom(searchParams, 200, 50);
    return readBrief(service, caller, (await params).id, { section: section && isBriefSection(section) ? section : null, offset, limit });
  });
}

/** Adds an entry: { section, content, pinned? }. For project_context.manage. Answers the entry. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, createBriefEntrySchema);
    return addBriefEntry(service, caller, (await params).id, body);
  }, { status: 201 });
}
