'use client';

import { useMemo, useRef, useState } from 'react';
import { BarChart3, Bot, CalendarRange, Check, ChevronDown, FolderKanban, Search, X } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Popover } from '@/components/ui/Popover';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PRESET_OPTIONS, type RangePreset } from '@/lib/agent-range';
import { appLocale } from '@/lib/region';
import type { DateRange } from '@/lib/finance/summary';

/**
 * The Analytics tab's filter bar: date range, projects and agents. Every
 * figure below follows it. Pure presentation over the view's own state.
 */

const TRIGGER = 'w-full sm:w-auto flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors';
const MENU = 'bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg overflow-hidden';

function fmtDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(appLocale(), {
    month: 'short', day: 'numeric', year: y !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

interface Option { id: string; name: string; avatar?: string | null; color?: string | null }

function MultiPicker({
  icon: Icon, allLabel, noun, heading, options, selected, onChange, people,
}: {
  icon: typeof Bot;
  allLabel: string;
  noun: [string, string];
  heading: string;
  options: Option[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  people?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const count = selected.size;
  const label = count === 0 ? allLabel : count === 1 ? (options.find((o) => selected.has(o.id))?.name ?? `1 ${noun[0]}`) : `${count} ${noun[1]}`;
  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term ? options.filter((o) => o.name.toLowerCase().includes(term)) : options;
  }, [options, q]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  return (
    <div ref={ref} className="relative flex-1 sm:flex-none">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className={TRIGGER}>
        <Icon size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
        <span className="text-xs font-medium text-zinc-300 truncate max-w-[140px]">{label}</span>
        <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} align="end" className={MENU}>
        <div className="w-64">
          <div className="px-2.5 py-2 border-b border-white/[0.06] flex items-center justify-between gap-6">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">{heading}</span>
            <button type="button" onClick={() => onChange(new Set())} disabled={count === 0}
              className="text-[11px] font-medium text-zinc-400 hover:text-brand-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Clear
            </button>
          </div>
          {options.length > 10 && (
            <div className="p-2 border-b border-white/[0.06]">
              <TextInput type="search" size="sm" aria-label={`Search ${noun[1]}`} placeholder={`Search ${noun[1]}`} value={q} onChange={setQ} leftIcon={Search} clearable />
            </div>
          )}
          <div className="max-h-[320px] overflow-y-auto py-1">
            {visible.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-zinc-500">{options.length === 0 ? `No ${noun[1]} yet` : 'Nothing matches'}</p>
            ) : visible.map((o) => {
              const checked = selected.has(o.id);
              return (
                <button key={o.id} type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => toggle(o.id)}
                  className="w-full text-left text-sm px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors flex items-center gap-2">
                  <span className={`flex items-center justify-center w-4 h-4 rounded border transition-colors flex-shrink-0 ${checked ? 'bg-brand-600 border-brand-600 text-white' : 'border-white/[0.12] bg-surface-raised'}`}>
                    {checked && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  {people && <Avatar name={o.name} src={o.avatar || undefined} size="xs" />}
                  {!people && o.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: o.color }} aria-hidden="true" />}
                  <span className="text-zinc-300 truncate flex-1 min-w-0">{o.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </Popover>
    </div>
  );
}

export function AnalyticsFilters({
  range, preset, onPreset, customStart, customEnd, onCustomStart, onCustomEnd, earliestDateKey, todayKey,
  projects, selectedProjectIds, onProjects, agents, selectedAgentIds, onAgents,
}: {
  range: DateRange;
  preset: RangePreset;
  onPreset: (preset: RangePreset) => void;
  customStart: string;
  customEnd: string;
  onCustomStart: (v: string) => void;
  onCustomEnd: (v: string) => void;
  earliestDateKey: string | null;
  todayKey: string;
  projects: Option[];
  selectedProjectIds: Set<string>;
  onProjects: (next: Set<string>) => void;
  agents: Option[];
  selectedAgentIds: Set<string>;
  onAgents: (next: Set<string>) => void;
}) {
  const rangeRef = useRef<HTMLDivElement>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const focused = selectedAgentIds.size === 1 ? agents.find((a) => selectedAgentIds.has(a.id)) ?? null : null;

  return (
    <div className="glass-card rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <BarChart3 size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
        <h2 className="font-semibold text-white">Overview</h2>
        {focused && (
          <span className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-brand-500/15 text-brand-300 text-xs font-medium min-w-0">
            <Avatar name={focused.name} src={focused.avatar || undefined} size="xs" />
            <span className="truncate max-w-[120px]">{focused.name}</span>
            <button type="button" onClick={() => onAgents(new Set())} aria-label={`Stop focusing on ${focused.name}`}
              className="rounded-full p-0.5 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors">
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
        <span className="hidden sm:inline text-xs text-zinc-500 font-medium">{fmtDate(range.startKey)} - {fmtDate(range.endKey)}</span>
        <div ref={rangeRef} className="relative flex-1 sm:flex-none">
          <button type="button" onClick={() => setRangeOpen((o) => !o)} aria-expanded={rangeOpen} aria-haspopup="menu" className={TRIGGER}>
            <CalendarRange size={13} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
            <span className="text-xs font-medium text-zinc-300 whitespace-nowrap">{PRESET_OPTIONS.find((o) => o.value === preset)?.label ?? 'Custom'}</span>
            <ChevronDown size={13} className={`text-zinc-500 transition-transform duration-150 ${rangeOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          <Popover anchorRef={rangeRef} open={rangeOpen} onClose={() => setRangeOpen(false)} align="end"
            ignoreOutsideSelector='[role="dialog"][aria-label="Date picker"]' className={MENU}>
            <div className="p-1">
              {PRESET_OPTIONS.map((opt) => {
                const active = preset === opt.value;
                return (
                  <button key={opt.value} type="button" role="menuitemradio" aria-checked={active}
                    onClick={() => { onPreset(opt.value); if (opt.value !== 'custom') setRangeOpen(false); }}
                    className={`w-full text-left text-sm px-2.5 py-1.5 rounded-md transition-colors ${active ? 'bg-brand-500/15 text-brand-300 font-medium' : 'text-zinc-300 hover:bg-white/[0.03]'}`}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {preset === 'custom' && (
              <div className="border-t border-white/[0.06] bg-white/[0.03] p-3 space-y-2">
                <DateInput label="Start date" value={customStart} onChange={onCustomStart} size="sm"
                  minDate={earliestDateKey ?? undefined} maxDate={customEnd && customEnd < todayKey ? customEnd : todayKey} clearable />
                <DateInput label="End date" value={customEnd} onChange={onCustomEnd} size="sm"
                  minDate={customStart || earliestDateKey || undefined} maxDate={todayKey} clearable />
              </div>
            )}
          </Popover>
        </div>
        <MultiPicker icon={FolderKanban} allLabel="All projects" noun={['project', 'projects']} heading="Projects"
          options={projects} selected={selectedProjectIds} onChange={onProjects} />
        <MultiPicker icon={Bot} allLabel="All agents" noun={['agent', 'agents']} heading="Agents"
          options={agents} selected={selectedAgentIds} onChange={onAgents} people />
      </div>
    </div>
  );
}
