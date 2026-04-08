'use client';

import { useState, useEffect } from 'react';
import {
  ShieldCheck, Plus, Eye, EyeOff, Pencil, Trash2, X, Copy, Check,
  Loader2, Key, Code, Terminal, Database, Server, Globe,
  HardDrive, Network, Mail, Hash, KeyRound, RefreshCw, Lock,
  User as UserIcon,
} from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import type { CredentialCategory, CredentialPayload, ProjectCredentialListItem } from '@/lib/types';

interface CredentialsPanelProps {
  projectId: string;
}

// ── Category config ─────────────────────────────────
const CATEGORY_CONFIG: Record<CredentialCategory, { label: string; icon: typeof Key; bg: string; text: string; iconColor: string }> = {
  login:    { label: 'Login',    icon: Key,       bg: 'bg-violet-50',  text: 'text-violet-700',  iconColor: 'text-violet-500' },
  api_key:  { label: 'API Key',  icon: Code,      bg: 'bg-blue-50',    text: 'text-blue-700',    iconColor: 'text-blue-500' },
  ssh_key:  { label: 'SSH Key',  icon: Terminal,   bg: 'bg-emerald-50', text: 'text-emerald-700', iconColor: 'text-emerald-500' },
  database: { label: 'Database', icon: Database,   bg: 'bg-amber-50',   text: 'text-amber-700',   iconColor: 'text-amber-500' },
  hosting:  { label: 'Hosting',  icon: Server,     bg: 'bg-rose-50',    text: 'text-rose-700',    iconColor: 'text-rose-500' },
  cms:      { label: 'CMS',      icon: Globe,      bg: 'bg-cyan-50',    text: 'text-cyan-700',    iconColor: 'text-cyan-500' },
  ftp:      { label: 'FTP',      icon: HardDrive,  bg: 'bg-orange-50',  text: 'text-orange-700',  iconColor: 'text-orange-500' },
  dns:      { label: 'DNS',      icon: Network,    bg: 'bg-indigo-50',  text: 'text-indigo-700',  iconColor: 'text-indigo-500' },
  email:    { label: 'Email',    icon: Mail,       bg: 'bg-pink-50',    text: 'text-pink-700',    iconColor: 'text-pink-500' },
  other:    { label: 'Other',    icon: Hash,       bg: 'bg-zinc-100',   text: 'text-zinc-600',    iconColor: 'text-zinc-400' },
};

