'use client';

import { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck, Plus, Eye, EyeOff, Pencil, Trash2, Copy, Check,
  Loader2, Code, Terminal, Database, CreditCard, Landmark, Hash,
  KeyRound, RefreshCw, Lock, User as UserIcon,
  Users,
} from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { CREDENTIAL_FIELDS, isSensitiveKey, credentialFieldLabel, type CredentialFieldDef } from '@/lib/credential-fields';
import { CREDENTIAL_CATEGORIES, type CredentialCategory, type CredentialPayload, type ProjectCredentialListItem } from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { hasPermission } from '@/lib/access-control';

interface CredentialsPanelProps {
  projectId: string;
}

// ── Category config ─────────────────────────────────
type CategoryStyle = { label: string; icon: typeof KeyRound; bg: string; text: string; iconColor: string };

const CATEGORY_CONFIG: Record<CredentialCategory, CategoryStyle> = {
  login:       { label: 'Login',       icon: KeyRound,   bg: 'bg-violet-50',  text: 'text-violet-700',  iconColor: 'text-violet-500' },
  api_key:     { label: 'API Key',     icon: Code,       bg: 'bg-blue-50',    text: 'text-blue-700',    iconColor: 'text-blue-500' },
  ssh_key:     { label: 'SSH Key',     icon: Terminal,   bg: 'bg-emerald-50', text: 'text-emerald-700', iconColor: 'text-emerald-500' },
  database:    { label: 'Database',    icon: Database,   bg: 'bg-amber-50',   text: 'text-amber-700',   iconColor: 'text-amber-500' },
  credit_card: { label: 'Credit Card', icon: CreditCard, bg: 'bg-rose-50',    text: 'text-rose-700',    iconColor: 'text-rose-500' },
  ach:         { label: 'ACH / Bank',  icon: Landmark,   bg: 'bg-teal-50',    text: 'text-teal-700',    iconColor: 'text-teal-500' },
};

// Rows created before the category consolidation migration may still carry a
// legacy category (hosting, cms, ftp, dns, email, other)
const LEGACY_CATEGORY_STYLE: CategoryStyle = { label: 'Other', icon: Hash, bg: 'bg-zinc-100', text: 'text-zinc-600', iconColor: 'text-zinc-400' };

function categoryConfig(category: string): CategoryStyle {
  return CATEGORY_CONFIG[category as CredentialCategory]
    ?? { ...LEGACY_CATEGORY_STYLE, label: category.charAt(0).toUpperCase() + category.slice(1) };
}

