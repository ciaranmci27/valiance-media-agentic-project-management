'use client';

import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ScrollText } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { useApp } from '@/lib/store';
import { useRead } from '@/lib/query-cache';
import { auditLogRead } from '@/lib/reads';
import { NO_AUDIT_FILTERS, VIA_LABELS, auditActionLabel, type AuditEntry, type AuditFilters } from '@/lib/audit-log';

const ANYONE = '';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Settings > Security > Audit log: who changed what, newest first. Filters
 * by who did it, who it was done for (an agent acting for a person), the
 * action and dates; pages of 50. Each row opens to what was sent and the
 * state before and after (secrets were never stored).
 */
export function AuditLogSection() {
  const { team } = useApp();
  const [draft, setDraft] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const read = useRead(auditLogRead(filters, page));
  const data = read.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  const members = [...team].sort((a, b) => a.name.localeCompare(b.name));
  const memberOptions = [{ value: ANYONE, label: 'Anyone' }, ...members.map((m) => ({ value: m.id, label: m.role === 'agent' ? `${m.name} (agent)` : m.name }))];
  const peopleOptions = [{ value: ANYONE, label: 'Anyone' }, ...members.filter((m) => m.role !== 'agent').map((m) => ({ value: m.id, label: m.name }))];
  const nameOf = (id: string | null) => (id ? data?.names[id] ?? team.find((m) => m.id === id)?.name ?? 'Someone removed' : null);

  const apply = (next: AuditFilters) => {
    setFilters(next);
    setPage(0);
    setOpen(null);
  };
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_AUDIT_FILTERS);

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="audit-log-heading">
      <SettingsSectionHeader
        icon={ScrollText}
        headingId="audit-log-heading"
        title="Audit log"
        description="Who changed members, keys, agents, settings, permissions and modules, and every API and MCP write. Rows never change once written."
      />
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          apply(draft);
        }}
      >
        <Select label="Who" value={draft.member ?? ANYONE} onChange={(value) => setDraft((d) => ({ ...d, member: value || null }))} options={memberOptions} searchable />
        <Select label="Acting for" value={draft.actingFor ?? ANYONE} onChange={(value) => setDraft((d) => ({ ...d, actingFor: value || null }))} options={peopleOptions} searchable />
        <TextInput label="Action" placeholder="api_key, PATCH, settings" value={draft.action} onChange={(value) => setDraft((d) => ({ ...d, action: value }))} maxLength={100} />
        <DateInput label="From" value={draft.from ?? ''} onChange={(value) => setDraft((d) => ({ ...d, from: value || null }))} />
        <DateInput label="To" value={draft.to ?? ''} onChange={(value) => setDraft((d) => ({ ...d, to: value || null }))} />
        <div className="flex justify-end gap-2 sm:col-span-2 lg:col-span-5">
          {filtered && <Button type="button" variant="ghost" onClick={() => { setDraft(NO_AUDIT_FILTERS); apply(NO_AUDIT_FILTERS); }}>Clear</Button>}
          <Button type="submit" variant="secondary">Show</Button>
        </div>
      </form>

      <div className="mt-5">
        {!data ? (
          <p className="text-sm text-zinc-400" role="status">{read.failed ? 'Could not load the audit log.' : 'Loading'}</p>
        ) : data.entries.length === 0 ? (
          <p className="rounded-lg bg-white/[0.03] px-4 py-6 text-center text-sm text-zinc-400">{filtered ? 'Nothing matches these filters.' : 'Nothing logged yet.'}</p>
        ) : (
          <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
            {data.entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} who={nameOf(entry.team_member_id)} actingFor={nameOf(entry.principal_id)} open={open === entry.id} onToggle={() => setOpen(open === entry.id ? null : entry.id)} />
            ))}
          </ul>
        )}
        {data && data.total > data.page_size && (
          <nav aria-label="Audit log pages" className="mt-3 flex items-center justify-between text-sm text-zinc-400">
            <span>Page {page + 1} of {pages} · {data.total.toLocaleString()} rows</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} aria-hidden="true" />} disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
              <Button size="sm" variant="ghost" icon={<ChevronRight size={14} aria-hidden="true" />} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older</Button>
            </span>
          </nav>
        )}
      </div>
    </section>
  );
}

function AuditRow({ entry, who, actingFor, open, onToggle }: { entry: AuditEntry; who: string | null; actingFor: string | null; open: boolean; onToggle: () => void }) {
  const failed = entry.status_code >= 400;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <ChevronDown size={14} className={`mt-1 flex-shrink-0 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-white">{auditActionLabel(entry)}</span>
            <span className="text-sm text-zinc-400">by {who ?? 'the system'}{actingFor ? ` for ${actingFor}` : ''}</span>
            {failed && <span className="rounded bg-red-500/[0.12] px-1.5 py-0.5 text-[11px] text-red-200">{entry.status_code}</span>}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">{entry.method} {entry.endpoint}</span>
        </span>
        <span className="flex-shrink-0 text-right text-xs text-zinc-500">
          <span className="block">{when(entry.timestamp)}</span>
          <span className="block">{VIA_LABELS[entry.via] ?? entry.via}</span>
        </span>
      </button>
      {open && (
        <div className="grid gap-3 px-3 pb-3 pl-9 lg:grid-cols-3">
          {entry.error && <p className="text-sm text-red-200 lg:col-span-3">{entry.error}</p>}
          <Json label="Sent" value={entry.request_body} />
          <Json label="Before" value={entry.before_snapshot} />
          <Json label="After" value={entry.after_snapshot} />
        </div>
      )}
    </li>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-zinc-400">{label}</p>
      {value === null || value === undefined ? (
        <p className="text-xs text-zinc-500">Nothing</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );
}
