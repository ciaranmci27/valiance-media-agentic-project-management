'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { KeyRound, Network, ShieldCheck, Users } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { permissionLabel } from '@/lib/access-control';
import { invalidateTables, setReadData, useRead } from '@/lib/query-cache';
import { allGroupsRead } from '@/lib/reads';
import { agentAccessRead, agentPowersRead, agentTreeRead } from '@/lib/agent-access-reads';
import {
  audienceFromLists, audienceLists, orchestratorChoices, pickIncludes, powersCountWords, worksForWords,
} from '@/lib/agent-access-ui';
import { groupTargetLabel } from '@/lib/groups';
import { workspaceApi, type AgentDetail } from '@/lib/agent-workspace';
import type { AgentAccessView } from '@/lib/api/agent-hierarchy';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { SaveBar } from '@/components/ui/SaveBar';
import { Select } from '@/components/ui/inputs/Select';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { UndoLine } from '@/components/ui/UndoLine';
import { toast } from '@/components/ui/Toast';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { DEMO_NOTICE } from '@/components/agent/profile/LimitsPanel';
import { AgentKeysCard, type KeyPowers } from '@/components/agent/profile/AgentKeysCard';
import { AgentPowersPanel } from '@/components/agent/profile/AgentPowersPanel';

/**
 * An agent's Access tab: one place that shows and changes, in plain words,
 * who it works for (its orchestrator, and what "no skipping levels" means for
 * it), who can use it (Everyone, roles, groups or people, with an Except
 * list, the limit its orchestrators put on it, how many people that is, Ask
 * first, Only through its orchestrator), who manages it, what it may do (its
 * powers and its keys' scopes as ONE list, edited in the side panel) and its
 * keys. Reads GET /api/workspace/agents/{id}/access and /powers; writes PUT
 * on the same. A personal assistant shows who it works for and its keys only.
 */

const ROLE_OPTIONS = [
  { value: 'role:owner', label: 'Owners' },
  { value: 'role:admin', label: 'Admins' },
  { value: 'role:member', label: 'Members' },
  { value: 'role:guest', label: 'Guests' },
];

function demoStops(isDemoMode: boolean): boolean {
  if (isDemoMode) toast('info', DEMO_NOTICE);
  return isDemoMode;
}

