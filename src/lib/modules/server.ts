import type { SupabaseClient } from '@supabase/supabase-js';
import { MODULE_IDS, isModuleId, type ModuleId } from '@/lib/modules/registry';

/**
 * Server-side reads of which modules are switched on. Service-role code
 * (crons, MCP, inbound email, webhook dispatch, public portal routes) skips
 * RLS, so it must ask here before acting for a module.
 */

function isSchemaMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (['42P01', 'PGRST205'].includes(error.code || '')) return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('workspace_modules') && (message.includes('does not exist') || message.includes('schema cache'));
}

/**
 * The switched-on modules, in registry order. Before the modules migration is
 * applied every module counts as on (today's behavior). A failed read is tried
 * once more; if it fails again this returns null, and access checks fail closed.
 */
export async function readEnabledModules(client: SupabaseClient): Promise<ModuleId[] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await client.from('workspace_modules').select('module_id, enabled');
    if (error) {
      if (isSchemaMissing(error)) return [...MODULE_IDS];
      continue;
    }
    const off = new Set(
      (data || []).filter((row) => row.enabled === false).map((row) => row.module_id as string),
    );
    // A module with no row yet (added by a newer release before its seed ran) is on.
    return MODULE_IDS.filter((id) => !off.has(id));
  }
  return null;
}

/**
 * The module switches could not be read. Thrown rather than read as "off", so
 * a database blip answers with a server error the caller retries, never a
 * wrong "switched off" or "not found".
 */
export class ModuleReadError extends Error {
  constructor() {
    super('Could not read which features are switched on. Try again.');
    this.name = 'ModuleReadError';
  }
}

async function readOrThrow(client: SupabaseClient): Promise<ModuleId[]> {
  const modules = await readEnabledModules(client);
  if (!modules) throw new ModuleReadError();
  return modules;
}

/** Whether one module is on. Throws ModuleReadError when the switches cannot be read. */
export async function moduleEnabled(client: SupabaseClient, id: ModuleId): Promise<boolean> {
  return (await readOrThrow(client)).includes(id);
}

/**
 * The switched-on modules as a set, for a path that checks several in one
 * read. Throws ModuleReadError when the switches cannot be read.
 */
export async function enabledModuleSet(client: SupabaseClient): Promise<ReadonlySet<ModuleId>> {
  return new Set(await readOrThrow(client));
}

export function parseModuleList(value: unknown): ModuleId[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(isModuleId);
  return ids.length === value.length ? MODULE_IDS.filter((id) => ids.includes(id)) : null;
}
