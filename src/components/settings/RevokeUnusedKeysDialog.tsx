'use client';

import { useEffect, useState } from 'react';
import { Ban, KeyRound, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables } from '@/lib/query-cache';
import { workspaceApi } from '@/lib/agent-workspace';
import { UNUSED_KEY_DAYS, unusedKeys, unusedWords } from '@/lib/agent-access-ui';
import type { KeptKeyRow, RevokeUnusedResult, UnusedKeyRow } from '@/lib/api/key-hygiene';
import { formatAgo } from '@/lib/time-format';
import type { ApiKey, TeamMember } from '@/lib/types';
import { DEMO_NOTICE } from '@/components/agent/profile/LimitsPanel';

/**
 * Revoke unused keys: first the preview (keys you manage that were never
 * used, or not used for 90 days), then one confirm that names the count.
 * Only keys still unused when you confirm are revoked. In the demo the
 * preview comes from the demo's keys and nothing is revoked.
 */
export function RevokeUnusedKeysDialog({ isOpen, onClose, demoKeys, team, onRevoked }: {
  isOpen: boolean;
  onClose: () => void;
  /** The demo's keys, for its preview. */
  demoKeys: readonly ApiKey[];
  team: readonly TeamMember[];
  /** The ids revoked, to mark them on the list. */
  onRevoked?: (ids: string[]) => void;
}) {
  const { isDemoMode } = useDemo();
  const [preview, setPreview] = useState<UnusedKeyRow[] | null>(null);
  const [kept, setKept] = useState<KeptKeyRow[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPreview(null);
    setKept([]);
    setFailed(null);
    if (isDemoMode) {
      const now = Date.now();
      setPreview(unusedKeys(demoKeys, now).map((key) => ({
        id: key.id, name: key.name, key_prefix: key.key_prefix, member_id: key.team_member_id ?? null,
        member_name: team.find((m) => m.id === key.team_member_id)?.name ?? null, last_used_at: key.last_used_at ?? null, created_at: key.created_at, unused: key.unused, takes_down: [],
      })));
      return;
    }
    let live = true;
    workspaceApi<RevokeUnusedResult>('/api/workspace/api-keys/revoke-unused', { method: 'POST', body: { dry_run: true } })
      .then((result) => { if (live) { setPreview(result.keys); setKept(result.kept_keys ?? []); } })
      .catch((error) => { if (live) setFailed(error instanceof Error ? error.message : 'Could not look for unused keys'); });
    return () => { live = false; };
  }, [isOpen, isDemoMode, demoKeys, team]);

  const revoke = async () => {
    if (!preview?.length) return;
    if (isDemoMode) { toast('info', DEMO_NOTICE); onClose(); return; }
    setBusy(true);
    try {
      const result = await workspaceApi<RevokeUnusedResult>('/api/workspace/api-keys/revoke-unused', { method: 'POST', body: { dry_run: false, key_ids: preview.map((key) => key.id) } });
      invalidateTables(['api_keys']);
      onRevoked?.(result.revoked_ids);
      const count = result.revoked_ids.length;
      toast('success', `Revoked ${count} ${count === 1 ? 'key' : 'keys'}${result.skipped_ids.length ? `. ${result.skipped_ids.length} were used just now, so they stay.` : ''}`);
      onClose();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not revoke them');
    } finally {
      setBusy(false);
    }
  };

  const count = preview?.length ?? 0;
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) onClose(); }} title="Revoke unused keys?" size="md">
      <div className="space-y-4">
        <p className="text-sm text-zinc-300">Keys never used, or not used for {UNUSED_KEY_DAYS} days. Revoking stops them for good; anything still using one would need a new key.</p>
        {failed ? (
          <EmptyState variant="error" compact title="Could not look for unused keys" description={failed} />
        ) : !preview ? (
          <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Looking</p>
        ) : count === 0 ? (
          <EmptyState compact icon={<KeyRound />} title={kept.length ? 'Nothing to revoke' : 'No unused keys'} description={kept.length ? 'Each unused key made a key that is still in use.' : `Every key you manage was used in the last ${UNUSED_KEY_DAYS} days.`} />
        ) : (
          <ul aria-label="Keys to revoke" className="max-h-72 divide-y divide-white/[0.06] overflow-y-auto rounded-lg border border-white/[0.08]">
            {preview.map((key) => (
              <li key={key.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{key.name}</p>
                  <p className="truncate text-xs text-zinc-400">
                    {[key.member_name, key.last_used_at ? `Last used ${formatAgo(key.last_used_at, { midSentence: true })}` : `Made ${formatAgo(key.created_at, { midSentence: true })}`].filter(Boolean).join(' · ')}
                  </p>
                  {key.takes_down.length > 0 && (
                    <p className="truncate text-xs text-zinc-400" title={key.takes_down.map((child) => child.name).join(', ')}>
                      Also revokes {key.takes_down.length === 1 ? '1 key it made' : `${key.takes_down.length} keys it made`}: {key.takes_down.map((child) => child.name).join(', ')}
                    </p>
                  )}
                </div>
                <Pill tone="waiting">{unusedWords(key.unused)}</Pill>
              </li>
            ))}
          </ul>
        )}
        {preview && kept.length > 0 && (
          <ul aria-label="Keys that stay" className="space-y-1">
            {kept.map((key) => (
              <li key={key.id} className="text-xs text-zinc-400"><span className="font-medium text-zinc-300">{key.name}</span> stays. {key.why.replace(/^Kept: /, '').replace(/^./, (c) => c.toUpperCase())}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => void revoke()}
            disabled={busy || count === 0}
            icon={busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Ban size={14} aria-hidden="true" />}
          >
            {busy ? 'Revoking' : count ? `Revoke ${count} ${count === 1 ? 'key' : 'keys'}` : 'Revoke'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
