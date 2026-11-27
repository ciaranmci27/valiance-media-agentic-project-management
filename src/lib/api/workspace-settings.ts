import 'server-only';
import { NextResponse } from 'next/server';
import { plainDbError } from '@/lib/api/plain-error';
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertAuditRows, logAudit } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { isSchemaMissing } from '@/lib/api/owner-route';
import { DEFAULT_BRAND, resolveBrand, type BrandSettings } from '@/lib/brand';
import { expireBrand, readStoredBrand, type StoredBrand } from '@/lib/brand/server';
import { parseBrandInput, type ParsedBrandInput } from '@/lib/brand/validate';
import { moneyFormatPattern } from '@/lib/format';
import { MODULE_IDS, normalizeModules, type ModuleId } from '@/lib/modules/registry';
import { DEFAULT_REGION, parseRegionInput, sameRegion, type Region } from '@/lib/region';
import { expireRegion, readStoredRegion } from '@/lib/region/server';
import { ApiError, badRequest } from './errors';

/**
 * The Owner's workspace switches that Settings saves and the API saves too:
 * Features (modules), Brand (name, colors, sidebar; logos upload on their own
 * route) and Region. One writer each, so the app and an Owner's key keep the
 * same rules (module dependencies kept whole, a cached brand or region
 * expired at once). Who may call is the route's to check (an Owner, by
 * role). Each write answers what to record in the audit log; the session
 * route records it as the app, a v1 route as the key (logAudit).
 *
 * Errors: ApiError for what the caller can fix (400) or a database update
 * still to run (409 MIGRATION_REQUIRED); a database error is thrown as it
 * came (a 500).
 */

/** What a write records in the audit log, beside who and how. */
export interface SettingsAudit {
  method: 'PUT' | 'PATCH';
  entity_type: 'workspace_modules' | 'workspace_brand' | 'workspace_region';
  request_body: unknown;
  before_snapshot: unknown;
  after_snapshot: unknown;
}

export interface SettingsWrite<T> {
  data: T;
  /** Null when nothing changed and nothing is recorded. */
  audit: SettingsAudit | null;
}

export const migrationRequired = () => new ApiError(409, 'MIGRATION_REQUIRED', 'Run the latest database migration first.', { reason: 'migration_required' });

/**
 * The session routes' answer for an error from these writers, as they always
 * answered: { error } with its status, and code MIGRATION_REQUIRED when the
 * database update is missing.
 */
export function settingsErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message, ...(error.code === 'MIGRATION_REQUIRED' ? { code: error.code } : {}) },
      { status: error.statusCode },
    );
  }
  // A database error: plain words for the caller, the raw message to the server log only.
  return plainDbError(error as { code?: string; message?: string } | null);
}

/** Records a session route's write in the audit log as the app, once the response is sent. */
export function auditSettingsInApp(service: SupabaseClient, memberId: string, endpoint: string, audit: SettingsAudit | null): void {
  if (!audit) return;
  afterResponse(`${audit.entity_type.replace('_', ' ')} audit`, async () => {
    const { error } = await insertAuditRows(service, {
      method: audit.method,
      endpoint,
      entity_type: audit.entity_type,
      team_member_id: memberId,
      request_body: audit.request_body,
      before_snapshot: audit.before_snapshot,
      after_snapshot: audit.after_snapshot,
      status_code: 200,
      via: 'app',
    });
    if (error) throw error;
  });
}

/** Records a v1 route's write in the audit log as the key (rest, or mcp through a tool). */
export function auditSettingsForKey(
  supabase: SupabaseClient,
  endpoint: string,
  key: { apiKeyId: string; teamMemberId: string },
  audit: Pick<SettingsAudit, 'request_body' | 'before_snapshot' | 'after_snapshot'> & { method: string; entity_type: string } | null,
): void {
  if (!audit) return;
  logAudit(supabase, {
    method: audit.method, endpoint, entityType: audit.entity_type, apiKeyId: key.apiKeyId, teamMemberId: key.teamMemberId,
    requestBody: audit.request_body, beforeSnapshot: audit.before_snapshot, afterSnapshot: audit.after_snapshot, statusCode: 200,
  });
}

