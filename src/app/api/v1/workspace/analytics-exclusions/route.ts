import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { moduleOff, notFound } from '@/lib/api/errors';
import { isModuleEnabled } from '@/lib/access-control';
import { EXCLUDED_IPS_MAX, EXCLUDED_IP_LABEL_MAX, isPlausibleIp } from '@/lib/analytics-exclusions';
import type { ExcludedIp } from '@/lib/types';

export const dynamic = 'force-dynamic';

const exclusionsSchema = z.object({
  excluded_ips: z.array(z.object({
    ip: z.string().trim().refine(isPlausibleIp, 'That does not look like an IP address'),
    label: z.string().trim().max(EXCLUDED_IP_LABEL_MAX).default('Unlabeled'),
  }).strict()).max(EXCLUDED_IPS_MAX)
    .refine((list) => new Set(list.map((entry) => entry.ip)).size === list.length, 'Each IP once'),
}).strict();
type ExclusionsBody = z.infer<typeof exclusionsSchema>;

async function settingsRow(db: Parameters<Parameters<typeof withApi>[0]>[0]['supabase']) {
  const { data, error } = await db.from('business_settings').select('id, excluded_ips').limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Business settings');
  return data as { id: string; excluded_ips: ExcludedIp[] | null };
}

/**
 * Settings > Client portal > Analytics exclusions: the IPs (yours, your
 * team's) left out of every project's portal analytics. For whoever manages
 * settings (settings.manage on the key), with the Client portal on.
 * Answers { excluded_ips: [{ ip, label }] }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  if (!isModuleEnabled(access, 'portal')) throw moduleOff('portal');
  return success({ excluded_ips: (await settingsRow(supabase)).excluded_ips ?? [] });
}, { permission: 'settings.manage' });

/** Replaces the whole list: read it, change it, send it back (an empty list excludes nobody). */
export const PUT = withApi<ExclusionsBody>(async ({ supabase, access, body, apiKeyId, teamMemberId }) => {
  if (!isModuleEnabled(access, 'portal')) throw moduleOff('portal');
  const before = await settingsRow(supabase);
  const excluded = body.excluded_ips.map((entry) => ({ ip: entry.ip, label: entry.label || 'Unlabeled' }));
  const { error } = await supabase.from('business_settings').update({ excluded_ips: excluded }).eq('id', before.id);
  if (error) throw error;
  logAudit(supabase, { method: 'PUT', endpoint: '/api/v1/workspace/analytics-exclusions', entityType: 'business_settings', entityId: before.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: { excluded_ips: before.excluded_ips ?? [] }, afterSnapshot: { excluded_ips: excluded }, statusCode: 200 });
  return success({ excluded_ips: excluded });
}, { schema: exclusionsSchema, permission: 'settings.manage' });