export function AccessTab({ detail, keyPowers, suspended, managedBy, connect, reads }: {
  detail: AgentDetail;
  keyPowers: KeyPowers;
  suspended: boolean;
  /** Its owners and the way to change them (the profile's owners row). */
  managedBy: ReactNode;
  /** How its host connects (the snippets), under its keys. */
  connect?: ReactNode;
  /** What it reads (its AGENTS.md), full width below both columns. */
  reads?: ReactNode;
}) {
  const { isDemoMode } = useDemo();
  const agentId = detail.agent.id;
  const name = detail.agent.name;
  const access = useRead(agentAccessRead(agentId, isDemoMode));
  const powers = useRead(detail.keys !== undefined && !detail.agent.delegate_of ? agentPowersRead(agentId, isDemoMode) : null);
  const [editingPowers, setEditingPowers] = useState(false);
  const person = detail.agent.delegate_of ? detail.person ?? null : null;
  const held = powers.data?.scopes ?? [];

  if (person) {
    return (
      <AccessLayout
        main={(
          <Card title="Who it works for" icon={<Users />} id="access-person">
            <p className="text-sm text-zinc-300">
              {person.name || 'One person'}&apos;s personal assistant. Only they can use it, and it never joins the company&apos;s agent team.
            </p>
          </Card>
        )}
        side={(
          <>
            <AgentKeysCard detail={detail} powers={keyPowers} suspended={suspended} held={[]} />
            {connect}
          </>
        )}
        reads={reads}
      />
    );
  }

  return (
    <AccessLayout
      main={(
        <>
          {access.loading && !access.data ? (
            <Skeleton label="Loading access" className="flex flex-col gap-6">{[0, 1].map((i) => <Bone key={i} className="h-36 rounded-xl" />)}</Skeleton>
          ) : !access.data ? (
            <EmptyState variant="error" title="Could not load who can use it" description="Try again in a moment." onRetry={access.reload} framed />
          ) : (
            <>
              <WorksForCard access={access.data} />
              <WhoCanUseCard access={access.data} />
            </>
          )}

          <Card title="Managed by" icon={<ShieldCheck />} id="access-managers" description="They change its setup, get its questions and approve what it asks for.">
            {managedBy}
          </Card>
          {detail.keys !== undefined && (
            <Card
              title="What it may do"
              icon={<KeyRound />}
              id="access-powers"
              afterTitle={powers.data?.out_of_step ? <Pill tone="waiting" dot>Keys differ</Pill> : undefined}
              action={powers.data?.can_edit ? <Button size="sm" variant="secondary" onClick={() => setEditingPowers(true)}>Edit</Button> : undefined}
            >
              {powers.loading && !powers.data ? (
                <Skeleton label="Loading what it may do" className="space-y-2"><Bone className="h-4 w-40" /><Bone className="h-4 w-full" /></Skeleton>
              ) : !powers.data ? (
                <EmptyState variant="error" compact title="Could not load what it may do" onRetry={powers.reload} />
              ) : (
                <PowersSummary scopes={powers.data.scopes} liveKeys={powers.data.live_keys.length} outOfStep={powers.data.out_of_step} name={name} />
              )}
            </Card>
          )}
        </>
      )}
      side={(
        <>
          <AgentKeysCard detail={detail} powers={keyPowers} suspended={suspended} held={held} />
          {connect}
        </>
      )}
      reads={reads}
    >
      {editingPowers && powers.data && (
        <AgentPowersPanel agentId={agentId} agentName={name} powers={powers.data} onClose={() => setEditingPowers(false)} />
      )}
    </AccessLayout>
  );
}

/**
 * The tab's one width (DESIGN.md Rule 9): on wide screens who it works for,
 * who can use it, who manages it and what it may do sit on the left, its keys
 * and how its host connects on the right, and what it reads spans both below.
 * Stacked on phones, in that order.
 */
function AccessLayout({ main, side, reads, children }: { main: ReactNode; side: ReactNode; reads?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">{main}</div>
        <div className="flex min-w-0 flex-col gap-6">{side}</div>
      </div>
      {reads}
      {children}
    </div>
  );
}

function PowersSummary({ scopes, liveKeys, outOfStep, name }: { scopes: string[]; liveKeys: number; outOfStep: boolean; name: string }) {
  const [all, setAll] = useState(false);
  if (liveKeys === 0 && scopes.length === 0) {
    return <p className="text-sm text-zinc-400">Nothing yet. Make a key and choose what {name} may do.</p>;
  }
  const labels = scopes.map(permissionLabel);
  const shown = all ? labels : labels.slice(0, 8);
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-200">
        {powersCountWords(scopes.length)}{liveKeys > 1 ? `, on each of its ${liveKeys} keys` : liveKeys === 1 ? ', through its key' : ''}.
        {liveKeys === 0 && ' It has no working key, so none of it works yet.'}
      </p>
      {outOfStep && <p className="text-xs text-amber-300">Its keys and its powers differ. Edit and save to line them up.</p>}
      <p className="text-xs leading-relaxed text-zinc-400">
        {shown.join(', ')}
        {labels.length > shown.length && (
          <> <button type="button" onClick={() => setAll(true)} className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">and {labels.length - shown.length} more</button></>
        )}
      </p>
    </div>
  );
}