/**
 * Expires a cached read (brand, region). Outside a Next.js request, such as a
 * script or test calling a handler directly, there is no cache to expire.
 */
export function expireCache(expire: () => void): void {
  try {
    expire();
  } catch (error) {
    if (!String((error as Error)?.message ?? '').includes('static generation store missing')) throw error;
  }
}

// ─── Features (modules) ───────────────────────────────────────────────

export interface WorkspaceModulesState {
  modules: ModuleId[];
  setupCompleted: boolean;
  /** When setup was finished or skipped, for the Dashboard's Getting started list. */
  setupCompletedAt: string | null;
}

async function loadModules(service: SupabaseClient): Promise<{ state: WorkspaceModulesState; rows: Set<string>; settingsId: string | null }> {
  const [modules, settings] = await Promise.all([
    service.from('workspace_modules').select('module_id, enabled'),
    service.from('business_settings').select('id, setup_completed_at').limit(1).maybeSingle(),
  ]);
  const failure = modules.error || settings.error;
  if (failure) throw isSchemaMissing(failure) ? migrationRequired() : failure;
  const rows = modules.data || [];
  // A module with no row yet (added by a newer release before its seed ran) is on.
  const off = new Set(rows.filter((row) => row.enabled === false).map((row) => row.module_id as string));
  return {
    state: {
      modules: MODULE_IDS.filter((id) => !off.has(id)),
      setupCompleted: !!settings.data?.setup_completed_at,
      setupCompletedAt: (settings.data?.setup_completed_at as string | null | undefined) ?? null,
    },
    rows: new Set(rows.map((row) => row.module_id as string)),
    settingsId: (settings.data?.id as string | undefined) ?? null,
  };
}

export async function readWorkspaceModules(service: SupabaseClient): Promise<WorkspaceModulesState> {
  return (await loadModules(service)).state;
}

/**
 * Switches modules to exactly `modules` (dependencies kept whole: a module
 * whose requirements are off stays off) and, with completeSetup, marks
 * first-run setup finished.
 */
export async function saveWorkspaceModules(
  service: SupabaseClient,
  memberId: string,
  input: { modules: ModuleId[]; completeSetup?: boolean },
): Promise<SettingsWrite<WorkspaceModulesState>> {
  const next = normalizeModules(input.modules);
  const before = await loadModules(service);
  const wanted = new Set(next);
  const was = new Set(before.state.modules);

  // Every row ends in its new state. A row is written when it changes or is
  // missing, so updated_by names whoever last switched that module.
  const writes = MODULE_IDS
    .filter((id) => !before.rows.has(id) || was.has(id) !== wanted.has(id))
    .map((id) => ({ module_id: id, enabled: wanted.has(id), updated_by: memberId }));
  if (writes.length > 0) {
    const { error } = await service.from('workspace_modules').upsert(writes, { onConflict: 'module_id' });
    if (error) throw isSchemaMissing(error) ? migrationRequired() : error;
  }

  let { setupCompleted, setupCompletedAt } = before.state;
  if (input.completeSetup && !setupCompleted) {
    const stamp = { setup_completed_at: new Date().toISOString() };
    const { error } = before.settingsId
      ? await service.from('business_settings').update(stamp).eq('id', before.settingsId)
      : await service.from('business_settings').insert(stamp);
    if (error) throw error;
    setupCompleted = true;
    setupCompletedAt = stamp.setup_completed_at;
  }

  const after: WorkspaceModulesState = { modules: next, setupCompleted, setupCompletedAt };
  return {
    data: after,
    audit: {
      method: 'PUT',
      entity_type: 'workspace_modules',
      request_body: { modules: input.modules, completeSetup: input.completeSetup ?? false },
      before_snapshot: before.state,
      after_snapshot: after,
    },
  };
}

// ─── Brand ────────────────────────────────────────────────────────────

export function brandPayload(settings: BrandSettings) {
  return { settings, brand: resolveBrand(settings), defaults: DEFAULT_BRAND };
}

