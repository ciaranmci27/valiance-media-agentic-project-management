'use client';

import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ScrollText } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { useRead } from '@/lib/query-cache';
import { auditLogRead } from '@/lib/reads';
import { NO_AUDIT_FILTERS, VIA_LABELS, auditActionLabel, auditDetails, auditQuery, type AuditEntry, type AuditFilters } from '@/lib/audit-log';
import { Pill } from '@/components/ui/Pill';
import { formatDateTime } from '@/lib/time-format';

const ANYONE = '';

/** When it happened, in the person's own time zone (lib/time-zone). */
const when = (iso: string) => formatDateTime(iso);

/**
 * Settings > Security > Audit log: who changed what, newest first. Filters
 * by who did it, who it was done for (an agent acting for a person), the
 * action and dates (the viewer's own days); pages of 50. Each row opens to
 * what was sent and the state before and after (secrets were never stored).
 * Export downloads every row the filters shown match, as CSV.
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
  // Every name a row may mention: the server's (people, groups, projects, tasks, keys), then the team's.
  const names: Record<string, string> = { ...Object.fromEntries(team.map((m) => [m.id, m.name])), ...(data?.names ?? {}) };

  const apply = (next: AuditFilters) => {
    setFilters(next);
    setPage(0);
    setOpen(null);
  };
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_AUDIT_FILTERS);
  const [exporting, setExporting] = useState(false);

  // Every row the filters shown match (not the ones still being typed), as a CSV download.
  const exportRows = async () => {
    setExporting(true);
    try {
      const query = auditQuery(filters, 0);
      const response = await fetch(`/api/workspace/audit-log?format=csv${query ? `&${query}` : ''}`, { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Could not export the audit log.');
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'audit-log.csv';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const rows = Number(response.headers.get('X-Row-Count') ?? 0);
      toast('success', response.headers.get('X-Truncated') === 'true'
        ? `Exported the newest ${rows.toLocaleString()} rows. Narrow the dates for the rest.`
        : `Exported ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not export the audit log.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="audit-log-heading">
      <SettingsSectionHeader
        icon={ScrollText}
        headingId="audit-log-heading"
        title="Audit log"
        description="Who changed members, keys, agents, settings, permissions and modules, and every API and MCP write. Rows never change once written."
        action={(
          <Button size="sm" variant="secondary" onClick={() => { void exportRows(); }} disabled={exporting || !data || data.total === 0} icon={<Download size={14} aria-hidden="true" />}>
            {exporting ? 'Exporting' : filtered ? 'Export these rows' : 'Export'}
          </Button>
        )}
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
              <AuditRow key={entry.id} entry={entry} names={names} who={nameOf(entry.team_member_id)} actingFor={nameOf(entry.principal_id)} open={open === entry.id} onToggle={() => setOpen(open === entry.id ? null : entry.id)} />
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

function AuditRow({ entry, names, who, actingFor, open, onToggle }: { entry: AuditEntry; names: Record<string, string>; who: string | null; actingFor: string | null; open: boolean; onToggle: () => void }) {
  const failed = entry.status_code >= 400;
  const [advanced, setAdvanced] = useState(false);
  const details = open ? auditDetails(entry, names) : [];
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
            <span className="text-sm font-medium text-white">{auditActionLabel(entry, names)}</span>
            <span className="text-sm text-zinc-400">by {who ?? 'the system'}{actingFor ? ` for ${actingFor}` : ''}</span>
            {failed && <Pill tone="problem" dot>Refused</Pill>}
          </span>
        </span>
        <span className="flex-shrink-0 text-right text-xs text-zinc-500">
          <span className="block">{when(entry.timestamp)}</span>
          <span className="block">{VIA_LABELS[entry.via] ?? entry.via}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 pl-9">
          {entry.error && <p className="text-sm text-red-300">{entry.error}</p>}
          {details.length > 0 ? (
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              {details.map((detail, index) => (
                <div key={`${detail.label}-${index}`} className="contents">
                  <dt className="text-xs text-zinc-500 sm:pt-0.5">{detail.label}</dt>
                  <dd className="min-w-0 break-words text-zinc-200">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-zinc-500">No details were recorded.</p>
          )}
          <Button size="sm" variant="ghost" className="-ml-2.5" aria-expanded={advanced} onClick={() => setAdvanced((shown) => !shown)}
            icon={<ChevronDown size={14} aria-hidden="true" className={`transition-transform ${advanced ? 'rotate-180' : ''}`} />}>
            Advanced
          </Button>
          {advanced && (
            <div className="space-y-3">
              <p className="break-all font-mono text-[11px] text-zinc-500">{entry.method} {entry.endpoint}{failed ? ` (${entry.status_code})` : ''}</p>
              <div className="grid gap-3 lg:grid-cols-3">
                <Json label="Sent" value={entry.request_body} />
                <Json label="Before" value={entry.before_snapshot} />
                <Json label="After" value={entry.after_snapshot} />
              </div>
            </div>
          )}
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