const CATEGORY_OPTIONS = Object.entries(CATEGORY_CONFIG).map(([value, cfg]) => ({
  value,
  label: cfg.label,
}));

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
  const { addCredential, updateCredential, deleteCredential, revealCredential, getCredentialsByProject } = useApp();
  const { teamMemberId } = useAuth();
  const credentials = getCredentialsByProject(projectId);

  // Encryption status
  const [encryptionStatus, setEncryptionStatus] = useState<'loading' | 'configured' | 'not_configured'>('loading');
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // UI state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [revealedData, setRevealedData] = useState<Record<string, CredentialPayload>>({});
  const [revealingId, setRevealingId] = useState<string | null>(null);

  // Form state
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

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
    setUsername('');
    setPassword('');
    setUrl('');
    setNotes('');
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
    await addCredential(projectId, {
      label: label.trim(),
      category,
      username: username.trim(),
      password: password.trim(),
      url: url.trim(),
      notes: notes.trim(),
    });
    resetForm();
    setIsAdding(false);
    setSaving(false);
    toast('success', 'Credential saved');
  };

  const handleStartEdit = async (cred: ProjectCredentialListItem) => {
    setEditingId(cred.id);
    setLabel(cred.label);
    setCategory(cred.category);
    // Load existing secret fields
    const payload = revealedData[cred.id] || await revealCredential(cred.id);
    if (payload) {
      setUsername(payload.username);
      setPassword(payload.password);
      setUrl(payload.url);
      setNotes(payload.notes);
      setRevealedData(prev => ({ ...prev, [cred.id]: payload }));
    } else {
      // Reveal failed — reset secrets to prevent saving empty strings over real data
      setUsername('');
      setPassword('');
      setUrl('');
      setNotes('');
      setEditingId(null);
      resetForm();
      toast('error', 'Could not load credential data for editing');
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId || !label.trim()) return;
    setSaving(true);
    await updateCredential(editingId, {
      label: label.trim(),
      category,
      username: username.trim(),
      url: url.trim(),
      notes: notes.trim(),
    });
    // Clear revealed data for this credential since it was re-encrypted
    setRevealedData(prev => {
      const next = { ...prev };
      delete next[editingId];
      return next;
    });
    resetForm();
    setEditingId(null);
    setSaving(false);
    toast('success', 'Credential updated');
  };

  const handleCancel = () => {
    resetForm();
    setEditingId(null);
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
  const renderForm = (mode: 'add' | 'edit') => (
    <div className={mode === 'add' ? 'border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3' : 'space-y-3'}>
      <div className="flex gap-2">
        <TextInput
          autoFocus
          value={label}
          onChange={setLabel}
          placeholder="Name (i.e. Email Login)"
          size="sm"
        />
        <div className="w-[130px] flex-shrink-0">
          <Select
            value={category}
            onChange={v => setCategory(v)}
            options={CATEGORY_OPTIONS}
            size="sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextInput
          value={username}
          onChange={setUsername}
          placeholder="Username"
          autoComplete="off"
          size="sm"
        />
        {mode === 'edit' ? (
          <TextInput
            value=""
            disabled
            placeholder="••••••••"
            rightIcon={Lock}
            size="sm"
          />
        ) : (
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="Password / Secret"
            autoComplete="new-password"
            size="sm"
            showIcon={false}
          />
        )}
      </div>
      <TextInput
        value={url}
        onChange={setUrl}
        placeholder="URL (optional)"
        type="url"
        size="sm"
      />
      <Textarea
        value={notes}
        onChange={setNotes}
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
        <button
          onClick={() => { resetForm(); setIsAdding(true); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
        >
          <Plus size={14} />
          Add
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Add form */}
        {isAdding && !editingId && (
          <div className="mx-5 mt-5">
            {renderForm('add')}
          </div>
        )}

        {/* Credentials grid */}
        {credentials.length > 0 ? (
          <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {credentials.map(cred => {
              const config = CATEGORY_CONFIG[cred.category];
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
                    <div className={`h-1 ${config.bg}`} />
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
                      {renderForm('edit')}
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
                  {/* Category accent bar */}
                  <div className={`h-1 ${config.bg}`} />

                  <div className="p-4 min-w-0">
                    {/* Header */}
                    <div className="flex items-start gap-3 mb-3">
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
                        </div>
                      </div>
                    </div>

                    {/* Revealed data */}
                    {isRevealed && revealedData[cred.id] && (
                      <div className="mb-3 px-3 py-2.5 bg-zinc-50 border border-zinc-100 rounded-lg space-y-0.5 overflow-hidden" onClick={e => e.stopPropagation()}>
                        <RevealedField label="Username" value={revealedData[cred.id].username} />
                        <RevealedField label="Password" value={revealedData[cred.id].password} isSensitive />
                        <RevealedField label="URL" value={revealedData[cred.id].url} />
                        <RevealedField label="Notes" value={revealedData[cred.id].notes} />
                        {!revealedData[cred.id].username && !revealedData[cred.id].password && !revealedData[cred.id].url && !revealedData[cred.id].notes && (
                          <p className="text-xs text-zinc-400 italic">No fields stored</p>
                        )}
                      </div>
                    )}

                    {/* Footer: time + actions */}
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-zinc-400">{timeAgo(cred.created_at)}</p>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
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
                      </div>
                    </div>
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
    </div>
  );
}
