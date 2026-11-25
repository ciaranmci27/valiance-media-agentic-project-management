import { z } from 'zod';
import { addScopedEntry, readScopedBrief, scopeFromRequest } from '@/lib/api/context-scopes';
import { ApiError } from '@/lib/api/errors';
import { pageFrom, readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { BRIEF_ENTRY_MAX, BRIEF_SECTION_KEYS, isBriefSection } from '@/lib/project-brief';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ scope: string }> };

/**
 * A scope's context as sections: { scope, name, sections, can_edit }. Each
 * section holds its first 50 entries (pinned first, then the newest);
 * ?section=rules&page=2&limit=50 pages one section. Company knowledge,
 * group knowledge, an agent's notes, or the reader's own memory (member
 * with scope_id their own id): who reads which is lib/api/context-scopes.ts.
 */
export async function GET(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const ref = scopeFromRequest(request, (await params).scope);
    const searchParams = new URL(request.url).searchParams;
    const section = searchParams.get('section');
    if (section && !isBriefSection(section)) throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown section', { reason: 'invalid_section' });
    const { limit, offset } = pageFrom(searchParams, 200, 50);
    return readScopedBrief(service, caller, ref, { section: section && isBriefSection(section) ? section : null, offset, limit });
  }, { noStore: true });
}

const entrySchema = z.object({
  section: z.enum(BRIEF_SECTION_KEYS),
  content: z.string().trim().min(1, 'Write something first').max(BRIEF_ENTRY_MAX),
  pinned: z.boolean().optional(),
}).strict();

/** Adds an entry: { section, content, pinned? }, for whoever may write the scope. Answers the entry. */
export async function POST(request: Request, { params }: Params) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const ref = scopeFromRequest(request, (await params).scope);
    const body = await readWorkspaceBody(request, entrySchema);
    return addScopedEntry(service, caller, { ...ref, ...body });
  }, { status: 201 });
}
