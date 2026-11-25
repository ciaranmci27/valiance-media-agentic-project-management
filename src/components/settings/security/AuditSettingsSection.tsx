'use client';

import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { auditSettingsRead } from '@/lib/reads';
import { AUDIT_RETENTION_CHOICES, type AuditSettings } from '@/lib/audit-log';

const FOREVER = 'forever';

/**
 * Settings > Security: how long the audit log keeps rows (a daily job
 * removes older ones; rows the app still needs are kept) and more field
 * names whose values it never stores, beside the built-in secrets, tokens,
 * passwords, keys and authorization.
 */
export function AuditSettingsSection() {
  const read = useRead(auditSettingsRead);
  const settings = read.data;
  const [retention, setRetention] = useState(FOREVER);
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setRetention(settings.retention_days === null ? FOREVER : String(settings.retention_days));
    setKeys(settings.redact_keys.join(', '));
  }, [settings]);

  const parsedKeys = keys.split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  const dirty = !!settings && ((retention === FOREVER ? null : Number(retention)) !== settings.retention_days
    || parsedKeys.join(',') !== settings.redact_keys.join(','));
  const choices = AUDIT_RETENTION_CHOICES.some((c) => String(c.value ?? FOREVER) === retention)
    ? AUDIT_RETENTION_CHOICES
    : [...AUDIT_RETENTION_CHOICES, { value: Number(retention), label: `${retention} days` }];

  const save = async () => {
    setBusy(true);
    try {
      const next = await workspaceApi<AuditSettings>('/api/workspace/audit-settings', {
        method: 'PUT',
        body: { retention_days: retention === FOREVER ? null : Number(retention), redact_keys: parsedKeys },
      });
      setReadData(auditSettingsRead, () => next);
      invalidateTables(['business_settings', 'api_audit_log']);
      toast('success', 'Audit settings saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="audit-settings-heading">
      <SettingsSectionHeader
        icon={Archive}
        headingId="audit-settings-heading"
        title="Keeping the log"
        description="How long the audit log keeps rows, and which fields it never stores. Secrets, tokens, passwords, keys and authorization are always left out."
      />
      {!settings ? (
        <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the settings.' : 'Loading'}</p>
      ) : (
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Select
            label="Keep rows for"
            value={retention}
            onChange={setRetention}
            options={choices.map((c) => ({ value: c.value === null ? FOREVER : String(c.value), label: c.label }))}
            helperText="Older rows are removed once a day."
          />
          <TextInput
            label="More fields to leave out"
            description="Field names, separated by commas."
            placeholder="ssn, iban"
            value={keys}
            onChange={setKeys}
          />
          <div className="flex justify-end gap-2 sm:col-span-2">
            {dirty && (
              <Button variant="ghost" onClick={() => { setRetention(settings.retention_days === null ? FOREVER : String(settings.retention_days)); setKeys(settings.redact_keys.join(', ')); }}>
                Discard
              </Button>
            )}
            <Button onClick={save} disabled={!dirty || busy}>{busy ? 'Saving' : 'Save'}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
