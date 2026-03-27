'use client';

import { useState, useEffect, useCallback } from 'react';
import { Mail, Plus, Copy, Check, Pencil, Trash2, Send, Loader2, RefreshCw, BookOpen } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import type { SmtpAccountSafe } from '@/lib/email/types';

interface AccountStatus {
  online: boolean | null; // null = checking
  reason?: string;
}

export function SmtpSection() {
  const [loading, setLoading] = useState(true);
  const [encryptionConfigured, setEncryptionConfigured] = useState(false);
  const [accounts, setAccounts] = useState<SmtpAccountSafe[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({});

  // Encryption setup state
  const [generatedKey, setGeneratedKey] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [form, setForm] = useState({
    label: '',
    host: '',
    port: 465,
    secure: true,
    username: '',
    password: '',
    from_name: '',
    from_email: '',
    reply_to: '',
    is_default: false,
  });

  // Test email state
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<SmtpAccountSafe | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/smtp');
      if (!res.ok) return;
      const data = await res.json();
      setAccounts(data.accounts || []);
      setEncryptionConfigured(data.encryptionConfigured);
      return data.accounts as SmtpAccountSafe[];
    } catch {
      // silent
    }
  }, []);

  const verifyAccount = useCallback(async (id: string) => {
    setStatuses(s => ({ ...s, [id]: { online: null } }));
    try {
      const res = await fetch('/api/smtp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      setStatuses(s => ({ ...s, [id]: { online: data.online, reason: data.reason } }));
    } catch {
      setStatuses(s => ({ ...s, [id]: { online: false, reason: 'Network error' } }));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const accts = await fetchAccounts();
      setLoading(false);
      if (accts?.length) {
        accts.forEach((a: SmtpAccountSafe) => verifyAccount(a.id));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Encryption setup ───────────────────────────────────────────────────────

  const handleGenerateKey = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/smtp/generate-key', { method: 'POST' });
      const data = await res.json();
      setGeneratedKey(data.key);
    } catch {
      toast('error', 'Failed to generate key');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyKey = () => {
    navigator.clipboard.writeText(`SMTP_ENCRYPTION_KEY=${generatedKey}`);
    setKeyCopied(true);
    toast('success', 'Copied to clipboard');
    setTimeout(() => setKeyCopied(false), 2000);
  };

  const handleVerifySetup = async () => {
    setVerifying(true);
    try {
      const res = await fetch('/api/smtp/status');
      const data = await res.json();
      if (data.configured) {
        setEncryptionConfigured(true);
        toast('success', 'SMTP encryption verified');
      } else {
        toast('error', 'SMTP_ENCRYPTION_KEY not detected. Restart your dev server after adding it to .env.local.');
      }
    } catch {
      toast('error', 'Failed to check status');
    } finally {
      setVerifying(false);
    }
  };

  // ─── Form handlers ─────────────────────────────────────────────────────────

  const resetForm = () => {
    setForm({ label: '', host: '', port: 465, secure: true, username: '', password: '', from_name: '', from_email: '', reply_to: '', is_default: false });
    setShowForm(false);
    setEditingId(null);
  };

  const handleEdit = (account: SmtpAccountSafe) => {
    setForm({
      label: account.label,
      host: account.host,
      port: account.port,
      secure: account.secure,
      username: account.username,
      password: '',
      from_name: account.from_name,
      from_email: account.from_email,
      reply_to: account.reply_to,
      is_default: account.is_default,
    });
    setEditingId(account.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.label || !form.host || !form.username || !form.from_name || !form.from_email) {
      toast('error', 'Please fill in all required fields');
      return;
    }
    if (!editingId && !form.password) {
      toast('error', 'Password is required');
      return;
    }
    if (!form.port || form.port < 1 || form.port > 65535) {
      toast('error', 'Please enter a valid port number');
      return;
    }

    setFormSaving(true);
    try {
      const url = editingId ? `/api/smtp/${editingId}` : '/api/smtp';
      const method = editingId ? 'PUT' : 'POST';
      const body = { ...form };

      // First account is always the default
      if (accounts.length === 0 && !editingId) {
        body.is_default = true;
      }

      // Don't send empty password on edit (means "keep existing")
      if (editingId && !body.password) {
        delete (body as Record<string, unknown>).password;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        toast('error', data.error || 'Failed to save');
        return;
      }

      toast('success', editingId ? 'Account updated' : 'Account created');
      resetForm();
      const accts = await fetchAccounts();
      if (accts?.length) {
        accts.forEach((a: SmtpAccountSafe) => verifyAccount(a.id));
      }
    } catch {
      toast('error', 'Failed to save account');
    } finally {
      setFormSaving(false);
    }
  };

  // ─── Test ───────────────────────────────────────────────────────────────────

  const handleSendTest = async (id: string) => {
    if (!testTo.trim()) {
      toast('error', 'Enter a recipient email');
      return;
    }

    setTestSending(true);
    try {
      const res = await fetch('/api/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, to: testTo.trim() }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        toast('success', 'Test email sent');
        setTestingId(null);
        setTestTo('');
      } else {
        toast('error', data.error || 'Failed to send test');
      }
    } catch {
      toast('error', 'Failed to send test email');
    } finally {
      setTestSending(false);
    }
  };

  // ─── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/smtp/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        toast('error', data.error || 'Failed to delete');
        return;
      }
      toast('success', 'Account deleted');
      setDeleteTarget(null);
      fetchAccounts();
    } catch {
      toast('error', 'Failed to delete account');
    }
  };

  // ─── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-50 rounded-lg">
            <Mail className="text-cyan-600" size={20} />
          </div>
          <div>
            <h2 className="font-semibold text-zinc-900">SMTP Email</h2>
            <p className="text-sm text-zinc-500">Loading...</p>
          </div>
        </div>
        <div className="flex justify-center py-8">
          <Loader2 className="animate-spin text-zinc-400" size={24} />
        </div>
      </section>
    );
  }

  // ─── Encryption not configured ──────────────────────────────────────────────

  if (!encryptionConfigured) {
    return (
      <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-cyan-50 rounded-lg">
            <Mail className="text-cyan-600" size={20} />
          </div>
          <div>
            <h2 className="font-semibold text-zinc-900">Set Up SMTP Encryption</h2>
            <p className="text-sm text-zinc-500">An encryption key is required to securely store SMTP passwords</p>
          </div>
        </div>

        {!generatedKey ? (
          <Button onClick={handleGenerateKey} disabled={generating}>
            {generating ? 'Generating...' : 'Generate Key'}
          </Button>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-zinc-700 mb-2">Add this to your <code className="px-1.5 py-0.5 bg-zinc-100 rounded text-xs">.env.local</code> file:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm font-mono text-zinc-800 break-all select-all">
                  SMTP_ENCRYPTION_KEY={generatedKey}
                </code>
                <button
                  onClick={handleCopyKey}
                  className="p-2 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 rounded-lg transition-colors flex-shrink-0"
                >
                  {keyCopied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            <p className="text-xs text-zinc-500">
              After adding the key, restart your dev server, then click &ldquo;Verify Setup&rdquo; to confirm.
            </p>

            <Button onClick={handleVerifySetup} disabled={verifying}>
              {verifying ? 'Checking...' : 'Verify Setup'}
            </Button>
          </div>
        )}
      </section>
    );
  }

  // ─── Configured — Account management ────────────────────────────────────────

  return (
    <>
      <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-50 rounded-lg">
              <Mail className="text-cyan-600" size={20} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">SMTP Email</h2>
              <p className="text-sm text-zinc-500 hidden sm:block">Manage outgoing email accounts</p>
            </div>
          </div>
          {!showForm && (
            <div className="flex items-center gap-2">
              <Link href="/smtp/docs">
                <Button size="sm" variant="secondary" icon={<BookOpen size={14} />}>
                  Docs
                </Button>
              </Link>
              <Button size="sm" onClick={() => { resetForm(); setShowForm(true); }} icon={<Plus size={14} />}>
                <span className="sm:hidden">Add</span>
                <span className="hidden sm:inline">Add Account</span>
              </Button>
            </div>
          )}
        </div>

        {/* Add / Edit form */}
        {showForm && (
          <div className="mb-6 p-4 bg-zinc-50 border border-zinc-200 rounded-lg space-y-4">
            <h4 className="text-sm font-medium text-zinc-900">
              {editingId ? 'Edit Account' : 'New SMTP Account'}
            </h4>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Row 1: Label | Host */}
              <Input
                label="Account Name"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. No-Reply"
              />
              <Input
                label="Host"
                value={form.host}
                onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                placeholder="e.g. mail.yourdomain.com"
              />

              {/* Row 2: Username | Password */}
              <Input
                label="Username"
                value={form.username}
                onChange={e => {
                  const val = e.target.value;
                  setForm(f => {
                    const updated = { ...f, username: val };
                    if (val.includes('@') && (!f.from_email || f.from_email === f.username)) {
                      updated.from_email = val;
                    }
                    return updated;
                  });
                }}
                placeholder="e.g. noreply@yourdomain.com"
                autoComplete="off"
              />
              <Input
                label={editingId ? 'Password (blank = keep existing)' : 'Password'}
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder={editingId ? '••••••••' : 'SMTP password'}
                autoComplete="new-password"
                style={{ WebkitTextSecurity: form.password ? 'disc' : undefined } as React.CSSProperties}
              />

              {/* Row 3: From Name | From Email */}
              <Input
                label="From Name"
                value={form.from_name}
                onChange={e => setForm(f => ({ ...f, from_name: e.target.value }))}
                placeholder="e.g. Your Company"
              />
              <Input
                label="From Email"
                type="email"
                value={form.from_email}
                onChange={e => setForm(f => ({ ...f, from_email: e.target.value }))}
                placeholder="e.g. noreply@yourdomain.com"
              />

              {/* Row 4: Port | Reply-To */}
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1.5">Port</label>
                <select
                  value={form.port === 465 ? '465' : form.port === 587 ? '587' : 'custom'}
                  onChange={e => {
                    if (e.target.value === 'custom') {
                      setForm(f => ({ ...f, port: 0, secure: false }));
                    } else {
                      const port = parseInt(e.target.value);
                      setForm(f => ({ ...f, port, secure: port === 465 }));
                    }
                  }}
                  className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none transition-all duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                >
                  <option value="465">465 (SSL)</option>
                  <option value="587">587 (STARTTLS)</option>
                  <option value="custom">Custom</option>
                </select>
                {form.port !== 465 && form.port !== 587 && (
                  <input
                    type="number"
                    className="w-full mt-2 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none transition-all duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 placeholder:text-zinc-400"
                    placeholder="Enter custom port"
                    value={form.port || ''}
                    onChange={e => {
                      const port = parseInt(e.target.value) || 0;
                      setForm(f => ({ ...f, port, secure: false }));
                    }}
                    autoFocus
                  />
                )}
              </div>
              <Input
                label="Reply-To (optional)"
                type="email"
                value={form.reply_to}
                onChange={e => setForm(f => ({ ...f, reply_to: e.target.value }))}
                placeholder="e.g. hello@yourdomain.com"
              />

              {/* Row 5: Default toggle */}
              <div className="flex items-center gap-2.5 self-end pb-0.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={accounts.length === 0 && !editingId ? true : form.is_default}
                  onClick={() => setForm(f => ({ ...f, is_default: !f.is_default }))}
                  disabled={accounts.length === 0 && !editingId}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    (accounts.length === 0 && !editingId) || form.is_default ? 'bg-brand-500' : 'bg-zinc-200'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      (accounts.length === 0 && !editingId) || form.is_default ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className="text-sm text-zinc-700">Primary account</span>
              </div>
            </div>

            <div className="flex gap-2 mt-5 pt-4 border-t border-zinc-200">
              <Button onClick={handleSave} disabled={formSaving}>
                {formSaving ? 'Saving...' : editingId ? 'Update Account' : 'Create Account'}
              </Button>
              <Button variant="secondary" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Account list */}
        {accounts.length > 0 ? (
          <div className="border border-zinc-200 rounded-lg divide-y divide-zinc-100">
            {accounts.map(account => {
              const status = statuses[account.id];
              return (
                <div key={account.id}>
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* Status dot */}
                      <Tooltip content={
                        status?.online === null ? 'Checking...' :
                        status?.online ? 'Connected' :
                        status?.reason || 'Offline'
                      }>
                        <div className="flex-shrink-0 mt-1">
                          {status?.online === null ? (
                            <Loader2 className="animate-spin text-zinc-400" size={14} />
                          ) : (
                            <div className={`w-2.5 h-2.5 rounded-full ${
                              status?.online ? 'bg-emerald-500' : 'bg-red-400'
                            }`} />
                          )}
                        </div>
                      </Tooltip>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-zinc-900 truncate">{account.label}</p>
                          {account.is_default && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-brand-50 text-brand-600 flex-shrink-0">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 truncate mt-0.5">{account.from_email}</p>
                        <p className="text-xs text-zinc-400 font-mono truncate mt-0.5">{account.host}:{account.port} ({account.secure ? 'SSL' : 'STARTTLS'})</p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Tooltip content="Refresh status">
                          <button
                            onClick={() => verifyAccount(account.id)}
                            className="p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors"
                          >
                            <RefreshCw size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Send test email">
                          <button
                            onClick={() => {
                              setTestingId(testingId === account.id ? null : account.id);
                              setTestTo('');
                            }}
                            className="p-1.5 text-zinc-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                          >
                            <Send size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Edit account">
                          <button
                            onClick={() => handleEdit(account)}
                            className="p-1.5 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          >
                            <Pencil size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Delete account">
                          <button
                            onClick={() => setDeleteTarget(account)}
                            className="p-1.5 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </div>
                  </div>

                  {/* Inline test email */}
                  {testingId === account.id && (
                    <div className="px-4 pb-3 flex items-center gap-2">
                      <input
                        type="email"
                        value={testTo}
                        onChange={e => setTestTo(e.target.value)}
                        placeholder="Recipient email..."
                        className="flex-1 px-3 py-1.5 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-100"
                        onKeyDown={e => e.key === 'Enter' && handleSendTest(account.id)}
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSendTest(account.id)}
                        disabled={testSending || !testTo.trim()}
                      >
                        {testSending ? 'Sending...' : 'Send'}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : !showForm ? (
          <div className="text-center py-6 text-zinc-500">
            <Mail className="mx-auto mb-2" size={24} />
            <p className="text-sm">No SMTP accounts yet</p>
            <p className="text-xs mt-1">Add an account to enable outgoing email</p>
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete SMTP Account"
        message={`This will permanently delete "${deleteTarget?.label}". Any features using this account for email delivery will stop working.`}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
