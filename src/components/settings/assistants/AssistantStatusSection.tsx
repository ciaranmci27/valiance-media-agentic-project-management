'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { useRead } from '@/lib/query-cache';
import { assistantStatusRead } from '@/lib/reads';
import { HOST_DOWN_WORDS, reasonWords, type AssistantState } from '@/lib/assistant';

const STATE_PILL: Record<AssistantState, { label: string; className: string }> = {
  working: { label: 'Working', className: 'bg-emerald-500/[0.14] text-emerald-200' },
  getting_ready: { label: 'Getting ready', className: 'bg-white/[0.06] text-zinc-300' },
  paused: { label: 'Paused by them', className: 'bg-white/[0.06] text-zinc-300' },
  on_hold: { label: 'On hold', className: 'bg-white/[0.06] text-zinc-300' },
  broken: { label: 'Needs you', className: 'bg-amber-500/[0.14] text-amber-200' },
};

const WINDOW = 24;

/**
 * Who has an assistant and how each one is: broken ones first, with why in
 * plain words and a link to fix it on the agent's page. Searchable and
 * windowed, so a hundred people stay one calm list.
 */
export function AssistantStatusSection() {
  const read = useRead(assistantStatusRead);
  const rows = useMemo(() => read.data ?? [], [read.data]);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(WINDOW);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter((row) => row.person.name.toLowerCase().includes(term) || row.name.toLowerCase().includes(term)) : rows;
  }, [rows, search]);
  const broken = rows.filter((row) => row.state === 'broken' || row.host_down).length;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="assistant-status-heading">
      <SettingsSectionHeader
        icon={Activity}
        headingId="assistant-status-heading"
        title="Status"
        description={rows.length
          ? `${rows.length} ${rows.length === 1 ? 'person has' : 'people have'} an assistant${broken ? `; ${broken} ${broken === 1 ? 'needs' : 'need'} you` : ''}.`
          : 'Who has an assistant, and whether each one is working.'}
      />
      {read.loading && !read.data ? (
        <p className="text-sm text-zinc-400" role="status">Loading</p>
      ) : read.failed && !read.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          Could not load assistants.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">Nobody has one yet. Pick who gets one above, then give everyone theirs.</p>
      ) : (
        <>
          {rows.length > 10 && (
            <div className="mb-3 max-w-xs">
              <TextInput type="search" size="sm" placeholder="Search people" value={search} onChange={(value) => { setSearch(value); setShown(WINDOW); }} aria-label="Search people" />
            </div>
          )}
          <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
            {filtered.slice(0, shown).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 bg-surface-raised px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">{row.person.name}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {row.name}{row.host_down ? ` · ${HOST_DOWN_WORDS}` : row.reason ? ` · ${reasonWords(row.reason)}` : ''}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATE_PILL[row.state].className}`}>{STATE_PILL[row.state].label}</span>
                  {(row.state === 'broken' || row.host_down) && (
                    <Link href={`/agent/${row.id}`} className="rounded-md px-2 py-1 text-xs font-medium text-brand-300 hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Fix</Link>
                  )}
                </div>
              </li>
            ))}
            {filtered.length === 0 && <li className="bg-surface-raised px-3 py-3 text-sm text-zinc-400">Nobody matches.</li>}
          </ul>
          {filtered.length > shown && (
            <button type="button" onClick={() => setShown((count) => count + WINDOW)}
              className="mt-2 text-xs text-zinc-400 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
              Show {Math.min(WINDOW, filtered.length - shown)} more of {filtered.length - shown}
            </button>
          )}
        </>
      )}
    </section>
  );
}
