'use client';

import { useState } from 'react';
import { Ban, KeyRound, Loader2, Pencil, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables } from '@/lib/query-cache';
import { activeKeys, endedKeys, keyState } from '@/lib/agent-profile';
import { REPLACE_OVERLAP_HOURS, liveKeyOf } from '@/lib/agent-access-ui';
import { AGENT_KEYS_WHO, keyExpiry, keyPauseAction } from '@/lib/developers-settings';
import { workspaceApi, type AgentDetail, type AgentKeyView } from '@/lib/agent-workspace';
import { appLocale } from '@/lib/region';
import { formatAgo, formatInZone } from '@/lib/time-format';
import type { ApiKey } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { UndoLine } from '@/components/ui/UndoLine';
import { SecretOnce } from '@/components/agent/ConnectPanel';
import { NewApiKeyDialog } from '@/components/settings/NewApiKeyDialog';
import { DEMO_NOTICE } from '@/components/agent/profile/LimitsPanel';

/**
 * An agent's keys on its Access tab: each with when it was last used (or a
 * Never used flag), and one menu: Edit name, Pause or Resume (with Undo in
 * place), Replace key (one click: a new secret with the same name and
 * powers, shown once; the old one keeps working for an hour so the host
 * swaps it in), Revoke (one confirm). What a key may do is not edited here:
 * the agent's one list ("What it may do") sets it on every key. New key asks
 * "This agent already has a key. Replace it instead?" when a live key exists.
 * Keys are hashed: an existing secret is never shown again.
 */

/** mint: make and replace keys; edit: rename; revoke; pause: pause and resume (the server's rules). */
export interface KeyPowers { mint: boolean; edit: boolean; revoke: boolean; pause: boolean }

