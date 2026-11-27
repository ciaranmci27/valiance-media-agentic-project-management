'use client';

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { FilterButton, FilterOption, FilterSection } from '@/components/ui/FilterButton';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { PRESET_OPTIONS, type RangePreset } from '@/lib/agent-range';

/**
 * The Analytics report's filters, for its card header (DESIGN.md Rules 3 and
 * 17): one FilterButton for agents and projects, counting what is on, and a
 * small date range Select (with two dates when Custom is picked). Every
 * figure in the report follows them. Pure presentation over the view's state.
 */

interface Option { id: string; name: string }

/** Past this many options a section gets a search box. */
const SEARCH_FROM = 10;

function OptionSection({ label, noun, options, selected, onChange }: {
  label: string;
  noun: string;
  options: Option[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [q, setQ] = useState('');
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
    <FilterSection label={label}>
      {options.length > SEARCH_FROM && (
        <TextInput type="search" size="sm" aria-label={`Search ${noun}`} placeholder={`Search ${noun}`} value={q} onChange={setQ}
          leftIcon={Search} clearable className="w-full" />
      )}
      {visible.length === 0 ? (
        <p className="text-xs text-zinc-500">{options.length === 0 ? `No ${noun} yet` : 'Nothing matches'}</p>
      ) : (
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {visible.map((o) => (
            <FilterOption key={o.id} selected={selected.has(o.id)} onToggle={() => toggle(o.id)}>
              <span className="truncate">{o.name}</span>
            </FilterOption>
          ))}
        </div>
      )}
    </FilterSection>
  );
}

export function AnalyticsFilters({
  preset, onPreset, customStart, customEnd, onCustomStart, onCustomEnd, earliestDateKey, todayKey,
  projects, selectedProjectIds, onProjects, agents, selectedAgentIds, onAgents,
}: {
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
  const active = selectedAgentIds.size + selectedProjectIds.size;
  return (
    <>
      <FilterButton activeCount={active} onClear={() => { onAgents(new Set()); onProjects(new Set()); }} title="Show only">
        <OptionSection label="Agents" noun="agents" options={agents} selected={selectedAgentIds} onChange={onAgents} />
        <OptionSection label="Projects" noun="projects" options={projects} selected={selectedProjectIds} onChange={onProjects} />
      </FilterButton>
      <Select size="sm" ariaLabel="Date range" value={preset} onChange={(v) => onPreset(v as RangePreset)}
        options={PRESET_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      {preset === 'custom' && (
        <>
          <DateInput ariaLabel="Start date" value={customStart} onChange={onCustomStart} size="sm" className="w-36"
            minDate={earliestDateKey ?? undefined} maxDate={customEnd && customEnd < todayKey ? customEnd : todayKey} clearable />
          <DateInput ariaLabel="End date" value={customEnd} onChange={onCustomEnd} size="sm" className="w-36"
            minDate={customStart || earliestDateKey || undefined} maxDate={todayKey} clearable />
        </>
      )}
    </>
  );
}