export type BrandPayload = ReturnType<typeof brandPayload>;

async function storedBrand(service: SupabaseClient): Promise<StoredBrand> {
  const stored = await readStoredBrand(service);
  if (!stored.tableReady) throw migrationRequired();
  return stored;
}

export async function readWorkspaceBrand(service: SupabaseClient): Promise<BrandPayload> {
  return brandPayload((await storedBrand(service)).settings);
}

async function writeBrand(service: SupabaseClient, memberId: string, input: ParsedBrandInput, before: StoredBrand, method: 'PUT' | 'PATCH'): Promise<SettingsWrite<BrandPayload>> {
  const row = {
    id: true,
    name: input.name,
    tagline: input.tagline,
    description: input.description,
    brand_color: input.brandColor,
    brand_shades: input.brandShades,
    accent_color: input.accentColor,
    invert_logo_in_sidebar: input.invertLogoInSidebar,
    show_name_under_logo: input.showNameUnderLogo,
    // Written only when it changes, so an install that has not run this
    // release's migration yet can still save the rest of its brand.
    ...(input.sidebarProjects !== undefined && input.sidebarProjects !== before.settings.sidebarProjects
      ? { sidebar_projects: input.sidebarProjects } : {}),
    ...(input.sidebarActiveProjects !== undefined && input.sidebarActiveProjects !== before.settings.sidebarActiveProjects
      ? { sidebar_active_projects: input.sidebarActiveProjects } : {}),
    updated_by: memberId,
  };
  let { error } = await service.from('workspace_brand').upsert(row, { onConflict: 'id' });
  // Code deployed before its migration: save everything the table already has.
  if (error && isSchemaMissing(error) && 'sidebar_active_projects' in row) {
    const { sidebar_active_projects: _later, ...rest } = row;
    void _later;
    ({ error } = await service.from('workspace_brand').upsert(rest, { onConflict: 'id' }));
  }
  if (error) throw isSchemaMissing(error) ? migrationRequired() : error;

  expireCache(expireBrand);
  const settings: BrandSettings = { ...before.settings, ...input };
  return {
    data: brandPayload(settings),
    audit: { method, entity_type: 'workspace_brand', request_body: input, before_snapshot: before.settings, after_snapshot: settings },
  };
}

/** Saves the whole brand form (blank means the default); the sidebar's project options left out keep what is stored. */
export async function saveWorkspaceBrand(service: SupabaseClient, memberId: string, body: unknown): Promise<SettingsWrite<BrandPayload>> {
  const parsed = parseBrandInput(body);
  if (parsed.error !== null) throw badRequest(parsed.error);
  return writeBrand(service, memberId, parsed.data, await storedBrand(service), 'PUT');
}

/** The brand fields a save writes: everything but the logos. */
const BRAND_FIELDS = [
  'name', 'tagline', 'description', 'brandColor', 'brandShades', 'accentColor',
  'invertLogoInSidebar', 'showNameUnderLogo', 'sidebarProjects', 'sidebarActiveProjects',
] as const;

/**
 * Changes only the fields sent (null clears a text or color to the default),
 * keeping the rest as stored, by the same checks and writer as the form.
 */
export async function patchWorkspaceBrand(service: SupabaseClient, memberId: string, changes: Record<string, unknown>): Promise<SettingsWrite<BrandPayload>> {
  const before = await storedBrand(service);
  const merged: Record<string, unknown> = {};
  for (const field of BRAND_FIELDS) merged[field] = field in changes ? changes[field] : before.settings[field];
  const parsed = parseBrandInput(merged);
  if (parsed.error !== null) throw badRequest(parsed.error);
  return writeBrand(service, memberId, parsed.data, before, 'PATCH');
}

/**
 * Sets how the sidebar shows projects (the Projects item's style and, when
 * sent, the active projects section), and nothing else: the setup wizard
 * picks them from the preset without sending the whole brand form.
 */
