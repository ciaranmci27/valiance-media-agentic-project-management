'use client';

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ArrowLeft, Code, CreditCard, Database, Eye, EyeOff, KeyRound, Landmark,
  Loader2, Pencil, Plus, Terminal,
} from 'lucide-react';
import type { CredentialCategory, PortalData } from '@/lib/types';
import { CREDENTIAL_FIELDS, type CredentialFieldDef } from '@/lib/credential-fields';
import { Select } from '@/components/ui/Select';
import { Tooltip } from '@/components/ui/Tooltip';
import { toast } from '@/components/ui/Toast';
import { SectionCard, SectionHeader } from './SectionHeader';
import { relativeTime } from './format';

// Each credential type collects its own fields (see lib/credential-fields.ts)
const CREDENTIAL_CATEGORIES: { value: string; label: string; icon: typeof KeyRound }[] = [
  { value: 'login', label: 'Login', icon: KeyRound },
  { value: 'api_key', label: 'API key', icon: Code },
  { value: 'ssh_key', label: 'SSH key', icon: Terminal },
  { value: 'database', label: 'Database', icon: Database },
  { value: 'credit_card', label: 'Credit card', icon: CreditCard },
  { value: 'ach', label: 'ACH / Bank', icon: Landmark },
];

type SubmittedCredential = PortalData['credentials_submitted'][number];

const ICON_TILE = 'vm-tile flex h-10 w-10 shrink-0 items-center justify-center vm-soft';

