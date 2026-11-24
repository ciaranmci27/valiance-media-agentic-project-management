'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { scopeGroups } from '@/lib/agents-ui';
import {
  AGENT_RULE_LABELS, CLOSE_POLICY_OPTIONS, CREATE_POLICY_OPTIONS, ESCALATE_DEFAULT_LABEL, type AgentRules,
} from '@/lib/agent-rules';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';

/**
 * What an agent's key may do, in plain words, grouped as the Access page
 * groups them. The template's choices are ticked; a group with none ticked
 * starts folded so the page stays short. Sensitive powers say so.
 */
export function ScopePicker({ grantable, value, onChange, preset, error, disabled }: {
  grantable: readonly string[];
  value: string[];
  onChange: (scopes: string[]) => void;
  /** The template's scopes, marked "Suggested". */
  preset?: readonly string[];
  error?: string;
  disabled?: boolean;
}) {
  const groups = useMemo(() => scopeGroups(grantable), [grantable]);
  const selected = new Set(value);
  const suggested = new Set(preset ?? []);
  // Folded by default; the groups the template touches open (or, with no template, the ones already on).
  const touched = suggested.size ? suggested : selected;
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(groups.filter((g) => g.scopes.some((s) => touched.has(s.key))).map((g) => g.id)));
  const toggle = (key: string, on: boolean) => onChange(on ? [...value, key] : value.filter((v) => v !== key));

  return (
    <div className="space-y-2">
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {groups.map((group) => {
        const count = group.scopes.filter((s) => selected.has(s.key)).length;
        const isOpen = openGroups.has(group.id);
        return (
          <div key={group.id} className="overflow-hidden rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => { const next = new Set(openGroups); if (isOpen) next.delete(group.id); else next.add(group.id); setOpenGroups(next); }}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
            >
              <span className="text-sm font-medium text-white">{group.label}</span>
              <span className="flex items-center gap-2 text-xs text-zinc-500">
                {`${count} of ${group.scopes.length} on`}
                <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </span>
            </button>
            {isOpen && (
              <ul className="border-t border-white/[0.05] px-4 py-2">
                {group.scopes.map((scope) => (
                  <li key={scope.key} className="py-2">
                    <Checkbox
                      checked={selected.has(scope.key)}
                      onChange={(on) => toggle(scope.key, on)}
                      disabled={disabled}
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-zinc-100">{scope.label}</span>
                          {suggested.has(scope.key) && <span className="rounded-full bg-brand-500/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-brand-200">Suggested</span>}
                          {scope.sensitive && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                              <AlertTriangle size={10} aria-hidden="true" />Sensitive
                            </span>
                          )}
                        </span>
                      }
                      description={scope.description}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The four rules as plain switches and choices, in the order the Team page asks them. */
export function RulesFields({ value, onChange, people, disabled }: {
  value: AgentRules;
  onChange: (rules: AgentRules) => void;
  /** Who it may escalate to: people on the team. */
  people: { id: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="divide-y divide-white/[0.06] rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
      <div className="px-4 py-3.5">
        <Toggle
          checked={value.agent_self_assign}
          onChange={(on) => onChange({ ...value, agent_self_assign: on })}
          label={AGENT_RULE_LABELS.agent_self_assign}
          description="On: it claims ready work nobody is assigned to. Off: it works only what it is given."
          disabled={disabled}
        />
      </div>
      <div className="px-4 py-3.5">
        <Toggle
          checked={value.agent_close_policy === 'review'}
          onChange={(on) => onChange({ ...value, agent_close_policy: on ? 'review' : 'close' })}
          label="Send finished work to review"
          description={(value.agent_close_policy === 'review' ? CLOSE_POLICY_OPTIONS[1] : CLOSE_POLICY_OPTIONS[0]).detail}
          disabled={disabled}
        />
      </div>
      <div className="px-4 py-3.5">
        <Toggle
          checked={value.agent_create_policy === 'approval'}
          onChange={(on) => onChange({ ...value, agent_create_policy: on ? 'approval' : 'live' })}
          label="New tasks need approval"
          description={(value.agent_create_policy === 'approval' ? CREATE_POLICY_OPTIONS[1] : CREATE_POLICY_OPTIONS[0]).detail}
          disabled={disabled}
        />
      </div>
      <div className="px-4 py-3.5">
        <Select
          label={AGENT_RULE_LABELS.agent_escalate_to}
          value={value.agent_escalate_to ?? ''}
          onChange={(v) => onChange({ ...value, agent_escalate_to: v || null })}
          options={[{ value: '', label: ESCALATE_DEFAULT_LABEL }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
          searchable={people.length > 7}
          disabled={disabled}
          description="Who gets its questions when nobody is named."
        />
      </div>
    </div>
  );
}
