'use client';

import { useState, useEffect, useRef } from 'react';
import {
  ShieldCheck,
  Plus,
  Eye,
  EyeOff,
  Pencil,
  Trash2,
  Copy,
  Check,
  Loader2,
  Code,
  Terminal,
  Database,
  CreditCard,
  Landmark,
  Hash,
  KeyRound,
  RefreshCw,
  Lock,
  User as UserIcon,
  Users,
} from 'lucide-react';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  CREDENTIAL_FIELDS,
  isSensitiveKey,
  credentialFieldLabel,
  type CredentialFieldDef,
} from '@/lib/credential-fields';
import {
  CREDENTIAL_CATEGORIES,
  type CredentialCategory,
  type CredentialPayload,
  type ProjectCredentialListItem,
} from '@/lib/types';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Bone, EmptyCard, NoMatches, RailCard, Skeleton, SubNav, TabToolbar, ToolbarButton } from '@/components/projects/TabLayout';
import { hasPermission } from '@/lib/access-control';

interface CredentialsPanelProps {
  projectId: string;
}

// ── Category config ─────────────────────────────────
type CategoryStyle = {
  label: string;
  icon: typeof KeyRound;
  bg: string;
  text: string;
  iconColor: string;
};

const CATEGORY_CONFIG: Record<CredentialCategory, CategoryStyle> = {
  login: {
    label: 'Login',
    icon: KeyRound,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
  api_key: {
    label: 'API Key',
    icon: Code,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
  ssh_key: {
    label: 'SSH Key',
    icon: Terminal,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
  database: {
    label: 'Database',
    icon: Database,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
  credit_card: {
    label: 'Credit Card',
    icon: CreditCard,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
  ach: {
    label: 'ACH / Bank',
    icon: Landmark,
    bg: 'bg-white/[0.06]',
    text: 'text-zinc-300',
    iconColor: 'text-zinc-400',
  },
};

// Rows created before the category consolidation migration may still carry a
// legacy category (hosting, cms, ftp, dns, email, other)
const LEGACY_CATEGORY_STYLE: CategoryStyle = {
  label: 'Other',
  icon: Hash,
  bg: 'bg-white/[0.06]',
  text: 'text-zinc-300',
  iconColor: 'text-zinc-500',
};

function categoryConfig(category: string): CategoryStyle {
  return (
    CATEGORY_CONFIG[category as CredentialCategory] ?? {
      ...LEGACY_CATEGORY_STYLE,
      label: category.charAt(0).toUpperCase() + category.slice(1),
    }
  );
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
function RevealedField({
  label,
  value,
  isSensitive,
}: {
  label: string;
  value: string;
  isSensitive?: boolean;
}) {
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
      <span className="text-xs font-medium text-zinc-500 w-20 flex-shrink-0">{label}</span>
      <Tooltip content={`Click to copy ${label.toLowerCase()}`}>
        <span
          onClick={handleCopyValue}
          className={`flex-1 text-sm font-mono break-all cursor-pointer transition-colors ${isMasked ? 'tracking-widest text-zinc-500 hover:text-zinc-300' : 'text-zinc-300 hover:text-brand-300 active:text-brand-300'} ${copied ? '!text-brand-500' : ''}`}
        >
          {isMasked ? '••••••••' : value}
        </span>
      </Tooltip>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isSensitive && (
          <Tooltip content={visible ? 'Hide' : 'Show'}>
            <button
              onClick={() => setVisible((v) => !v)}
              className="p-1 text-zinc-500 hover:text-brand-300 transition-colors"
            >
              {visible ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </Tooltip>
        )}
        <Tooltip content={`Copy ${label.toLowerCase()}`}>
          <button
            onClick={handleCopyValue}
            className="p-1 text-zinc-500 hover:text-brand-300 transition-colors"
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
  const {
    addCredential,
    updateCredential,
    deleteCredential,
    revealCredential,
    getCredentialsByProject,
    team,
    getProject,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const canManageCredentials = hasPermission(access, 'credentials.manage');
  const projectMemberIds = new Set(getProject(projectId)?.member_ids || []);
  const shareableMembers = team.filter(
    (member) =>
      member.id !== teamMemberId && member.role !== 'owner' && projectMemberIds.has(member.id),
  );
  const categoryOrder = Object.keys(CATEGORY_CONFIG) as CredentialCategory[];
  const credentials = [...getCredentialsByProject(projectId)].sort((a, b) => {
    const catDiff = categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category);
    if (catDiff !== 0) return catDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Encryption status
  const [encryptionStatus, setEncryptionStatus] = useState<
    'loading' | 'configured' | 'not_configured'
  >('loading');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | CredentialCategory>('all');
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

  const setField = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));

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
      .then((res) => res.json())
      .then((data) => setEncryptionStatus(data.configured ? 'configured' : 'not_configured'))
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
        toast(
          'error',
          "Key not detected. Make sure you've restarted your dev server after adding the env var.",
        );
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
      setRevealedData((prev) => {
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
      setRevealedData((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setRevealingId(id);
    const payload = await revealCredential(id);
    if (payload) {
      setRevealedData((prev) => ({ ...prev, [id]: payload }));
    }
    setRevealingId(null);
  };

  const executeDelete = () => {
    if (deleteTarget) {
      deleteCredential(deleteTarget);
      setRevealedData((prev) => {
        const next = { ...prev };
        delete next[deleteTarget];
        return next;
      });
      toast('success', 'Credential moved to Trash');
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
      const response = await fetch('/api/workspace/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_id: shareTarget.id, member_ids: [...shareMemberIds] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to update credential access');
      shareTarget.shared_member_ids = [...shareMemberIds];
      setShareTarget(null);
      toast('success', 'Credential access updated');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to update credential access');
    } finally {
      setSharing(false);
    }
  };

  // ── Loading state ───────────────────────────
  // The toolbar and a group of tiles, the shape of what loads.
  if (encryptionStatus === 'loading') {
    return (
      <Skeleton label="Loading credentials">
        <div className="flex items-center gap-3 mb-5">
          <Bone className="h-9 flex-1 sm:flex-initial sm:w-64 rounded-lg" />
          <Bone className="h-9 w-9 sm:w-36 ml-auto rounded-lg" />
        </div>
        <Bone className="h-2.5 w-16 mb-3" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass-card rounded-xl p-4 flex items-center gap-3">
              <Bone className="w-9 h-9 rounded-lg flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Bone className={`h-3.5 ${i % 2 ? 'w-2/3' : 'w-1/2'}`} />
                <Bone className="h-2.5 w-20" />
              </div>
            </div>
          ))}
        </div>
      </Skeleton>
    );
  }

  // ── Encryption setup ────────────────────────
  if (encryptionStatus === 'not_configured') {
    if (!canManageCredentials) {
      return (
        <RailCard title="Credentials unavailable" icon={<Lock size={16} className="text-zinc-400" aria-hidden="true" />}>
          <p className="text-sm text-zinc-400">
            Credential encryption has not been configured by an authorized manager.
          </p>
        </RailCard>
      );
    }
    return (
      <RailCard title="Set up credential encryption" icon={<Lock size={16} className="text-zinc-400" aria-hidden="true" />}>
        <div className="space-y-4">
          <div className="text-sm text-zinc-300 leading-relaxed">
            Generate an encryption key and add it to your{' '}
            <code className="px-1.5 py-0.5 bg-white/[0.06] rounded text-xs font-mono text-zinc-300">
              .env.local
            </code>{' '}
            file. This key encrypts all stored credentials with AES-256-GCM. Keep it safe ; if lost,
            stored credentials cannot be recovered.
          </div>

          {!generatedKey ? (
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              icon={generating ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}
            >
              Generate Encryption Key
            </Button>
          ) : (
            <div className="space-y-3">
              {/* Key display */}
              <div className="relative">
                <div className="flex items-center gap-2 px-3 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg">
                  <code className="flex-1 text-xs font-mono text-zinc-300 break-all select-all leading-relaxed">
                    PROJECT_CREDENTIALS_ENCRYPTION_KEY={generatedKey}
                  </code>
                  <Tooltip content="Copy">
                    <button
                      onClick={handleCopyKey}
                      className="flex-shrink-0 p-1.5 text-zinc-500 hover:text-brand-300 transition-colors"
                    >
                      {keyCopied ? (
                        <Check size={14} className="text-emerald-500" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Instructions */}
              <div className="text-xs text-zinc-400 space-y-1.5">
                <p className="font-medium text-zinc-300">Next steps:</p>
                <ol className="list-decimal list-inside space-y-1 pl-1">
                  <li>Copy the line above</li>
                  <li>
                    Paste it into your{' '}
                    <code className="px-1 py-0.5 bg-white/[0.06] rounded font-mono">
                      .env.local
                    </code>{' '}
                    file
                  </li>
                  <li>Restart your dev server</li>
                  <li>Click &quot;Verify Setup&quot; below</li>
                </ol>
              </div>

              {/* Verify button */}
              <Button
                type="button"
                onClick={handleVerify}
                disabled={verifying}
                icon={verifying ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              >
                Verify Setup
              </Button>
            </div>
          )}
        </div>
      </RailCard>
    );
  }

  // ── Credential Manager ──────────────────────
  const renderFieldInput = (def: CredentialFieldDef, mode: 'add' | 'edit') => {
    const value = fields[def.key] ?? '';
    const placeholder =
      mode === 'edit' && def.sensitive
        ? `${def.label} (leave blank to keep current)`
        : def.placeholder;
    if (def.options) {
      return (
        <Select
          value={value}
          onChange={(v) => setField(def.key, v)}
          options={def.options.map((o) => ({ value: o, label: o }))}
          placeholder={def.placeholder}
          size="sm"
        />
      );
    }
    if (def.multiline) {
      return (
        <Textarea
          value={value}
          onChange={(v) => setField(def.key, v)}
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
          onChange={(v) => setField(def.key, v)}
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
        onChange={(v) => setField(def.key, v)}
        placeholder={def.placeholder}
        autoComplete="off"
        size="sm"
      />
    );
  };

  const renderForm = (mode: 'add' | 'edit') => {
    const defs = fieldsForCategory(category);
    return (
      <div
        className="space-y-3"
      >
        {/* Type selector; each type has its own set of fields. Edit renders
            inside a narrow card, so drop to two columns there. */}
        <div className={`grid gap-1.5 ${mode === 'add' ? 'grid-cols-3 lg:grid-cols-6' : 'grid-cols-2 sm:grid-cols-3'}`}>
          {CREDENTIAL_CATEGORIES.map((cat) => {
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
                    ? 'border-brand-400 bg-surface-raised text-white shadow-sm ring-1 ring-brand-500/30'
                    : 'border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:border-white/[0.12] hover:text-zinc-300'
                }`}
              >
                <TypeIcon size={13} className={selected ? cfg.iconColor : 'text-zinc-500'} />
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
          {defs.map((def) => (
            <div key={def.key} className={def.half ? 'col-span-1' : 'col-span-2'}>
              {renderFieldInput(def, mode)}
            </div>
          ))}
        </div>

        <Textarea
          value={fields.notes ?? ''}
          onChange={(v) => setField('notes', v)}
          placeholder="Notes (optional)"
          rows={2}
          size="sm"
        />

        <div className="flex items-center gap-2 justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={mode === 'add' ? handleAdd : handleSaveEdit}
            disabled={!label.trim() || saving}
            icon={saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined}
          >
            {mode === 'add' ? 'Save' : 'Update'}
          </Button>
        </div>
      </div>
    );
  };

  const openAddForm = () => {
    editTargetRef.current = null;
    resetForm();
    setEditingId(null);
    setEditLoading(false);
    setIsAdding(true);
  };

  const presentCategories = [...new Set(credentials.map((c) => c.category))];
  const query = search.trim().toLowerCase();
  const visibleCredentials = credentials.filter((c) =>
    (categoryFilter === 'all' || c.category === categoryFilter) &&
    (!query || c.label.toLowerCase().includes(query) || categoryConfig(c.category).label.toLowerCase().includes(query)));
  // Already sorted by category, so grouping keeps the category order.
  const groups: { category: CredentialCategory; items: typeof credentials }[] = [];
  for (const cred of visibleCredentials) {
    const last = groups[groups.length - 1];
    if (last && last.category === cred.category) last.items.push(cred);
    else groups.push({ category: cred.category, items: [cred] });
  }

  const renderCard = (cred: (typeof credentials)[number]) => {
    const config = categoryConfig(cred.category);
    const CategoryIcon = config.icon;
    const isRevealed = !!revealedData[cred.id];
    const isRevealing = revealingId === cred.id;

    if (editingId === cred.id) {
      return (
        <li key={cred.id} className="sm:col-span-2 min-w-0">
          <RailCard
            title={`Edit ${cred.label}`}
            icon={<CategoryIcon size={16} className="text-zinc-400" aria-hidden="true" />}
            className="border border-brand-500/30"
          >
            {editLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 size={18} className="animate-spin text-zinc-600" aria-hidden="true" />
              </div>
            ) : (
              renderForm('edit')
            )}
          </RailCard>
        </li>
      );
    }

    return (
      <li
        key={cred.id}
        className="group relative glass-card rounded-xl hover:border-white/[0.14] transition-colors cursor-pointer min-w-0"
        onClick={() => handleReveal(cred.id)}
      >
        <div className="p-4 min-w-0">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${config.bg}`}>
              {isRevealing ? (
                <Loader2 size={16} className={`animate-spin ${config.iconColor}`} aria-hidden="true" />
              ) : (
                <CategoryIcon size={16} className={config.iconColor} aria-hidden="true" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {/* The name is the reveal control for keyboard users. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleReveal(cred.id);
                }}
                aria-expanded={isRevealed}
                className="block max-w-full text-left text-sm font-semibold text-white truncate rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {cred.label}
              </button>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                {cred.submitted_by_client && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-teal-500/15 text-teal-300">
                    <UserIcon size={9} aria-hidden="true" />
                    {cred.submitted_by_name || 'Client'}
                  </span>
                )}
                <span className="text-xs text-zinc-500">
                  {isRevealed ? 'Click to hide' : `Added ${timeAgo(cred.created_at)}`}
                </span>
              </div>
            </div>
            {canManageCredentials && (
              // Floats over the card's corner so it never narrows the name.
              <div
                className="absolute top-2.5 right-2.5 flex items-center gap-0.5 rounded-lg bg-surface-raised/95 shadow-sm ring-1 ring-white/[0.08] p-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity"
                onClick={(e) => e.stopPropagation()}
              >
                <Tooltip content="Share with team">
                  <button
                    type="button"
                    aria-label={`Share ${cred.label} with team`}
                    onClick={() => openSharing(cred)}
                    className="p-1.5 text-zinc-500 hover:text-brand-300 transition-colors rounded-md hover:bg-white/[0.06]"
                  >
                    <Users size={14} />
                  </button>
                </Tooltip>
                <Tooltip content="Edit">
                  <button
                    type="button"
                    aria-label={`Edit ${cred.label}`}
                    onClick={() => handleStartEdit(cred)}
                    className="p-1.5 text-zinc-500 hover:text-brand-300 transition-colors rounded-md hover:bg-white/[0.06]"
                  >
                    <Pencil size={14} />
                  </button>
                </Tooltip>
                <Tooltip content="Delete">
                  <button
                    type="button"
                    aria-label={`Delete ${cred.label}`}
                    onClick={() => setDeleteTarget(cred.id)}
                    className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors rounded-md hover:bg-white/[0.06]"
                  >
                    <Trash2 size={14} />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {/* Revealed data: field order follows the category's definitions;
              legacy keys from older rows render after */}
          {isRevealed &&
            revealedData[cred.id] &&
            (() => {
              const payload = revealedData[cred.id];
              const defs = fieldsForCategory(cred.category);
              const defKeys = new Set(defs.map((d) => d.key));
              const extraKeys = Object.keys(payload).filter(
                (k) => k !== 'notes' && !defKeys.has(k) && payload[k],
              );
              const hasAnyValue = Object.values(payload).some(Boolean);
              return (
                <div
                  className="mt-3 px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] rounded-lg space-y-0.5 overflow-hidden cursor-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  {defs.map((def) => (
                    <RevealedField
                      key={def.key}
                      label={def.label}
                      value={payload[def.key] ?? ''}
                      isSensitive={def.sensitive}
                    />
                  ))}
                  {extraKeys.map((key) => (
                    <RevealedField
                      key={key}
                      label={credentialFieldLabel(cred.category, key)}
                      value={payload[key]}
                      isSensitive={isSensitiveKey(key)}
                    />
                  ))}
                  <RevealedField label="Notes" value={payload.notes ?? ''} />
                  {!hasAnyValue && <p className="text-xs text-zinc-500 italic">No fields stored</p>}
                </div>
              );
            })()}
        </div>
      </li>
    );
  };

  return (
    <>
      <TabToolbar
        search={credentials.length > 0 ? { value: search, onChange: setSearch, placeholder: 'Search credentials' } : undefined}
        filters={
          presentCategories.length > 1 && (
            <SubNav
              label="Show credentials"
              active={categoryFilter}
              onChange={setCategoryFilter}
              items={[
                { key: 'all', label: 'All', count: credentials.length },
                ...presentCategories.map((cat) => ({
                  key: cat,
                  label: categoryConfig(cat).label,
                  count: credentials.filter((c) => c.category === cat).length,
                })),
              ]}
            />
          )
        }
        primary={
          canManageCredentials && (
            <ToolbarButton icon={<Plus />} label="Add credential" onClick={openAddForm} />
          )
        }
      />

      {canManageCredentials && isAdding && !editingId && (
        <RailCard
          title="New credential"
          icon={<KeyRound size={16} className="text-zinc-400" aria-hidden="true" />}
          className="border border-brand-500/30 mb-6"
        >
          <div className="max-w-3xl">{renderForm('add')}</div>
        </RailCard>
      )}

      {credentials.length === 0 ? (
        !isAdding && (
          <EmptyCard
            icon={<ShieldCheck />}
            title="No credentials stored yet"
            description="Client logins, API keys, cards and bank details, encrypted and revealed on click."
          />
        )
      ) : groups.length === 0 ? (
        <div className="glass-card rounded-xl"><NoMatches>No credentials match.</NoMatches></div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.category} aria-label={categoryConfig(group.category).label}>
              <SectionHeader label={categoryConfig(group.category).label} count={group.items.length} />
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
                {group.items.map(renderCard)}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Move credential to Trash?"
        message="The credential goes to Trash."
        variant="danger"
        trash
      />
      <Modal
        isOpen={Boolean(shareTarget)}
        onClose={() => setShareTarget(null)}
        title="Share credential"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            Choose assigned project members who can reveal{' '}
            <span className="font-medium text-white">{shareTarget?.label}</span>.
          </p>
          <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06] max-h-64 overflow-y-auto">
            {shareableMembers.map((member) => (
              <Checkbox
                key={member.id}
                checked={shareMemberIds.has(member.id)}
                onChange={(checked) =>
                  setShareMemberIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(member.id);
                    else next.delete(member.id);
                    return next;
                  })
                }
                label={
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="text-zinc-100">{member.name}</span>
                    <span className="text-xs font-normal capitalize text-zinc-500">
                      {member.role}
                    </span>
                  </span>
                }
                className="w-full px-3 py-2.5"
              />
            ))}
            {shareableMembers.length === 0 && (
              <p className="px-3 py-4 text-sm text-zinc-400">
                Assign another team member to this project before sharing credentials.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShareTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveSharing} disabled={sharing}>
              {sharing ? 'Saving...' : 'Save access'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