/** Its orchestrator: picked at once, with Undo in place; the one line says what that means. */
function WorksForCard({ access }: { access: AgentAccessView }) {
  const { isDemoMode } = useDemo();
  const tree = useRead(access.can_manage ? agentTreeRead(isDemoMode) : null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState<{ from: string | null; to: string | null } | null>(null);
  const read = agentAccessRead(access.agent_id, isDemoMode);
  const choices = useMemo(() => orchestratorChoices((tree.data?.agents ?? []).map((a) => ({ ...a, personal: false })), access.agent_id), [tree.data, access.agent_id]);
  const options = [
    { value: '', label: 'No one: it is at the top' },
    ...choices.map((a) => ({ value: a.id, label: a.name })),
    // The saved one stays pickable while the chart loads.
    ...(access.orchestrator && !choices.some((a) => a.id === access.orchestrator!.id) ? [{ value: access.orchestrator.id, label: access.orchestrator.name }] : []),
  ];

  const save = async (patch: Partial<Pick<AgentAccessView, 'orchestrator_id' | 'reachable_directly' | 'ask_first' | 'ask_people_directly'>>, undo?: { from: string | null; to: string | null }) => {
    if (demoStops(isDemoMode)) {
      setReadData(read, (current) => (current ? { ...current, ...patch, orchestrator: patch.orchestrator_id === undefined ? current.orchestrator : patch.orchestrator_id ? { id: patch.orchestrator_id, name: options.find((o) => o.value === patch.orchestrator_id)?.label ?? '' } : null } : current!));
      if (undo) setMoved(undo);
      return;
    }
    setBusy(true);
    try {
      const next = await workspaceApi<AgentAccessView>(`/api/workspace/agents/${encodeURIComponent(access.agent_id)}/access`, { method: 'PUT', body: patch });
      setReadData(read, () => next);
      invalidateTables(['team_members']);
      setMoved(undo ?? null);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const orchestratorName = access.orchestrator?.name ?? null;
  return (
    <Card title="Works for" icon={<Network />} id="access-works-for">
      <div className="space-y-4">
        {access.can_manage ? (
          <Select
            label="Orchestrator"
            value={access.orchestrator_id ?? ''}
            onChange={(value) => void save({ orchestrator_id: value || null }, { from: access.orchestrator_id, to: value || null })}
            options={options}
            searchable={options.length > 8}
            ariaDisabled={busy}
            placeholder="No one: it is at the top"
          />
        ) : (
          <p className="text-sm text-zinc-200">{orchestratorName ? <>Works for <span className="font-medium">{orchestratorName}</span> (orchestrator)</> : 'Works for no one: it is at the top.'}</p>
        )}
        <p className="text-xs text-zinc-400">{worksForWords(access.name, orchestratorName, access.reports.length)}</p>
        {moved && (
          <UndoLine busy={busy} onUndo={() => void save({ orchestrator_id: moved.from }).then(() => setMoved(null))}>
            {moved.to ? `Now works for ${options.find((o) => o.value === moved.to)?.label ?? 'its new orchestrator'}.` : 'Now at the top.'}
          </UndoLine>
        )}
        {access.reports.length > 0 && (
          <p className="text-sm text-zinc-300">
            Directs{' '}
            {access.reports.map((report, index) => (
              <span key={report.id}>
                {index > 0 && (index === access.reports.length - 1 ? ' and ' : ', ')}
                <Link href={`/ai/agents/${report.id}?tab=access`} className="font-medium text-brand-300 hover:text-brand-200">{report.name}</Link>
              </span>
            ))}
            .
          </p>
        )}
        {access.orchestrator && (
          <Toggle
            checked={!access.reachable_directly}
            onChange={(only) => void save({ reachable_directly: !only })}
            disabled={!access.can_manage || busy}
            label={`Only through ${access.orchestrator.name}`}
            description={`People hand ${access.name} work by asking ${access.orchestrator.name}, never directly.`}
            size="sm"
          />
        )}
        {access.orchestrator && (
          <Toggle
            checked={access.ask_people_directly}
            onChange={(direct) => void save({ ask_people_directly: direct })}
            disabled={!access.can_manage || busy}
            label="Asks people directly"
            description={`Off: ${access.name} brings its questions to ${access.orchestrator.name} first, who asks a person only when it has to.`}
            size="sm"
          />
        )}
        <Toggle
          checked={access.ask_first}
          onChange={(ask) => void save({ ask_first: ask })}
          disabled={!access.can_manage || busy}
          label="Ask first"
          description={`Before ${access.name} takes work from someone who does not manage it, its managers approve once.`}
          size="sm"
        />
      </div>
    </Card>
  );
}

/** Who can use it: a picker of Everyone, roles, groups and people, an Except list, saved with the bar. */
function WhoCanUseCard({ access }: { access: AgentAccessView }) {
  const { isDemoMode } = useDemo();
  const { team } = useApp();
  const groups = useRead(allGroupsRead(isDemoMode)).data ?? [];
  // Everyone is no include at all (an empty list); the picker shows it as Everyone.
  const saved = useMemo(() => {
    const lists = audienceLists(access.audience);
    return { include: lists.include.filter((v) => v !== 'everyone'), exclude: lists.exclude };
  }, [access.audience]);
  const [draft, setDraft] = useState<{ include: string[]; exclude: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const dirty = !!draft && (JSON.stringify(draft.include) !== JSON.stringify(saved.include) || JSON.stringify(draft.exclude) !== JSON.stringify(saved.exclude));
  const read = agentAccessRead(access.agent_id, isDemoMode);
  const people = team.filter((m) => m.role !== 'agent' && m.status !== 'suspended').sort((a, b) => a.name.localeCompare(b.name));
  const subjects = [
    ...ROLE_OPTIONS,
    ...groups.map((g) => ({ value: `group:${g.id}`, label: groupTargetLabel(g.name) })),
    ...people.map((p) => ({ value: `member:${p.id}`, label: p.name })),
  ];
  // A saved subject the lists do not hold any more (a suspended person) stays named.
  const named = new Map(access.audience.map((e) => [e.kind === 'everyone' ? 'everyone' : `${e.kind}:${e.ref}`, e.name]));
  const withSaved = (list: { value: string; label: string }[], values: string[]) => [
    ...list, ...values.filter((v) => v !== 'everyone' && !list.some((o) => o.value === v)).map((v) => ({ value: v, label: named.get(v) ?? 'Someone' })),
  ];

  const save = async () => {
    const audience = audienceFromLists(value.include, value.exclude);
    if (demoStops(isDemoMode)) { setDraft(null); return; }
    setBusy(true);
    try {
      const next = await workspaceApi<AgentAccessView>(`/api/workspace/agents/${encodeURIComponent(access.agent_id)}/access`, { method: 'PUT', body: { audience: audience.map(({ kind, ref, effect }) => ({ kind, ...(ref ? { ref } : {}), effect })) } });
      setReadData(read, () => next);
      setDraft(null);
      toast('success', 'Saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Who can use it"
      icon={<Users />}
      id="access-audience"
      afterTitle={<span className="text-xs font-normal text-zinc-400">{access.people_words}</span>}
      bodyClassName="px-4 lg:px-5"
    >
      <div className="space-y-4 pb-4 lg:pb-5">
        {access.can_manage ? (
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <MultiSelect
              label="Can use it"
              value={value.include.length ? value.include : ['everyone']}
              onChange={(include) => setDraft({ ...value, include: pickIncludes(value.include, include) })}
              options={withSaved([{ value: 'everyone', label: 'Everyone' }, ...subjects], value.include)}
              searchable
              placeholder="Everyone"
            />
            <MultiSelect
              label="Except"
              value={value.exclude}
              onChange={(exclude) => setDraft({ ...value, exclude })}
              options={withSaved(subjects, value.exclude)}
              searchable
              placeholder="Nobody"
            />
          </div>
        ) : (
          <p className="text-sm text-zinc-200">{access.audience_summary.words}</p>
        )}
        {access.inherited_words && (
          <p className="rounded-lg bg-white/[0.04] px-3.5 py-2.5 text-sm text-zinc-300">{access.inherited_words} Nobody outside that can use it, whatever is picked here.</p>
        )}
      </div>
      <SaveBar dirty={dirty} saving={busy} onDiscard={() => setDraft(null)} onSave={() => void save()} placement="panel" message="Who can use it is not saved" />
    </Card>
  );
}