function fieldsForCategory(category: string): CredentialFieldDef[] {
  // Legacy categories were all username/password/url shaped
  return CREDENTIAL_FIELDS[category as CredentialCategory] ?? CREDENTIAL_FIELDS.login;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Revealed field row ──────────────────────────────
function RevealedField({ label, value, isSensitive }: { label: string; value: string; isSensitive?: boolean }) {
  const [visible, setVisible] = useState(!isSensitive);
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const handleCopyValue = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast('success', `${label} copied`);
    setTimeout(() => setCopied(false), 1500);
  };

  const isMasked = isSensitive && !visible;

  return (
    <div className="flex items-center gap-2 py-1 min-w-0">
      <span className="text-xs font-medium text-zinc-400 w-20 flex-shrink-0">{label}</span>
      <Tooltip content={`Click to copy ${label.toLowerCase()}`}>
        <span
          onClick={handleCopyValue}
          className={`flex-1 text-sm font-mono break-all cursor-pointer transition-colors ${isMasked ? 'tracking-widest text-zinc-400 hover:text-zinc-600' : 'text-zinc-700 hover:text-brand-600 active:text-brand-700'} ${copied ? '!text-brand-500' : ''}`}
        >
          {isMasked ? '••••••••' : value}
        </span>
      </Tooltip>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isSensitive && (
          <Tooltip content={visible ? 'Hide' : 'Show'}>
            <button
              onClick={() => setVisible(v => !v)}
              className="p-1 text-zinc-400 hover:text-brand-600 transition-colors"
            >
              {visible ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={`Copy ${label.toLowerCase()}`}>
          <button
            onClick={handleCopyValue}
            className="p-1 text-zinc-400 hover:text-brand-600 transition-colors"
          >
            {copied ? <Check size={13} className="text-brand-500" /> : <Copy size={13} />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────
export function CredentialsPanel({ projectId }: CredentialsPanelProps) {
  const { addCredential, updateCredential, deleteCredential, revealCredential, getCredentialsByProject, team, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const canManageCredentials = hasPermission(access, 'credentials.manage');
  const projectMemberIds = new Set(getProject(projectId)?.member_ids || []);
  const shareableMembers = team.filter((member) => member.id !== teamMemberId && member.role !== 'owner' && projectMemberIds.has(member.id));
  const categoryOrder = Object.keys(CATEGORY_CONFIG) as CredentialCategory[];
  const credentials = [...getCredentialsByProject(projectId)].sort((a, b) => {
    const catDiff = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Encryption status
  const [encryptionStatus, setEncryptionStatus] = useState<'loading' | 'configured' | 'not_configured'>('loading');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [revealedData, setRevealedData] = useState<Record<string, CredentialPayload>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ProjectCredentialListItem | null>(null);
  const [shareMemberIds, setShareMemberIds] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  // Which credential the in-flight edit reveal belongs to; a late response
  // for a different credential must never populate the open form
  const editTargetRef = useRef<string | null>(null);

  // Form state: field values are keyed by the active category's field defs
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>('login');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const setField = (key: string, value: string) =>
    setFields(prev => ({ ...prev, [key]: value }));

  // Only submit values belonging to the active category (plus notes), so
  // leftovers from switching type mid-form never get saved. In edit mode,
  // blank sensitive fields are omitted so the stored secrets are preserved.
  const collectFields = (mode: 'add' | 'edit'): Record<string, string> => {
    const collected: Record<string, string> = {};
    for (const def of fieldsForCategory(category)) {
      const value = (fields[def.key] ?? '').trim();
      if (mode === 'edit' && def.sensitive && !value) continue;
      collected[def.key] = value;
    }
    collected.notes = (fields.notes ?? '').trim();
    return collected;
  };

  // Check encryption on mount
  useEffect(() => {
    fetch('/api/encryption/status')
      .then(res => res.json())
      .then(data => setEncryptionStatus(data.configured ? 'configured' : 'not_configured'))
      .catch(() => setEncryptionStatus('not_configured'));
  }, []);

  const resetForm = () => {
    setLabel('');
    setCategory('login');
    setFields({});
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/encryption/generate-key', { method: 'POST' });
      const data = await res.json();
      setGeneratedKey(data.key);
    } catch {
      toast('error', 'Failed to generate key');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyKey = async () => {
    await navigator.clipboard.writeText(`PROJECT_CREDENTIALS_ENCRYPTION_KEY=${generatedKey}`);
    setKeyCopied(true);
    toast('success', 'Copied to clipboard');
    setTimeout(() => setKeyCopied(false), 3000);
  };

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/encryption/status');
      const data = await res.json();
      if (data.configured) {
        setEncryptionStatus('configured');
        toast('success', 'Encryption configured successfully');
      } else {
        toast('error', 'Key not detected. Make sure you\'ve restarted your dev server after adding the env var.');
      }
    } catch {
      toast('error', 'Failed to verify');
    } finally {
      setVerifying(false);
    }
  };

  const handleAdd = async () => {
    if (!label.trim()) return;
    setSaving(true);
    const created = await addCredential(projectId, {
      label: label.trim(),
      category,
      fields: collectFields('add'),
    });
    setSaving(false);
    // On failure the form stays open so nothing the admin typed is lost
    if (created) {
      resetForm();
      setIsAdding(false);
      toast('success', 'Credential saved');
    }
  };

  const handleStartEdit = async (cred: ProjectCredentialListItem) => {
    setIsAdding(false);
    setEditingId(cred.id);
    setEditLoading(true);
    setLabel(cred.label);
    setCategory(cred.category);
    setFields({});
    editTargetRef.current = cred.id;

    // Always fetch fresh values; a cached reveal could be minutes old and
    // saving it back would silently revert concurrent changes
    const payload = await revealCredential(cred.id);
    if (editTargetRef.current !== cred.id) return; // user moved on mid-flight

    if (payload) {
      // Pre-fill only non-sensitive values. Secrets stay blank; blank means
      // "keep the current value" on save (matches the portal's semantics)
      const prefill: Record<string, string> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (!isSensitiveKey(key)) prefill[key] = value;
      }
      setFields(prefill);
      setEditLoading(false);
    } else {
      // Reveal failed; bail out to prevent saving empty strings over real data
      setEditingId(null);
      setEditLoading(false);
      resetForm();
      toast('error', 'Could not load credential data for editing');
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId || !label.trim() || editLoading) return;
    setSaving(true);
    // Rows still on a pre-migration category keep it unless the admin picks
    // one of the current types (the schema only accepts current categories)
    const categoryIsCurrent = (CREDENTIAL_CATEGORIES as readonly string[]).includes(category);
    const ok = await updateCredential(editingId, {
      label: label.trim(),
      ...(categoryIsCurrent ? { category } : {}),
      fields: collectFields('edit'),
    });
    setSaving(false);
    if (ok) {
      // Clear revealed data for this credential since it was re-encrypted
      const savedId = editingId;
      setRevealedData(prev => {
        const next = { ...prev };
        delete next[savedId];
        return next;
      });
      resetForm();
      setEditingId(null);
      toast('success', 'Credential updated');
    }
  };

  const handleCancel = () => {
    editTargetRef.current = null;
    resetForm();
    setEditingId(null);
    setEditLoading(false);
    setIsAdding(false);
  };

  const handleReveal = async (id: string) => {
    if (revealedData[id]) {
      // Toggle off
      setRevealedData(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setRevealingId(id);
    const payload = await revealCredential(id);
    if (payload) {
      setRevealedData(prev => ({ ...prev, [id]: payload }));
    }
    setRevealingId(null);
  };

  const executeDelete = () => {
    if (deleteTarget) {
      deleteCredential(deleteTarget);
      setRevealedData(prev => {
        const next = { ...prev };
        delete next[deleteTarget];
        return next;
      });
      toast('success', 'Credential deleted');
    }
  };

  const openSharing = (credential: ProjectCredentialListItem) => {
    setShareTarget(credential);
    setShareMemberIds(new Set(credential.shared_member_ids || []));
  };

  const saveSharing = async () => {
    if (!shareTarget) return;
    setSharing(true);
    try {
      const response = await fetch('/api/workspace/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential_id: shareTarget.id, member_ids: [...shareMemberIds] }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to update credential access');
      shareTarget.shared_member_ids = [...shareMemberIds];
      setShareTarget(null);
      toast('success', 'Credential access updated');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Failed to update credential access'); }
    finally { setSharing(false); }
  };

  // ── Loading state ───────────────────────────
  if (encryptionStatus === 'loading') {
    return (
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        <div className="px-5 py-4 flex items-center gap-2">
          <ShieldCheck size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">Credentials</h2>
        </div>
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-zinc-300" />
        </div>
      </div>
    );
  }

  // ── Encryption setup ────────────────────────
  if (encryptionStatus === 'not_configured') {
    if (!canManageCredentials) {
      return (
        <div className="bg-white rounded-xl border border-zinc-200 p-5">
          <div className="flex items-center gap-2"><Lock size={18} className="text-zinc-500" /><h2 className="font-semibold text-zinc-900">Credentials unavailable</h2></div>
          <p className="mt-2 text-sm text-zinc-500">Credential encryption has not been configured by an authorized manager.</p>
        </div>
      );
    }
    return (
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-100 flex items-center gap-2">
          <Lock size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">Set Up Credential Encryption</h2>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-sm text-zinc-600 leading-relaxed">
            Generate an encryption key and add it to your <code className="px-1.5 py-0.5 bg-zinc-100 rounded text-xs font-mono text-zinc-700">.env.local</code> file.
            This key encrypts all stored credentials with AES-256-GCM. Keep it safe — if lost, stored credentials cannot be recovered.
          </div>

          {!generatedKey ? (
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              Generate Encryption Key
            </button>
          ) : (
            <div className="space-y-3">
              {/* Key display */}
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2.5 bg-zinc-50 border border-zinc-200 rounded-lg">
                  <code className="flex-1 text-xs font-mono text-zinc-700 break-all select-all leading-relaxed">
                    PROJECT_CREDENTIALS_ENCRYPTION_KEY={generatedKey}
                  </code>
                  <Tooltip content="Copy">
                    <button
                      onClick={handleCopyKey}
                      className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-brand-600 transition-colors"
                    >
                      {keyCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Instructions */}
              <div className="text-xs text-zinc-500 space-y-1.5">
                <p className="font-medium text-zinc-600">Next steps:</p>
                <ol className="list-decimal list-inside space-y-1 pl-1">
                  <li>Copy the line above</li>
                  <li>Paste it into your <code className="px-1 py-0.5 bg-zinc-100 rounded font-mono">.env.local</code> file</li>
                  <li>Restart your dev server</li>
                  <li>Click &quot;Verify Setup&quot; below</li>
                </ol>
              </div>

              {/* Verify button */}
              <button
                onClick={handleVerify}
                disabled={verifying}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Verify Setup
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Credential Manager ──────────────────────
  const renderFieldInput = (def: CredentialFieldDef, mode: 'add' | 'edit') => {
    const value = fields[def.key] ?? '';
    const placeholder = mode === 'edit' && def.sensitive
      ? `${def.label} (leave blank to keep current)`
      : def.placeholder;
    if (def.options) {
      return (
        <Select
          value={value}
          onChange={v => setField(def.key, v)}
          options={def.options.map(o => ({ value: o, label: o }))}
          placeholder={def.placeholder}
          size="sm"
        />
      );
    }
    if (def.multiline) {
      return (
        <Textarea
          value={value}
          onChange={v => setField(def.key, v)}
          placeholder={placeholder}
          rows={3}
          size="sm"
        />
      );
    }
    if (def.sensitive) {
      return (
        <PasswordInput
          value={value}
          onChange={v => setField(def.key, v)}
          placeholder={placeholder}
          autoComplete="new-password"
          size="sm"
          showIcon={false}
        />
      );
    }
    return (
      <TextInput
        value={value}
        onChange={v => setField(def.key, v)}
        placeholder={def.placeholder}
        autoComplete="off"
        size="sm"
      />
    );
  };

  const renderForm = (mode: 'add' | 'edit') => {
    const defs = fieldsForCategory(category);
    return (
      <div className={mode === 'add' ? 'border border-brand-200 bg-brand-50/30 rounded-xl p-4 space-y-3' : 'space-y-3'}>
        {/* Type selector; each type has its own set of fields. Edit renders
            inside a narrow card, so drop to two columns there. */}
        <div className={`grid gap-1.5 ${mode === 'add' ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {CREDENTIAL_CATEGORIES.map(cat => {
            const cfg = CATEGORY_CONFIG[cat];
            const TypeIcon = cfg.icon;
            const selected = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                aria-pressed={selected}
                className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs font-medium transition-all ${
                  selected
                    ? 'border-brand-400 bg-white text-zinc-900 shadow-sm ring-1 ring-brand-200'
                    : 'border-zinc-200 bg-white/60 text-zinc-500 hover:border-zinc-300 hover:text-zinc-700'
                }`}
              >
                <TypeIcon size={13} className={selected ? cfg.iconColor : 'text-zinc-400'} />
                <span className="truncate">{cfg.label}</span>
              </button>
            );
          })}
        </div>

        <TextInput
          autoFocus={mode === 'add'}
          value={label}
          onChange={setLabel}
          placeholder={`Name (e.g. ${category === 'credit_card' ? 'Company Amex' : category === 'ach' ? 'Operating Account' : 'Email Login'})`}
          size="sm"
        />

        {/* Type-specific fields; half-width fields pair up in a 2-col grid */}
        <div className="grid grid-cols-2 gap-2">
          {defs.map(def => (
            <div key={def.key} className={def.half ? 'col-span-1' : 'col-span-2'}>
              {renderFieldInput(def, mode)}
            </div>
          ))}
        </div>

        <Textarea
          value={fields.notes ?? ''}
          onChange={v => setField('notes', v)}
          placeholder="Notes (optional)"
          rows={2}
          size="sm"
        />

        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={mode === 'add' ? handleAdd : handleSaveEdit}
            disabled={!label.trim() || saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {mode === 'add' ? 'Save' : 'Update'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between flex-shrink-0 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">
            Credentials
            {credentials.length > 0 && (
              <span className="ml-1.5 text-xs font-medium text-zinc-400">({credentials.length})</span>
            )}
          </h2>
        </div>
        {canManageCredentials && <button
          onClick={() => {
            editTargetRef.current = null;
            resetForm();
            setEditingId(null);
            setEditLoading(false);
            setIsAdding(true);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          <Plus size={14} />
          Add
        </button>}
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Add form */}
        {canManageCredentials && isAdding && !editingId && (
          <div className="mx-5 mt-5">
            {renderForm('add')}
          </div>
        )}

        {/* Credentials grid */}
        {credentials.length > 0 ? (
          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {credentials.map(cred => {
              const config = categoryConfig(cred.category);
              const CategoryIcon = config.icon;
              const isEditing = editingId === cred.id;
              const isRevealed = !!revealedData[cred.id];
              const isRevealing = revealingId === cred.id;

              if (isEditing) {
                return (
                  <div
                    key={cred.id}
                    className="relative rounded-xl border border-brand-200 bg-white overflow-hidden"
                  >
                    <div className="p-4">
                      {/* Card header — matches normal cards */}
                      <div className="flex items-start gap-3 mb-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${config.bg}`}>
                          <CategoryIcon size={16} className={config.iconColor} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-zinc-400">Editing</p>
                          <p className="text-sm font-semibold text-zinc-900 truncate">{cred.label}</p>
                        </div>
                      </div>
                      {editLoading ? (
                        <div className="flex items-center justify-center py-10">
                          <Loader2 size={18} className="animate-spin text-zinc-300" />
                        </div>
                      ) : (
                        renderForm('edit')
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={cred.id}
                  className="group relative rounded-xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm transition-all overflow-hidden cursor-pointer min-w-0"
                  onClick={() => handleReveal(cred.id)}
                >
                  <div className="p-4 min-w-0">
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${config.bg}`}>
                        {isRevealing ? (
                          <Loader2 size={16} className={`animate-spin ${config.iconColor}`} />
                        ) : (
                          <CategoryIcon size={16} className={config.iconColor} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-zinc-900 truncate">{cred.label}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded ${config.bg} ${config.text}`}>
                            {config.label}
                          </span>
                          {cred.submitted_by_client && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-teal-50 text-teal-700">
                              <UserIcon size={9} />
                              {cred.submitted_by_name || 'Client'}
                            </span>
                          )}
                          <span className="text-[10px] text-zinc-400">{timeAgo(cred.created_at)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 flex-shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        {canManageCredentials && <Tooltip content="Share with team">
                          <button onClick={() => openSharing(cred)} className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50"><Users size={14} /></button>
                        </Tooltip>}
                        {canManageCredentials && <>
                        <Tooltip content="Edit">
                          <button
                            onClick={() => handleStartEdit(cred)}
                            className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors rounded-md hover:bg-zinc-50"
                          >
                            <Pencil size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Delete">
                          <button
                            onClick={() => setDeleteTarget(cred.id)}
                            className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors rounded-md hover:bg-zinc-50"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                        </>}
                      </div>
                    </div>

                    {/* Revealed data: field order follows the category's
                        definitions; legacy keys from older rows render after */}
                    {isRevealed && revealedData[cred.id] && (() => {
                      const payload = revealedData[cred.id];
                      const defs = fieldsForCategory(cred.category);
                      const defKeys = new Set(defs.map(d => d.key));
                      const extraKeys = Object.keys(payload).filter(k => k !== 'notes' && !defKeys.has(k) && payload[k]);
                      const hasAnyValue = Object.values(payload).some(Boolean);
                      return (
                        <div className="mb-3 px-3 py-2.5 bg-zinc-50 border border-zinc-100 rounded-lg space-y-0.5 overflow-hidden" onClick={e => e.stopPropagation()}>
                          {defs.map(def => (
                            <RevealedField
                              key={def.key}
                              label={def.label}
                              value={payload[def.key] ?? ''}
                              isSensitive={def.sensitive}
                            />
                          ))}
                          {extraKeys.map(key => (
                            <RevealedField
                              key={key}
                              label={credentialFieldLabel(cred.category, key)}
                              value={payload[key]}
                              isSensitive={isSensitiveKey(key)}
                            />
                          ))}
                          <RevealedField label="Notes" value={payload.notes ?? ''} />
                          {!hasAnyValue && (
                            <p className="text-xs text-zinc-400 italic">No fields stored</p>
                          )}
                        </div>
                      );
                    })()}

                  </div>
                </div>
              );
            })}
          </div>
        ) : !isAdding ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <ShieldCheck size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No credentials stored yet</p>
            <p className="text-xs text-zinc-400 mt-1">Add client logins, API keys, and other credentials</p>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Credential"
        message="Are you sure you want to delete this credential? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
      <Modal isOpen={Boolean(shareTarget)} onClose={() => setShareTarget(null)} title="Share credential" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-zinc-600">Choose assigned project members who can reveal <span className="font-medium text-zinc-900">{shareTarget?.label}</span>.</p>
          <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-100 max-h-64 overflow-y-auto">
            {shareableMembers.map((member) => (
              <Checkbox
                key={member.id}
                checked={shareMemberIds.has(member.id)}
                onChange={(checked) => setShareMemberIds((current) => {
                  const next = new Set(current);
                  if (checked) next.add(member.id);
                  else next.delete(member.id);
                  return next;
                })}
                label={<span className="flex w-full items-center justify-between gap-3"><span className="text-zinc-800">{member.name}</span><span className="text-xs font-normal capitalize text-zinc-400">{member.role}</span></span>}
                className="w-full px-3 py-2.5"
              />
            ))}
            {shareableMembers.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">Assign another team member to this project before sharing credentials.</p>}
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setShareTarget(null)}>Cancel</Button><Button onClick={saveSharing} disabled={sharing}>{sharing ? 'Saving...' : 'Save access'}</Button></div>
        </div>
      </Modal>
    </div>
  );
}