/* The form is its own view, never mixed with the list. */
function CredentialForm({
  token,
  pin,
  editingCredential,
  onDone,
  onCancel,
}: {
  token: string;
  pin?: string;
  editingCredential: SubmittedCredential | null;
  onDone: (cred: SubmittedCredential, mode: 'add' | 'edit') => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const isEditing = editingCredential !== null;
  const editingId = editingCredential?.id;
  const [label, setLabel] = useState(editingCredential?.label ?? '');
  const [category, setCategory] = useState<string>(editingCredential?.category ?? 'login');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [loadingFields, setLoadingFields] = useState(isEditing);
  // Whether the edit prefill actually loaded; if it failed we must not send
  // blank values for fields the client never saw
  const [prefillLoaded, setPrefillLoaded] = useState(!isEditing);

  const fieldDefs: CredentialFieldDef[] =
    CREDENTIAL_FIELDS[category as CredentialCategory] ?? CREDENTIAL_FIELDS.login;

  const setField = (key: string, value: string) =>
    setFields(prev => ({ ...prev, [key]: value }));

  const toggleSecret = (key: string) =>
    setVisibleSecrets(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const pinHeaders = (): Record<string, string> => (pin ? { 'x-portal-pin': pin } : {});

  // Fetch existing field values when editing (sensitive fields are never
  // returned; leaving them blank keeps the stored values)
  useEffect(() => {
    if (!isEditing || !editingId) return;
    let cancelled = false;
    (async () => {
      try {
        const headers: Record<string, string> = pin ? { 'x-portal-pin': pin } : {};
        const res = await fetch(`/api/portal/${token}/credentials/${editingId}`, { headers });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (cancelled) return;
        setFields(data.fields || {});
        setPrefillLoaded(true);
      } catch {
        // If fetch fails, fields stay empty; they can still re-enter values
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isEditing, editingId, token, pin]);

  // Only submit values for the active category (plus notes). In edit mode,
  // blank sensitive fields are omitted so the stored secrets are preserved,
  // and if the prefill failed, blank fields are omitted entirely so values
  // the client never saw are not wiped.
  const collectFields = (): Record<string, string> => {
    const collected: Record<string, string> = {};
    for (const def of fieldDefs) {
      const value = (fields[def.key] ?? '').trim();
      if (isEditing && !value && (def.sensitive || !prefillLoaded)) continue;
      collected[def.key] = value;
    }
    const notes = (fields.notes ?? '').trim();
    if (!isEditing || notes || prefillLoaded) collected.notes = notes;
    return collected;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setSubmitting(true);

    try {
      if (isEditing) {
        // Rows still on a pre-migration category keep it unless the client
        // picks one of the current types
        const categoryIsCurrent = CREDENTIAL_CATEGORIES.some(c => c.value === category);
        const res = await fetch(`/api/portal/${token}/credentials/${editingCredential.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...pinHeaders() },
          body: JSON.stringify({
            label: label.trim(),
            ...(categoryIsCurrent ? { category } : {}),
            fields: collectFields(),
          }),
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        onDone({ ...editingCredential, ...json.data }, 'edit');
      } else {
        const res = await fetch(`/api/portal/${token}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...pinHeaders() },
          body: JSON.stringify({
            label: label.trim(),
            category,
            fields: collectFields(),
            submitted_by_name: '',
          }),
        });
        if (!res.ok) throw new Error();
        const json = await res.json();
        onDone({
          id: json.data.id,
          label: json.data.label ?? label.trim(),
          category: (json.data.category ?? category) as SubmittedCredential['category'],
          created_at: json.data.created_at ?? new Date().toISOString(),
          updated_at: json.data.updated_at ?? new Date().toISOString(),
        }, 'add');
      }
    } catch {
      toast('error', 'Could not save the credential. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderField = (def: CredentialFieldDef) => {
    const id = `${uid}-${def.key}`;
    const value = fields[def.key] ?? '';
    let control: React.ReactNode;

    if (def.options) {
      control = (
        <Select
          value={value}
          onChange={v => setField(def.key, v)}
          options={def.options.map(o => ({ value: o, label: o }))}
          placeholder={def.placeholder}
          ariaLabel={def.label}
        />
      );
    } else if (def.multiline) {
      control = (
        <textarea
          id={id}
          value={value}
          onChange={e => setField(def.key, e.target.value)}
          placeholder={def.placeholder}
          rows={4}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className="vm-input vm-mono text-[13px]"
        />
      );
    } else if (def.sensitive) {
      const visible = visibleSecrets.has(def.key);
      control = (
        <div className="relative">
          <input
            id={id}
            type="text"
            value={value}
            onChange={e => setField(def.key, e.target.value)}
            placeholder={isEditing ? 'Leave blank to keep current' : def.placeholder}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            style={visible ? undefined : { WebkitTextSecurity: 'disc' } as CSSProperties}
            className="vm-input pr-12"
          />
          <button
            type="button"
            onClick={() => toggleSecret(def.key)}
            aria-label={visible ? `Hide ${def.label}` : `Show ${def.label}`}
            aria-pressed={visible}
            className="vm-icon-btn absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2"
          >
            {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
          </button>
        </div>
      );
    } else {
      control = (
        <input
          id={id}
          type="text"
          value={value}
          onChange={e => setField(def.key, e.target.value)}
          placeholder={def.placeholder}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className="vm-input"
        />
      );
    }

    return (
      <div key={def.key} className={def.half ? 'sm:col-span-1' : 'sm:col-span-2'}>
        {def.options ? (
          <span className="vm-label mb-2">{def.label}</span>
        ) : (
          <label htmlFor={id} className="vm-label mb-2">{def.label}</label>
        )}
        {control}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <button type="button" onClick={onCancel} aria-label="Back to credentials" className="vm-icon-btn -ml-2">
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <h2 className="vm-h2 text-[1.35rem] sm:text-[1.6rem]">{isEditing ? 'Update credential' : 'New credential'}</h2>
      </div>

      {loadingFields ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={20} className="vm-faint animate-spin" role="img" aria-label="Loading" />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div role="group" aria-labelledby={`${uid}-type`}>
            <span id={`${uid}-type`} className="vm-label mb-2">Type</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CREDENTIAL_CATEGORIES.map(cat => {
                const TypeIcon = cat.icon;
                const selected = category === cat.value;
                return (
                  <button
                    key={cat.value}
                    type="button"
                    onClick={() => setCategory(cat.value)}
                    aria-pressed={selected}
                    className={`vm-tile flex items-center gap-2.5 px-3.5 py-3 text-left text-[13.5px] transition-colors ${
                      selected ? 'vm-tile-teal' : 'vm-soft hover:bg-white/[0.05]'
                    }`}
                  >
                    <TypeIcon size={15} strokeWidth={1.75} aria-hidden="true" className={selected ? 'text-(--vm-teal-200)' : ''} />
                    <span className="truncate">{cat.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor={`${uid}-label`} className="vm-label mb-2">Name</label>
            <input
              id={`${uid}-label`}
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Email login"
              required
              autoFocus={!isEditing}
              className="vm-input"
            />
          </div>

          {/* Type-specific fields; half-width fields pair up from sm */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {fieldDefs.map(renderField)}
          </div>
          {isEditing && fieldDefs.some(d => d.sensitive) && (
            <p className="vm-faint text-[13px]">
              Secret fields stay hidden. Leave them blank to keep the current values.
            </p>
          )}

          <div>
            <label htmlFor={`${uid}-notes`} className="vm-label mb-2">Notes</label>
            <textarea
              id={`${uid}-notes`}
              value={fields.notes ?? ''}
              onChange={e => setField('notes', e.target.value)}
              placeholder="Optional"
              rows={2}
              className="vm-input"
            />
          </div>

          <div className="flex flex-col-reverse gap-2.5 pt-1 sm:flex-row sm:justify-end">
            <button type="button" onClick={onCancel} className="vm-btn vm-btn-ghost w-full sm:w-auto">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!label.trim() || submitting}
              className="vm-btn vm-btn-primary w-full sm:w-auto"
            >
              {submitting
                ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                : <KeyRound size={15} aria-hidden="true" />}
              {isEditing ? 'Update credential' : 'Submit securely'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* Two distinct views: the list, or the add/edit form. */
export function CredentialsSection({
  token,
  pin,
  credentialsSubmitted,
}: {
  token: string;
  pin?: string;
  credentialsSubmitted: SubmittedCredential[];
}) {
  const [localCredentials, setLocalCredentials] = useState<SubmittedCredential[]>(credentialsSubmitted);
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editTarget, setEditTarget] = useState<SubmittedCredential | null>(null);

  const handleDone = (cred: SubmittedCredential, mode: 'add' | 'edit') => {
    if (mode === 'add') {
      setLocalCredentials(prev => [cred, ...prev]);
      toast('success', 'Credentials submitted securely');
    } else {
      setLocalCredentials(prev => prev.map(c => (c.id === cred.id ? cred : c)));
      toast('success', 'Credential updated');
    }
    setView('list');
    setEditTarget(null);
  };

  const handleCancel = () => {
    setView('list');
    setEditTarget(null);
  };

  return (
    <SectionCard sectionKey="show_credentials">
      {view === 'list' ? (
        <>
          <SectionHeader
            title="Credentials"
            right={
              <button type="button" onClick={() => setView('add')} className="vm-btn vm-btn-ghost vm-btn-sm">
                <Plus size={14} aria-hidden="true" />
                Add
              </button>
            }
          />

          {localCredentials.length > 0 ? (
            <ul>
              {localCredentials.map(cred => {
                const catMeta = CREDENTIAL_CATEGORIES.find(c => c.value === cred.category);
                const CatIcon = catMeta?.icon || KeyRound;
                return (
                  <li key={cred.id} className="vm-row flex items-center gap-3.5 py-3.5 first:pt-0 last:pb-0">
                    <span className={ICON_TILE} aria-hidden="true">
                      <CatIcon size={17} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">{cred.label}</p>
                      <div className="vm-faint mt-1 flex flex-wrap items-center gap-x-2 text-[13px]">
                        <span>{catMeta?.label || cred.category}</span>
                        <span className="opacity-50" aria-hidden="true">/</span>
                        <span>{relativeTime(cred.updated_at || cred.created_at)}</span>
                      </div>
                    </div>
                    <Tooltip content="Edit">
                      <button
                        type="button"
                        onClick={() => { setEditTarget(cred); setView('edit'); }}
                        aria-label={`Edit ${cred.label}`}
                        className="vm-icon-btn shrink-0"
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="vm-muted text-[15px]">Nothing shared yet. Use Add to hand us access securely.</p>
          )}
        </>
      ) : (
        <CredentialForm
          key={view === 'edit' ? editTarget?.id : 'add'}
          token={token}
          pin={pin}
          editingCredential={view === 'edit' ? editTarget : null}
          onDone={handleDone}
          onCancel={handleCancel}
        />
      )}
    </SectionCard>
  );
}
