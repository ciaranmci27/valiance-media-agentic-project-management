'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Ban, BookOpen, Check, Copy, Key, Pencil, Plus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { ApiScopePicker } from '@/components/settings/ApiScopePicker';
import { EditApiKeyModal } from '@/components/settings/EditApiKeyModal';
import { apiScopesFor, canEditApiKey } from '@/lib/access-control';
import type { ApiKey } from '@/lib/types';

const formatRelativeTime = (dateStr: string | null) => {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/**
 * Personal API keys: generate (shown once), edit name and scopes, revoke.
 * Every active member can create keys from their Owner-approved API scopes.
 */
export function ApiKeysSection() {
  const { team, apiKeys, addApiKey, revokeApiKey } = useApp();
  const { teamMemberId, access } = useAuth();

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null);

  const handleGenerateKey = async () => {
    if (!keyName.trim()) {
      toast('error', 'Please enter a name for this key');
      return;
    }

    setGeneratingKey(true);
    try {
      const secret = await addApiKey(keyName.trim(), keyScopes);
      if (secret) {
        setRevealedKey(secret);
        setKeyName('');
        setKeyScopes([]);
        setShowKeyForm(false);
      }
    } catch {
      toast('error', 'Failed to generate API key');
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleCopyKey = () => {
    if (!revealedKey) return;
    navigator.clipboard.writeText(revealedKey);
    setCopiedKey(true);
    toast('success', 'API key copied to clipboard');
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleRevokeKey = () => {
    if (!revokeTarget) return;
    revokeApiKey(revokeTarget.id);
    toast('success', 'API key revoked');
    setRevokeTarget(null);
  };

  const activeKeys = apiKeys.filter((k) => !k.revoked_at);
  const revokedKeys = apiKeys.filter((k) => k.revoked_at);

  return (
    <>
      <section id="api-keys" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-violet-500/15 rounded-lg">
              <Key className="text-violet-400" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-white">API Keys</h2>
              <p className="text-sm text-zinc-400 hidden sm:block">
                Manage keys for external integrations
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/api/docs">
              <Button size="sm" variant="secondary" icon={<BookOpen size={14} />}>
                Docs
              </Button>
            </Link>
            {!showKeyForm && !revealedKey && (
              <Button size="sm" onClick={() => setShowKeyForm(true)} icon={<Plus size={14} />}>
                <span className="sm:hidden">New</span>
                <span className="hidden sm:inline">Generate New Key</span>
              </Button>
            )}
          </div>
        </div>

        {/* One-time key display */}
        {revealedKey && (
          <div className="mb-6 p-4 bg-emerald-500/15 border border-emerald-500/30 rounded-lg space-y-3">
            <div className="flex items-center gap-2">
              <Check size={16} className="text-emerald-400" />
              <p className="text-sm font-medium text-emerald-300">
                API key generated successfully
              </p>
            </div>
            <p className="text-xs text-emerald-300">
              Copy this key now. It will only be shown once and cannot be retrieved later.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-surface-raised border border-emerald-500/30 rounded-lg text-sm font-mono text-zinc-100 break-all select-all">
                {revealedKey}
              </code>
              <button
                onClick={handleCopyKey}
                className="p-2 text-emerald-400 hover:bg-emerald-500/15 rounded-lg transition-colors flex-shrink-0"
              >
                {copiedKey ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setRevealedKey(null)}>
              Done
            </Button>
          </div>
        )}

        {/* Generate key form */}
        {showKeyForm && (
          <div className="mb-6 p-4 bg-white/[0.03] border border-white/[0.08] rounded-lg space-y-3">
            <h4 className="text-sm font-medium text-white">New API Key</h4>
            <Input
              label="Name"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder='e.g. "Zapier Integration"'
            />
            <ApiScopePicker
              available={apiScopesFor(access)}
              selected={keyScopes}
              onChange={setKeyScopes}
              hint="Choose only what this integration needs. Available scopes are controlled by the Owner."
            />
            <div className="flex gap-2">
              <Button
                onClick={handleGenerateKey}
                disabled={generatingKey || !keyName.trim() || keyScopes.length === 0}
              >
                {generatingKey ? 'Generating...' : 'Generate'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setShowKeyForm(false);
                  setKeyName('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Keys table */}
        {activeKeys.length > 0 && (
          <div className="max-h-[28rem] overflow-y-auto border border-white/[0.08] rounded-lg divide-y divide-white/[0.06]">
            {activeKeys.map((key) => (
              <div key={key.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-white truncate">{key.name}</p>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-brand-500/15 text-brand-300">
                        {key.scopes?.length || 0} {(key.scopes?.length || 0) === 1 ? 'scope' : 'scopes'}
                      </span>
                    </div>
                    <code className="text-xs text-zinc-400 font-mono mt-0.5 block">
                      {key.key_prefix}...****
                    </code>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-zinc-400">
                        Last used: {formatRelativeTime(key.last_used_at)}
                      </span>
                      {key.team_member_id &&
                        (() => {
                          const linked = team.find((m) => m.id === key.team_member_id);
                          return linked ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400">
                              {linked.name}
                            </span>
                          ) : null;
                        })()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {canEditApiKey(access, teamMemberId, key) && (
                      <Tooltip content="Edit key">
                        <button
                          type="button"
                          onClick={() => setEditTarget(key)}
                          aria-label={`Edit ${key.name}`}
                          className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/[0.06] rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Revoke key">
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(key)}
                        aria-label={`Revoke ${key.name}`}
                        className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/15 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        <Ban size={14} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeKeys.length === 0 && !showKeyForm && !revealedKey && (
          <div className="text-center py-6 text-zinc-400">
            <Key className="mx-auto mb-2" size={24} />
            <p className="text-sm">No API keys yet</p>
            <p className="text-xs mt-1">Generate a key to enable external integrations</p>
          </div>
        )}

        {/* Revoked keys */}
        {revokedKeys.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">
              Revoked
            </p>
            <div
              role="region"
              tabIndex={0}
              aria-label="Revoked API keys"
              className="max-h-60 overflow-y-auto border border-white/[0.06] rounded-lg divide-y divide-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              {revokedKeys.map((key) => (
                <div key={key.id} className="flex items-center gap-3 px-4 py-2.5 opacity-50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-400 line-through">{key.name}</p>
                    <code className="text-xs text-zinc-400 font-mono">
                      {key.key_prefix}...****
                    </code>
                  </div>
                  <span className="text-xs text-red-400">Revoked</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

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
        title="Revoke API Key"
        message={`This will permanently revoke "${revokeTarget?.name}". Any integrations using this key will stop working immediately.`}
        confirmLabel="Revoke"
        variant="danger"
      />
    </>
  );
}