const formatEnd = (iso: string) => formatInZone(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function asApiKey(key: AgentKeyView, agentId: string): ApiKey {
  return {
    id: key.id, name: key.name, key_prefix: key.prefix, permissions: 'scoped', scopes: key.scopes, expires_at: key.expires_at ?? null,
    disabled_at: key.disabled_at ?? null, paused_at: key.paused_at ?? null, last_used_at: key.last_used_at ?? null, revoked_at: key.revoked_at ?? null,
    created_by: null, team_member_id: agentId, created_at: key.created_at ?? '', updated_at: key.created_at ?? '',
  };
}

export function AgentKeysCard({ detail, powers, suspended, held }: {
  detail: AgentDetail;
  powers: KeyPowers;
  suspended: boolean;
  /** What a new key starts on: the agent's one list. */
  held: string[];
}) {
  const { isDemoMode } = useDemo();
  const { rotateApiKey, updateApiKey } = useApp();
  const [now] = useState(() => Date.now());
  const [making, setMaking] = useState(false);
  const [askReplace, setAskReplace] = useState(false);
  const [revoking, setRevoking] = useState<AgentKeyView | null>(null);
  const [renaming, setRenaming] = useState<AgentKeyView | null>(null);
  const [replaced, setReplaced] = useState<{ name: string; secret: string; oldEnds: string } | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [pausedHere, setPausedHere] = useState<{ id: string; name: string } | null>(null);
  const [pausing, setPausing] = useState(false);
  const agentId = detail.agent.id;
  const name = detail.agent.name;
  const person = detail.agent.delegate_of ? detail.person ?? null : null;
  const all = detail.keys ?? [];
  const working = activeKeys(all, now);
  const listed = [...working, ...endedKeys(all, now)];
  const demoStops = () => { if (isDemoMode) toast('info', DEMO_NOTICE); return isDemoMode; };
  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' });

  const replace = async (key: AgentKeyView) => {
    if (demoStops()) return;
    setReplacing(key.id);
    try {
      const { secret } = await rotateApiKey(key.id, REPLACE_OVERLAP_HOURS);
      setReplaced({ name: key.name, secret, oldEnds: formatEnd(new Date(Date.now() + REPLACE_OVERLAP_HOURS * 3_600_000).toISOString()) });
      invalidateTables(['api_keys']);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not replace the key');
    } finally {
      setReplacing(null);
    }
  };

  const revoke = async (key: AgentKeyView) => {
    if (demoStops()) return;
    try {
      await workspaceApi(`/api/workspace/agents/${agentId}/keys/${key.id}/revoke`, { method: 'POST' });
      invalidateTables(['api_keys']);
      toast('success', `${key.name} revoked`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not revoke it');
    }
  };

  const setPaused = async (key: AgentKeyView, paused: boolean, fromUndo = false) => {
    if (demoStops()) return;
    setPausing(true);
    try {
      await workspaceApi(`/api/workspace/api-keys/${encodeURIComponent(key.id)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
      invalidateTables(['api_keys']);
      if (paused) setPausedHere({ id: key.id, name: key.name });
      else {
        setPausedHere(null);
        if (!fromUndo) toast('success', `${key.name} works again`);
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change the key');
    } finally {
      setPausing(false);
    }
  };

  const newKey = () => {
    if (demoStops()) return;
    // A live key already: replacing it keeps one secret per host (keys are hashed, never shown again).
    if (liveKeyOf(all.map((key) => ({ ...key, key_prefix: key.prefix })), now)) setAskReplace(true);
    else setMaking(true);
  };

  const actionsFor = (key: AgentKeyView): RowAction[] => {
    const state = keyState(key, now);
    const pauseAction = keyPauseAction(asApiKey(key, agentId), new Date(now));
    return [
      ...(powers.edit && (state === 'active' || state === 'disabled')
        ? [{ label: 'Edit name', icon: <Pencil size={14} aria-hidden="true" />, onClick: () => { if (!demoStops()) setRenaming(key); } }]
        : []),
      ...(powers.pause && pauseAction === 'pause' ? [{ label: 'Pause', icon: <PauseCircle size={14} aria-hidden="true" />, onClick: () => void setPaused(key, true) }] : []),
      ...(powers.pause && pauseAction === 'resume' ? [{ label: 'Resume', icon: <PlayCircle size={14} aria-hidden="true" />, onClick: () => void setPaused(key, false) }] : []),
      ...(powers.mint && state === 'active' && !key.paused_at
        ? [{ label: 'Replace key', icon: <RefreshCw size={14} aria-hidden="true" />, onClick: () => void replace(key) }]
        : []),
      ...(powers.revoke && state !== 'revoked' ? [{ label: 'Revoke', icon: <Ban size={14} aria-hidden="true" />, onClick: () => setRevoking(key), variant: 'danger' as const, divider: true }] : []),
    ];
  };

  const firstLive = working[0] ?? null;

  return (
    <Card
      title="Keys"
      icon={<KeyRound />}
      id="access-keys"
      description={person ? `${person.name || 'Its person'} makes its keys on Your assistant.` : 'How its host signs in. Each key does what "What it may do" allows.'}
      action={powers.mint ? <Button size="sm" variant="secondary" icon={<KeyRound size={13} aria-hidden="true" />} onClick={newKey}>New key</Button> : undefined}
      bodyClassName="pb-1"
    >
      {detail.keys === undefined ? (
        <p className="px-4 pb-4 text-sm text-zinc-400 lg:px-5">{AGENT_KEYS_WHO} Ask one of them to make, replace or pause {name}&apos;s keys.</p>
      ) : listed.length === 0 ? (
        <EmptyState
          compact
          icon={<KeyRound />}
          title="No key yet"
          description={suspended ? `Reactivate ${name} to make a key.` : powers.mint ? `Make one to connect ${name}.` : person ? undefined : 'A workspace Owner can make one.'}
          action={powers.mint && !suspended ? <Button size="sm" icon={<KeyRound size={13} aria-hidden="true" />} onClick={newKey}>New key</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          {listed.map((key) => {
            const state = keyState(key, now);
            const expiry = keyExpiry(key.expires_at ?? null, new Date(now), formatDate);
            const actions = actionsFor(key);
            const live = state === 'active';
            return (
              <li key={key.id} className="flex items-start gap-3 px-4 py-3 lg:px-5">
                <KeyRound size={15} className={`mt-0.5 flex-shrink-0 ${live ? 'text-zinc-400' : 'text-zinc-600'}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <p className={`min-w-0 truncate text-sm font-medium ${live ? 'text-white' : 'text-zinc-400'}`}>{key.name}</p>
                    {!live && <Pill tone="neutral">{state === 'disabled' ? 'Switched off' : 'Ended'}</Pill>}
                    {live && key.paused_at && <Pill tone="waiting" dot>Paused</Pill>}
                    {live && !key.last_used_at && <Pill tone="waiting">Never used</Pill>}
                  </div>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-zinc-500">
                    <span className="font-mono">{key.prefix}</span>
                    {key.last_used_at && <span>Last used {formatAgo(key.last_used_at, { midSentence: true })}</span>}
                    {live && <span>{expiry.label === 'No expiry' ? 'No end date' : expiry.label}</span>}
                  </p>
                  {replacing === key.id && <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-zinc-400"><Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Replacing</p>}
                  {pausedHere?.id === key.id && key.paused_at && (
                    <UndoLine className="mt-2" busy={pausing} onUndo={() => void setPaused(key, false, true)}>Paused {pausedHere.name}.</UndoLine>
                  )}
                </div>
                {actions.length > 0 && <RowActionsMenu actions={actions} label={`Actions for ${key.name}`} />}
              </li>
            );
          })}
        </ul>
      )}

      {powers.mint && (
        <NewApiKeyDialog isOpen={making} onClose={() => { setMaking(false); invalidateTables(['api_keys']); }} agent={{ id: agentId, name, scopes: detail.key_scopes_available }} preset={{ name: `${name} key`, scopes: held }} />
      )}

      {/* Already has a key: replacing keeps one secret per host. A short decision, so a small dialog. */}
      <Modal
        isOpen={askReplace}
        onClose={() => setAskReplace(false)}
        title="Replace its key?"
        size="sm"
        primaryAction={{ label: 'Replace key', onClick: () => { setAskReplace(false); if (firstLive) void replace(firstLive); } }}
      >
        <p className="text-sm text-zinc-300">{name} already has a key. The new one keeps its name and powers, and the old one works for another hour.</p>
        <Button className="mt-3" size="sm" variant="ghost" onClick={() => { setAskReplace(false); setMaking(true); }}>Make another key instead</Button>
      </Modal>

      {/* The copy-once moment: only Done closes it. */}
      <Modal isOpen={!!replaced} onClose={() => undefined} title="Key replaced" size="md">
        {replaced && (
          <div className="space-y-4">
            <SecretOnce
              secret={{ secret: replaced.secret }}
              heading="Copy the new key now. You won't see it again."
              hint={`Put it where ${name}'s host keeps its key. The old one keeps working until ${replaced.oldEnds}, then stops.`}
            />
            <div className="flex justify-end"><Button onClick={() => setReplaced(null)}>Done</Button></div>
          </div>
        )}
      </Modal>

      <RenameKeyDialog
        apiKey={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (next) => {
          if (!renaming) return;
          await updateApiKey(renaming.id, { name: next });
          invalidateTables(['api_keys']);
          toast('success', 'Key renamed');
        }}
      />

      <ConfirmDialog
        isOpen={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => { if (revoking) void revoke(revoking); setRevoking(null); }}
        title="Revoke this key?"
        message={`${revoking?.name ?? 'The key'} stops working at once and cannot be brought back. Make a new key to reconnect ${name}.`}
        confirmLabel="Revoke"
        variant="danger"
      />
    </Card>
  );
}

function RenameKeyDialog({ apiKey, onClose, onSave }: { apiKey: AgentKeyView | null; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  return (
    <Modal isOpen={!!apiKey} onClose={onClose} title="Edit key name" size="sm" primaryAction={{ label: 'Save name', form: 'rename-agent-key-form' }}>
      {apiKey && <RenameForm key={apiKey.id} initial={apiKey.name} onClose={onClose} onSave={onSave} />}
    </Modal>
  );
}

function RenameForm({ initial, onClose, onSave }: { initial: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (!trimmed) { setError('Give the key a name.'); return; }
    if (trimmed === initial) { onClose(); return; }
    setBusy(true);
    try {
      await onSave(trimmed);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename the key');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form id="rename-agent-key-form" onSubmit={submit} noValidate className="space-y-4" aria-busy={busy || undefined}>
      <TextInput label="Name" value={value} onChange={(next) => { setValue(next); if (error) setError(''); }} error={error || undefined} maxLength={100} autoFocus placeholder="Atlas on the build server" />
    </form>
  );
}
