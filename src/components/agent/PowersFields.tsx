'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { scopeGroups, AGENT_SCOPE_BEYOND_ROLE, AGENT_SCOPE_OWNER_ONLY, type ScopeGroup } from '@/lib/agents-ui';
import {
  AGENT_RULE_LABELS, CLOSE_POLICY_OPTIONS, CREATE_POLICY_OPTIONS, ESCALATE_DEFAULT_LABEL, type AgentRulesDraft,
} from '@/lib/agent-rules';
import { groupTargetLabel } from '@/lib/groups';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';

/**
 * What an agent's key may do, in plain words, grouped as the Access page
 * groups them. The template's choices are ticked; a group with none ticked
 * starts folded so the page stays short. Sensitive powers say so. With
 * `agentHeld`, a power the agent role lacks says that taking it gives it to
 * this agent, or, for someone who may not add it, stays greyed with who can.
 */
export function ScopePicker({
  grantable, groups: given, value, onChange, preset, error, disabled, agentHeld, mayGiveBeyondRole = true, beyondRoleNote = AGENT_SCOPE_BEYOND_ROLE,
}: {
  grantable: readonly string[];
  /** Groups to offer instead of an agent's (a person's own key offers every scope they hold). */
  groups?: ScopeGroup[];
  value: string[];
  onChange: (scopes: string[]) => void;
  /** The template's scopes, marked "Suggested". */
  preset?: readonly string[];
  error?: string;
  disabled?: boolean;
  /** What the agent holds from its role; the others are marked. Left out: nothing is marked. */
  agentHeld?: readonly string[] | null;
  /** Whether the viewer may give an agent a power its role lacks (who manages access: an Owner). */
  mayGiveBeyondRole?: boolean;
  /** What a power beyond the role says when it may be given. */
  beyondRoleNote?: string;
}) {
  const groups = useMemo(() => given ?? scopeGroups(grantable, agentHeld), [given, grantable, agentHeld]);
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
        const offered = group.scopes.filter((s) => mayGiveBeyondRole || !s.beyondRole).length;
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
                {offered === 0 ? 'Owner only' : `${count} of ${offered} on`}
                <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </span>
            </button>
            {isOpen && (
              <ul className="border-t border-white/[0.05] px-4 py-2">
                {group.scopes.map((scope) => {
                  const locked = !!scope.beyondRole && !mayGiveBeyondRole;
                  return (
                    <li key={scope.key} className="py-2">
                      <Checkbox
                        checked={selected.has(scope.key)}
                        onChange={(on) => toggle(scope.key, on)}
                        // A locked power can still be taken off if it was on; never put on.
                        disabled={disabled || (locked && !selected.has(scope.key))}
                        label={
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={`text-sm ${locked ? 'text-zinc-400' : 'text-zinc-100'}`}>{scope.label}</span>
                            {suggested.has(scope.key) && <span className="rounded-full bg-brand-500/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-brand-200">Suggested</span>}
                            {scope.beyondRole && <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">Not by default</span>}
                            {scope.sensitive && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.14] px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                                <AlertTriangle size={10} aria-hidden="true" />Sensitive
                              </span>
                            )}
                          </span>
                        }
                        description={scope.beyondRole ? <>{scope.description} <span className="text-zinc-400">{locked ? AGENT_SCOPE_OWNER_ONLY : beyondRoleNote}</span></> : scope.description}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A group's value in the escalation picker, beside people's member ids. */
const GROUP_PREFIX = 'group:';

/**
 * The four rules as plain switches and choices, in the order the Team page
 * asks them. It escalates to a person or a group, never both: picking one
 * clears the other.
 */
export function RulesFields({ value, onChange, people, groups = [], disabled, escalateDefaultLabel, escalation: fixedEscalation, taskRules = true }: {
  value: AgentRulesDraft;
  onChange: (rules: AgentRulesDraft) => void;
  /** Who it may escalate to: people on the team. */
  people: { id: string; name: string }[];
  /** Groups it may escalate to instead (any member answers). */
  groups?: { id: string; name: string }[];
  disabled?: boolean;
  /** The empty choice with who it is today ("Its owners (first: Morgan)"); the plain label without. */
  escalateDefaultLabel?: string;
  /** Shown instead of the picker when who it escalates to is fixed (a personal agent asks its person). */
  escalation?: ReactNode;
  /** False for an agent with no task queue (it works in another system): only who it asks shows. */
  taskRules?: boolean;
}) {
  const escalation = value.agent_escalate_to_group ? `${GROUP_PREFIX}${value.agent_escalate_to_group}` : value.agent_escalate_to ?? '';
  const choose = (v: string) => onChange(v.startsWith(GROUP_PREFIX)
    ? { ...value, agent_escalate_to: null, agent_escalate_to_group: v.slice(GROUP_PREFIX.length) }
    : { ...value, agent_escalate_to: v || null, agent_escalate_to_group: null });
  const options = [
    { value: '', label: escalateDefaultLabel ?? ESCALATE_DEFAULT_LABEL },
    ...people.map((p) => ({ value: p.id, label: p.name, ...(groups.length ? { group: 'People' } : {}) })),
    ...groups.map((g) => ({ value: `${GROUP_PREFIX}${g.id}`, label: groupTargetLabel(g.name), group: 'Groups' })),
  ];
  return (
    <div className="divide-y divide-white/[0.06] rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
      {taskRules && (<>
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
      </>)}
      <div className="px-4 py-3.5">
        {fixedEscalation ? (
          <div>
            <p className="text-sm font-medium text-zinc-300">{AGENT_RULE_LABELS.agent_escalate_to}</p>
            <p className="mt-1 text-sm text-zinc-400">{fixedEscalation}</p>
          </div>
        ) : (
          <Select
            label={AGENT_RULE_LABELS.agent_escalate_to}
            value={escalation}
            onChange={choose}
            options={options}
            searchable={options.length > 8}
            disabled={disabled}
            description={groups.length ? 'Who gets its questions when nobody is named: a person, or a group where any member answers.' : 'Who gets its questions when nobody is named.'}
          />
        )}
      </div>
    </div>
  );
}
