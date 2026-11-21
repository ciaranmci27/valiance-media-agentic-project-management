'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { setReadData, useRead, type Read } from '@/lib/query-cache';
import { MODULE_IDS, MODULES, type ModuleId } from '@/lib/modules/registry';

/**
 * The Owner's side of the module switches, shared by Settings > Features and
 * the setup wizard. Which modules are on comes from the access
 * context (the same answer every screen uses, refreshed in every open tab by
 * realtime); the route adds whether setup is finished and whether the
 * database is ready for switches at all.
 */

export type WorkspaceModulesState =
  | { status: 'ready'; modules: ModuleId[]; setupCompleted: boolean; setupCompletedAt?: string | null }
  /** The modules migration has not run: nothing can be switched yet. */
  | { status: 'migration'; message: string };

class MigrationMissingError extends Error {}

async function parse(response: Response): Promise<{ modules: ModuleId[]; setupCompleted: boolean; setupCompletedAt?: string | null }> {
  const payload = await response.json().catch(() => ({}));
  if (response.status === 409) throw new MigrationMissingError(payload.error || 'Run the latest database migration first.');
  if (!response.ok) throw new Error(payload.error || 'Could not reach the server.');
  return payload.data;
}

/** Owner only, read once a session: setup and the switches change only through this screen. */
export const workspaceModulesRead: Read<WorkspaceModulesState> = {
  key: 'workspace-modules',
  tables: ['workspace_modules'],
  ttlMs: 10 * 60_000,
  load: async () => {
    try {
      const data = await parse(await fetch('/api/workspace/modules', { cache: 'no-store' }));
      return { status: 'ready', ...data };
    } catch (error) {
      if (error instanceof MigrationMissingError) return { status: 'migration', message: error.message };
      throw error;
    }
  },
};

/** Labels in reading order: "Leads", "Leads and Client portal", "Time, Billing and Webhooks". */
export function moduleList(ids: readonly ModuleId[]): string {
  const labels = ids.map((id) => MODULES[id].label);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export type SaveResult = { ok: true } | { ok: false; message: string; migration: boolean };

/**
 * The enabled set as shown, and one way to change it. A change shows at once
 * and saves behind itself; a failed save puts the set back. In the demo
 * workspace it changes the sample workspace only, until a reload.
 */
export function useModuleSwitch() {
  const { access, refreshAccess, setDemoModules } = useAuth();
  const { isDemoMode } = useDemo();
  const isOwner = access?.role === 'owner';
  const read = useRead(isOwner && !isDemoMode ? workspaceModulesRead : null);

  const live = new Set(access?.modules ?? MODULE_IDS);
  const base = MODULE_IDS.filter((id) => live.has(id));
  const baseKey = base.join(',');

  // The set being saved, or just saved, tied to the access it was made from:
  // once access catches up (refreshAccess or realtime) the live set shows
  // again, and if the refresh fails the saved set stays shown. Read through a
  // ref, so an Undo made from an earlier render still ties to today's access.
  const [pending, setPending] = useState<{ modules: ModuleId[]; baseKey: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const baseKeyRef = useRef(baseKey);
  useEffect(() => { baseKeyRef.current = baseKey; }, [baseKey]);
  const enabled = pending && (saving || pending.baseKey === baseKey) ? pending.modules : base;

  const save = useCallback(async (next: ModuleId[], options: { completeSetup?: boolean } = {}): Promise<SaveResult> => {
    if (isDemoMode) {
      setDemoModules(next);
      return { ok: true };
    }
    setPending({ modules: next, baseKey: baseKeyRef.current });
    setSaving(true);
    try {
      const response = await fetch('/api/workspace/modules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modules: next, ...(options.completeSetup ? { completeSetup: true } : {}) }),
      });
      const saved = await parse(response);
      setReadData<WorkspaceModulesState>(workspaceModulesRead, () => ({ status: 'ready', ...saved }));
      setPending({ modules: saved.modules, baseKey: baseKeyRef.current });
      // This tab reshapes now; the others follow through realtime.
      await refreshAccess().catch(() => {});
      return { ok: true };
    } catch (error) {
      setPending(null);
      const migration = error instanceof MigrationMissingError;
      if (migration) setReadData<WorkspaceModulesState>(workspaceModulesRead, () => ({ status: 'migration', message: error.message }));
      return { ok: false, message: error instanceof Error ? error.message : 'Could not save.', migration };
    } finally {
      setSaving(false);
    }
  }, [isDemoMode, refreshAccess, setDemoModules]);

  return { enabled, save, saving, read, isDemoMode, isOwner };
}
