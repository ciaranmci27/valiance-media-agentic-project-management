'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Ban, Bot, ChevronDown, KeyRound, Pencil, Plus, RefreshCw } from 'lucide-react';
import { appLocale } from '@/lib/region';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { EditApiKeyModal } from '@/components/settings/EditApiKeyModal';
import { NewApiKeyDialog } from '@/components/settings/NewApiKeyDialog';
import { RotateApiKeyDialog } from '@/components/settings/RotateApiKeyDialog';
import { canEditApiKey, hasPermission, isModuleEnabled } from '@/lib/access-control';
import { agentKeyRow, groupApiKeys, keyExpiry } from '@/lib/developers-settings';
import type { ApiKey } from '@/lib/types';

/** For "Last used ...": never, just now, 5m ago, 3d ago, then the date. */
const formatRelativeTime = (dateStr: string | null) => {
  if (!dateStr) return 'never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return formatDate(dateStr);
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

const EXPIRY_TONES = { muted: 'text-zinc-400', warning: 'text-amber-300', danger: 'text-red-300' } as const;

const LINK = 'rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * Settings > Developers > API keys: the person's own keys, for scripts and
 * tools that call the API as them. New key is a short guided dialog; each
 * key can be edited, rotated (with an overlap) or revoked. An Owner also
 * sees other people's keys. Agent keys are listed with Revoke (so one can be
 * stopped even with the Agents module off) and a link to their agent's
 * profile, where they are made and rotated.
 */