export async function setSidebarProjects(service: SupabaseClient, memberId: string, body: unknown): Promise<SettingsWrite<BrandPayload>> {
  const style = (body as { sidebarProjects?: unknown } | null)?.sidebarProjects;
  if (style !== 'list' && style !== 'menu') throw badRequest('sidebarProjects must be list or menu');
  const section = (body as { sidebarActiveProjects?: unknown } | null)?.sidebarActiveProjects;
  if (section !== undefined && typeof section !== 'boolean') throw badRequest('sidebarActiveProjects must be true or false');

  const before = await storedBrand(service);
  const sectionChanges = section !== undefined && section !== before.settings.sidebarActiveProjects;
  if (before.settings.sidebarProjects === style && !sectionChanges) return { data: brandPayload(before.settings), audit: null };

  let { error } = await service.from('workspace_brand').upsert(
    { id: true, sidebar_projects: style, ...(sectionChanges ? { sidebar_active_projects: section } : {}), updated_by: memberId },
    { onConflict: 'id' },
  );
  // Code deployed before its migration: the style still saves.
  if (error && isSchemaMissing(error) && sectionChanges) {
    ({ error } = await service.from('workspace_brand').upsert({ id: true, sidebar_projects: style, updated_by: memberId }, { onConflict: 'id' }));
  }
  if (error) throw isSchemaMissing(error) ? migrationRequired() : error;

  expireCache(expireBrand);
  const settings: BrandSettings = { ...before.settings, sidebarProjects: style, ...(sectionChanges ? { sidebarActiveProjects: section as boolean } : {}) };
  return {
    data: brandPayload(settings),
    audit: {
      method: 'PATCH',
      entity_type: 'workspace_brand',
      request_body: { sidebarProjects: style, ...(section === undefined ? {} : { sidebarActiveProjects: section }) },
      before_snapshot: before.settings,
      after_snapshot: settings,
    },
  };
}

// ─── Region ───────────────────────────────────────────────────────────

export function regionPayload(region: Region) {
  return { region, defaults: DEFAULT_REGION };
}

export type RegionPayload = ReturnType<typeof regionPayload>;

async function storedRegion(service: SupabaseClient): Promise<Region> {
  const stored = await readStoredRegion(service);
  if (!stored.tableReady) throw migrationRequired();
  return stored.region;
}

export async function readWorkspaceRegion(service: SupabaseClient): Promise<RegionPayload> {
  return regionPayload(await storedRegion(service));
}

async function writeRegion(service: SupabaseClient, memberId: string, region: Region, before: Region, method: 'PUT' | 'PATCH'): Promise<SettingsWrite<RegionPayload>> {
  if (sameRegion(before, region)) return { data: regionPayload(region), audit: null };
  const { error } = await service.from('workspace_region').upsert({
    id: true,
    currency: region.currency,
    locale: region.locale,
    week_start: region.weekStart,
    // How the database writes amounts in activity lines, Trash and billing notices.
    money_format: moneyFormatPattern(region.currency, region.locale),
    updated_by: memberId,
  }, { onConflict: 'id' });
  if (error) throw isSchemaMissing(error) ? migrationRequired() : error;
  expireCache(expireRegion);
  return {
    data: regionPayload(region),
    audit: { method, entity_type: 'workspace_region', request_body: region, before_snapshot: before, after_snapshot: region },
  };
}

/** Saves the currency, locale and week start, all three. */
export async function saveWorkspaceRegion(service: SupabaseClient, memberId: string, body: unknown): Promise<SettingsWrite<RegionPayload>> {
  const parsed = parseRegionInput(body);
  if (parsed.error !== null) throw badRequest(parsed.error);
  return writeRegion(service, memberId, parsed.data, await storedRegion(service), 'PUT');
}

/** Changes only the fields sent (currency, locale, weekStart), keeping the rest as stored. */
export async function patchWorkspaceRegion(service: SupabaseClient, memberId: string, changes: Partial<Record<keyof Region, unknown>>): Promise<SettingsWrite<RegionPayload>> {
  const before = await storedRegion(service);
  const parsed = parseRegionInput({ ...before, ...changes });
  if (parsed.error !== null) throw badRequest(parsed.error);
  return writeRegion(service, memberId, parsed.data, before, 'PATCH');
}
