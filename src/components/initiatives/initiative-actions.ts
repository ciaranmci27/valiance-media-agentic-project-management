import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables } from '@/lib/query-cache';
import { INITIATIVE_TABLES } from '@/lib/reads';
import { demoInitiativeEntries, demoInitiatives } from '@/lib/demo-data';
import type { Initiative, InitiativeEntry } from '@/lib/types';
import type {
  CreateInitiativeEntryInput, CreateInitiativeInput, InitiativeEntryView, InitiativeView, UpdateInitiativeEntryInput, UpdateInitiativeInput,
} from '@/lib/initiatives';

/**
 * The initiative writes the screens make, through the session routes. Each
 * marks the initiative reads stale so every screen showing one refreshes.
 * In demo mode the demo rows change in place instead (nothing leaves the
 * browser; a reload starts the demo over).
 */

const base = (projectId: string) => `/api/workspace/projects/${encodeURIComponent(projectId)}/initiatives`;
const one = (projectId: string, initiativeId: string) => `${base(projectId)}/${encodeURIComponent(initiativeId)}`;

const refresh = () => invalidateTables([...INITIATIVE_TABLES, 'project_context']);

/** Demo rows in Trash: they leave the demo arrays and come back on restore. */
const demoTrash = new Map<string, Initiative>();

export async function createInitiative(projectId: string, input: CreateInitiativeInput, demo: { isDemo: boolean; memberId: string | null }): Promise<{ id: string }> {
  if (demo.isDemo) {
    const now = new Date().toISOString();
    const row: Initiative = {
      id: crypto.randomUUID(),
      project_id: projectId,
      name: input.name.trim(),
      description: input.description ?? '',
      owner_member_id: input.owner_member_id ?? null,
      owner_group_id: input.owner_group_id ?? null,
      status: input.status ?? 'planned',
      health: input.status === 'active' ? input.health ?? null : null,
      start_date: input.start_date ?? null,
      target_date: input.target_date ?? null,
      sort_order: input.sort_order ?? demoInitiatives.filter((i) => i.project_id === projectId).length,
      created_by: demo.memberId,
      created_at: now,
      updated_at: now,
    };
    demoInitiatives.push(row);
    refresh();
    return { id: row.id };
  }
  const created = await workspaceApi<InitiativeView>(base(projectId), { method: 'POST', body: input });
  refresh();
  return { id: created.id };
}

export async function updateInitiative(projectId: string, initiativeId: string, input: UpdateInitiativeInput, isDemo: boolean): Promise<void> {
  if (isDemo) {
    const row = demoInitiatives.find((i) => i.id === initiativeId);
    if (row) {
      Object.assign(row, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), { updated_at: new Date().toISOString() });
      if (row.status !== 'active') row.health = null;
    }
    refresh();
    return;
  }
  await workspaceApi(one(projectId, initiativeId), { method: 'PATCH', body: input });
  refresh();
}

export async function trashInitiative(projectId: string, initiativeId: string, isDemo: boolean): Promise<void> {
  if (isDemo) {
    const index = demoInitiatives.findIndex((i) => i.id === initiativeId);
    if (index >= 0) demoTrash.set(initiativeId, demoInitiatives.splice(index, 1)[0]);
    refresh();
    return;
  }
  await workspaceApi(one(projectId, initiativeId), { method: 'DELETE' });
  refresh();
}

export async function restoreInitiative(projectId: string, initiativeId: string, isDemo: boolean): Promise<void> {
  if (isDemo) {
    const row = demoTrash.get(initiativeId);
    if (row) {
      demoTrash.delete(initiativeId);
      demoInitiatives.push(row);
    }
    refresh();
    return;
  }
  await workspaceApi(`${one(projectId, initiativeId)}/restore`, { method: 'POST' });
  refresh();
}

export async function addInitiativeEntry(
  projectId: string, initiativeId: string, input: CreateInitiativeEntryInput, demo: { isDemo: boolean; memberId: string | null },
): Promise<void> {
  if (demo.isDemo) {
    const now = new Date().toISOString();
    const row: InitiativeEntry = {
      id: crypto.randomUUID(),
      initiative_id: initiativeId,
      project_id: projectId,
      kind: input.kind,
      title: input.title.trim(),
      body: input.body ?? '',
      task_id: input.task_id ?? null,
      status: input.kind === 'issue' ? 'open' : null,
      resolved_at: null,
      resolved_by: null,
      created_by: demo.memberId,
      created_at: now,
      updated_at: now,
    };
    demoInitiativeEntries.push(row);
    refresh();
    return;
  }
  await workspaceApi<InitiativeEntryView>(`${one(projectId, initiativeId)}/entries`, { method: 'POST', body: input });
  refresh();
}

export async function updateInitiativeEntry(
  projectId: string, initiativeId: string, entryId: string, input: UpdateInitiativeEntryInput, demo: { isDemo: boolean; memberId: string | null },
): Promise<void> {
  if (demo.isDemo) {
    const row = demoInitiativeEntries.find((e) => e.id === entryId);
    if (row) {
      const now = new Date().toISOString();
      if (input.title !== undefined) row.title = input.title.trim();
      if (input.body !== undefined) row.body = input.body;
      if (input.task_id !== undefined) row.task_id = input.task_id;
      if (input.status !== undefined && row.kind === 'issue') {
        row.status = input.status;
        row.resolved_at = input.status === 'resolved' ? now : null;
        row.resolved_by = input.status === 'resolved' ? demo.memberId : null;
      }
      row.updated_at = now;
    }
    refresh();
    return;
  }
  await workspaceApi(`${one(projectId, initiativeId)}/entries/${encodeURIComponent(entryId)}`, { method: 'PATCH', body: input });
  refresh();
}

export async function trashInitiativeEntry(projectId: string, initiativeId: string, entryId: string, isDemo: boolean): Promise<void> {
  if (isDemo) {
    const index = demoInitiativeEntries.findIndex((e) => e.id === entryId);
    if (index >= 0) demoInitiativeEntries.splice(index, 1);
    refresh();
    return;
  }
  await workspaceApi(`${one(projectId, initiativeId)}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
  refresh();
}

/**
 * The initiative just moved to Trash from its own page, for the Initiatives
 * tab it lands on to offer Undo in place. The tab reads it on mount (a pure
 * read, safe to run twice) and clears it once shown.
 */
let trashNotice: { projectId: string; id: string; name: string } | null = null;

export function leaveTrashNotice(notice: { projectId: string; id: string; name: string }) {
  trashNotice = notice;
}

export function peekTrashNotice(projectId: string): { id: string; name: string } | null {
  return trashNotice && trashNotice.projectId === projectId ? { id: trashNotice.id, name: trashNotice.name } : null;
}

export function clearTrashNotice(id: string) {
  if (trashNotice?.id === id) trashNotice = null;
}

/** What a failed write says. */
export function writeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
