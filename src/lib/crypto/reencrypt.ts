import type { SupabaseClient } from '@supabase/supabase-js';
import { appKeyReady, appKeyState, type AppKeyState } from './app-key';
import { decrypt as decryptSmtp, encrypt as encryptSmtp } from '@/lib/email/crypto';
import { decrypt as decryptCredential, encrypt as encryptCredential, APP_SEALED_IV } from '@/lib/api/encryption';

/**
 * Moving saved secrets onto the app key (APP_ENCRYPTION_KEY): email account
 * passwords and project credentials still sealed under the older per-feature
 * keys are opened with those and sealed again with the app key. Safe to run
 * again: rows already on the app key are skipped. Settings > Workspace >
 * Encryption runs it and shows what is left; only at zero can the older
 * variables be removed from the host.
 */

export interface EncryptionStatus {
  appKey: AppKeyState;
  /** The older variables the host still has (names only). */
  legacyKeys: string[];
  /** Saved values still sealed under an older key. */
  remaining: { smtp: number; credentials: number };
}

const LEGACY_ENV = ['SMTP_ENCRYPTION_KEY', 'PROJECT_CREDENTIALS_ENCRYPTION_KEY'] as const;
const PAGE = 500;

async function countLegacy(service: SupabaseClient, table: 'smtp_accounts' | 'project_credentials', column: string): Promise<number> {
  // trash-checked: counts every saved value, those in Trash too: they all move to the new key.
  const { count, error } = await service.from(table).select('id', { count: 'exact', head: true }).not(column, 'like', 'pm1:%');
  if (error) throw error;
  return count ?? 0;
}

export async function encryptionStatus(service: SupabaseClient): Promise<EncryptionStatus> {
  const [smtp, credentials] = await Promise.all([
    countLegacy(service, 'smtp_accounts', 'encrypted_password'),
    countLegacy(service, 'project_credentials', 'encrypted_data'),
  ]);
  return {
    appKey: appKeyState(),
    legacyKeys: LEGACY_ENV.filter((name) => !!process.env[name]?.trim()),
    remaining: { smtp, credentials },
  };
}

export interface ReencryptResult {
  moved: { smtp: number; credentials: number };
  /** Rows the older keys could not open (the key changed or is missing): left as they are. */
  failed: { smtp: string[]; credentials: string[] };
  status: EncryptionStatus;
}

export async function reencryptAll(service: SupabaseClient): Promise<ReencryptResult> {
  if (!appKeyReady()) throw new Error('Add APP_ENCRYPTION_KEY to your host first.');
  const moved = { smtp: 0, credentials: 0 };
  const failed = { smtp: [] as string[], credentials: [] as string[] };

  // Email passwords, page by page in id order (keyset: each page starts after
  // the last id seen), so rows that fail never need excluding and the loop ends.
  let after = '';
  for (;;) {
    let query = service.from('smtp_accounts').select('id, encrypted_password').not('encrypted_password', 'like', 'pm1:%').order('id').limit(PAGE);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data as Array<{ id: string; encrypted_password: string }>) {
      after = row.id;
      try {
        const sealed = encryptSmtp(decryptSmtp(row.encrypted_password));
        // Only if nobody changed it meanwhile; count only a row that really changed.
        const { data: changed, error: updateError } = await service.from('smtp_accounts').update({ encrypted_password: sealed })
          .eq('id', row.id).eq('encrypted_password', row.encrypted_password).select('id');
        if (updateError) throw updateError;
        if (changed?.length) moved.smtp += 1;
      } catch {
        failed.smtp.push(row.id);
      }
    }
  }

  after = '';
  for (;;) {
    // includes-deleted: credentials in Trash move too, or restoring one later would leave it unreadable.
    let query = service.from('project_credentials').select('id, encrypted_data, iv').not('encrypted_data', 'like', 'pm1:%').order('id').limit(PAGE);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data as Array<{ id: string; encrypted_data: string; iv: string }>) {
      after = row.id;
      try {
        const sealed = await encryptCredential(await decryptCredential<unknown>(row.encrypted_data, row.iv));
        if (sealed.iv !== APP_SEALED_IV) throw new Error('not sealed with the app key');
        // includes-deleted: the same row just read, in Trash or not.
        const { data: changed, error: updateError } = await service.from('project_credentials').update(sealed)
          .eq('id', row.id).eq('encrypted_data', row.encrypted_data).select('id');
        if (updateError) throw updateError;
        if (changed?.length) moved.credentials += 1;
      } catch {
        failed.credentials.push(row.id);
      }
    }
  }

  return { moved, failed, status: await encryptionStatus(service) };
}