export function ApiKeysSection() {
  const { team, apiKeys, revokeApiKey } = useApp();
  const { teamMemberId, access } = useAuth();
  const agentsOn = isModuleEnabled(access, 'agents');

  const [creating, setCreating] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKey | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const agentIds = useMemo(() => new Set(team.filter((m) => m.role === 'agent').map((m) => m.id)), [team]);
  const { mine, people, agents, ended } = groupApiKeys(apiKeys, teamMemberId, agentIds);
  const memberName = (id: string | null) => (id ? team.find((m) => m.id === id)?.name : null) ?? 'Unknown member';

  const handleRevokeKey = () => {
    if (!revokeTarget) return;
    revokeApiKey(revokeTarget.id);
    toast('success', 'API key revoked');
    setRevokeTarget(null);
  };

  const revokeAction = (key: ApiKey): RowAction => ({ label: 'Revoke', icon: <Ban size={14} aria-hidden="true" />, onClick: () => setRevokeTarget(key), variant: 'danger', divider: true });
  // Agent keys: always listed and revocable; Open Connect only where the profile opens.
  const agentRow = agentKeyRow({ agentsOn, canManageAgents: hasPermission(access, 'agents.manage') });

  const actionsFor = (key: ApiKey, own: boolean): RowAction[] => [
    ...(canEditApiKey(access, teamMemberId, key)
      ? [{ label: 'Edit name and access', icon: <Pencil size={14} aria-hidden="true" />, onClick: () => setEditTarget(key) }]
      : []),
    // Rotating is for your own keys (an agent's rotate on its profile).
    ...(own ? [{ label: 'Rotate', icon: <RefreshCw size={14} aria-hidden="true" />, onClick: () => setRotateTarget(key) }] : []),
    revokeAction(key),
  ];

  return (
    <>
      <section id="api-keys" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6" aria-labelledby="api-keys-heading">
        <SettingsSectionHeader
          icon={KeyRound}
          title="API keys"
          headingId="api-keys-heading"
          description="Your own keys, for scripts and tools that use the API or MCP as you. Each key does only what you tick."
          action={(
            <Button size="sm" onClick={() => setCreating(true)} icon={<Plus size={14} aria-hidden="true" />}>
              New key
            </Button>
          )}
        />

        {mine.length > 0 ? (
          <KeyList label="Your API keys">
            {mine.map((key) => (
              <KeyRow key={key.id} apiKey={key} actions={actionsFor(key, true)} />
            ))}
          </KeyList>
        ) : (
          <div className="rounded-lg bg-white/[0.03] px-4 py-6 text-center">
            <KeyRound className="mx-auto mb-2 text-zinc-400" size={22} aria-hidden="true" />
            <p className="text-sm font-medium text-zinc-200">No keys yet</p>
            <p className="mt-1 text-xs text-zinc-400">Make one to connect a script, a tool or an AI client.</p>
          </div>
        )}

        {people.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-xs font-medium text-zinc-400">Other people&apos;s keys</p>
            <KeyList label="Other people's API keys">
              {people.map((key) => (
                <KeyRow key={key.id} apiKey={key} owner={memberName(key.team_member_id)} actions={actionsFor(key, false)} />
              ))}
            </KeyList>
          </div>
        )}

        {(agents.length > 0 || agentsOn) && (
          <div className="mt-6 rounded-lg bg-white/[0.03] px-3.5 py-3">
            <div className="flex items-start gap-3">
              <Bot size={16} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-sm text-zinc-300">
                {agentsOn ? (
                  <>
                    Agent keys are made and rotated on each agent&apos;s profile, under Connect.{' '}
                    {agentRow.openConnect && <Link href="/agent?tab=agents" className={LINK}>Open agents</Link>}
                  </>
                ) : (
                  'AI agents are switched off. Their keys keep working until you revoke them here.'
                )}
              </p>
            </div>
            {agents.length > 0 && (
              <div className="mt-3">
                <KeyList label="Agent keys">
                  {agents.map((key) => (
                    <KeyRow
                      key={key.id}
                      apiKey={key}
                      owner={memberName(key.team_member_id)}
                      trailing={agentRow.openConnect ? (
                        <Button size="sm" variant="secondary" href={`/agent/${key.team_member_id}?tab=connect`}>
                          Open Connect
                        </Button>
                      ) : undefined}
                      actions={[revokeAction(key)]}
                    />
                  ))}
                </KeyList>
              </div>
            )}
          </div>
        )}

        {ended.length > 0 && (
          <div className="mt-4">
            <Button
              size="sm"
              variant="ghost"
              className="-ml-2.5"
              aria-expanded={showEnded}
              onClick={() => setShowEnded((open) => !open)}
              icon={<ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-200 ${showEnded ? 'rotate-180' : ''}`} />}
            >
              {showEnded ? 'Hide' : 'Show'} {ended.length} revoked or expired
            </Button>
            {showEnded && (
            <div
              role="region"
              tabIndex={0}
              aria-label="Revoked and expired API keys"
              className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-white/[0.06] divide-y divide-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {ended.map((key) => (
                <div key={key.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-400 line-through">{key.name}</p>
                    <code className="font-mono text-xs text-zinc-500">{key.key_prefix}...</code>
                  </div>
                  <span className="flex-shrink-0 text-xs text-zinc-400">
                    {key.revoked_at ? `Revoked ${formatDate(key.revoked_at)}` : `Expired ${formatDate(key.expires_at!)}`}
                  </span>
                </div>
              ))}
            </div>
            )}
          </div>
        )}
      </section>

      <NewApiKeyDialog isOpen={creating} onClose={() => setCreating(false)} />

      <RotateApiKeyDialog apiKey={rotateTarget} onClose={() => setRotateTarget(null)} />

      <EditApiKeyModal
        apiKey={editTarget}
        memberName={
          editTarget && editTarget.team_member_id !== teamMemberId
            ? team.find((m) => m.id === editTarget.team_member_id)?.name ?? 'this member'
            : null
        }
        onClose={() => setEditTarget(null)}
      />

      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevokeKey}
        title="Revoke API key"
        message={`This will permanently revoke "${revokeTarget?.name}". Anything using this key stops working immediately.`}
        confirmLabel="Revoke"
        variant="danger"
      />
    </>
  );
}

/** Rows keep their height; the list scrolls past about seven. */
function KeyList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="max-h-[28rem] overflow-y-auto rounded-lg border border-white/[0.08] divide-y divide-white/[0.06]">
      {children}
    </ul>
  );
}

/** One working key: name, access, prefix, then created, last used and expiry. */
function KeyRow({ apiKey, owner, actions, trailing }: { apiKey: ApiKey; owner?: string; actions?: RowAction[]; trailing?: ReactNode }) {
  const scopeCount = apiKey.scopes?.length ?? 0;
  const expiry = keyExpiry(apiKey.expires_at, new Date(), formatDate);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-medium text-white">{apiKey.name}</p>
          <span className="flex-shrink-0 rounded bg-brand-500/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-300">
            {scopeCount} {scopeCount === 1 ? 'permission' : 'permissions'}
          </span>
          {owner && (
            <span className="flex-shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">{owner}</span>
          )}
        </div>
        <code className="mt-0.5 block font-mono text-xs text-zinc-400">{apiKey.key_prefix}...</code>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
          <span>Created {formatDate(apiKey.created_at)}</span>
          <span>Last used {formatRelativeTime(apiKey.last_used_at)}</span>
          <span className={EXPIRY_TONES[expiry.tone]}>{expiry.label}</span>
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center">
        {trailing}
        {actions && actions.length > 0 && <RowActionsMenu actions={actions} label={`Actions for ${apiKey.name}`} />}
      </div>
    </li>
  );
}
