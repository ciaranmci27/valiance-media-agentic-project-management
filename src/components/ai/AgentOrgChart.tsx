'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Network, Search } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { agentTreeRead, runningAgentRunsRead, useAgentWarmer } from '@/lib/reads';
import { agentPageHref, orgChartRows, orgChartSplit, orgPresence } from '@/lib/ai-home';
import type { AgentTreeNode } from '@/lib/api/agent-hierarchy';
import { useAgentRoster } from '@/components/agent/AgentRoster';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { ShowMore } from '@/components/ui/ShowMore';
import { TextInput } from '@/components/ui/inputs/TextInput';

/** Top-level branches shown at first; a branch always shows whole. */
const TOPS = 12;
/** A search box once the chart is this long. */
const SEARCH_FROM = 12;
/** Each level steps in this far (px), so a team reads under its orchestrator. */
const INDENT = 28;

/**
 * Company AI's org chart: every company agent, orchestrators first with the
 * agents they direct under them (any depth), agents without one at the top.
 * Each row: face with presence, name, what it does in a few words, what it is
 * doing now ("3 working now" when its runs say so), who can use it, and who
 * it directs. Personal assistants are not here (they live in Your assistant
 * and Setup). Rows open the agent's page. Built for a hundred: whole branches
 * page through "Show more", and a search keeps a match with its orchestrators.
 * Suspended agents wait in one collapsed row at the end ("Suspended agents
 * (4)"), unless one still heads an active team; a search still finds them.
 */
export function AgentOrgChart({ onHire }: { onHire?: () => void }) {
  const { isDemoMode } = useDemo();
  const tree = useRead(agentTreeRead(isDemoMode));
  const running = useRead(runningAgentRunsRead(isDemoMode));
  const { entries } = useAgentRoster();
  const warmAgent = useAgentWarmer();
  const [tops, setTops] = useState(TOPS);
  const [q, setQ] = useState('');
  const [showSuspended, setShowSuspended] = useState(false);

  const nodes = useMemo(() => tree.data?.agents ?? [], [tree.data]);
  const roster = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const runsBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of running.data?.runs ?? []) if (run.status === 'running') counts.set(run.agent_id, (counts.get(run.agent_id) ?? 0) + 1);
    return counts;
  }, [running.data]);
  const names = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);

  const needle = q.trim().toLowerCase();
  // Suspended agents wait in one collapsed row at the end; a search still finds them.
  const { chart, suspended } = useMemo(() => orgChartSplit(nodes), [nodes]);
  const { rows, tops: topCount } = useMemo(() => orgChartRows(needle ? nodes : chart, {
    topShown: needle ? undefined : tops,
    match: needle ? (n: AgentTreeNode) => `${n.name} ${n.title ?? ''}`.toLowerCase().includes(needle) : undefined,
  }), [nodes, chart, tops, needle]);
  const shownTops = rows.filter((n) => n.depth === 0).length;

  const search = nodes.length >= SEARCH_FROM && (
    <div className="w-full sm:w-56">
      <TextInput type="search" aria-label="Search agents" placeholder="Search agents" value={q} onChange={setQ} leftIcon={Search} clearable size="sm" />
    </div>
  );

  let body;
  if (tree.failed && !tree.data) {
    body = <EmptyState variant="error" compact title="Could not load your agents" description="Check your connection and try again." onRetry={tree.reload} />;
  } else if (!tree.data) {
    body = (
      <ul className="divide-y divide-white/[0.06]" aria-busy="true">
        <span className="sr-only" role="status">Loading agents</span>
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3 lg:px-5" aria-hidden="true">
            <span className="h-8 w-8 animate-pulse rounded-full bg-white/[0.05] motion-reduce:animate-none" />
            <span className="h-3 w-40 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
          </li>
        ))}
      </ul>
    );
  } else if (nodes.length === 0) {
    body = (
      <EmptyState compact icon={<Network />} title="No company agents yet"
        description="Hire one to take on work for the team. Start with an orchestrator: it hands work to the agents you add under it."
        action={onHire ? <Button size="sm" onClick={onHire}>Hire an agent</Button> : undefined} />
    );
  } else if (rows.length === 0) {
    body = <EmptyState variant="filtered" compact title="No agent matches" description={`Nothing named "${q.trim()}".`} onClearFilters={() => setQ('')} />;
  } else {
    body = (
      <>
        <ul className="divide-y divide-white/[0.06]">
          {rows.map((node) => renderRow(node))}
        </ul>
        {!needle && <ShowMore shown={shownTops} total={topCount} step={TOPS} onMore={() => setTops(tops + TOPS)} noun="teams" className="border-t border-white/[0.06]" />}
        {!needle && suspended.length > 0 && (
          <div className="border-t border-white/[0.06]">
            <div className="px-4 py-2 lg:px-5">
              <Button size="sm" variant="ghost" aria-expanded={showSuspended} aria-controls="org-chart-suspended" onClick={() => setShowSuspended(!showSuspended)}
                icon={<ChevronRight size={14} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${showSuspended ? 'rotate-90' : ''}`} />}>
                Suspended agents ({suspended.length})
              </Button>
            </div>
            {showSuspended && (
              <ul id="org-chart-suspended" className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                {suspended.map((node) => renderRow(node, 0))}
              </ul>
            )}
          </div>
        )}
      </>
    );
  }

  function renderRow(node: AgentTreeNode, depth: number = node.depth) {
    const entry = roster.get(node.id);
    const runs = runsBy.get(node.id) ?? 0;
    // An agent the roster has not loaded reads from the chart's own status.
    const known = entry?.presence ?? (node.status === 'suspended' ? 'suspended' : 'idle');
    const presence = orgPresence(known, runs);
    // The face's dot agrees with the words: running work reads as working.
    const dot = known === 'paused' || known === 'suspended' ? known : runs > 0 ? 'working' : known;
    const reports = node.report_ids.map((id) => names.get(id)).filter(Boolean) as string[];
    return (
      <li key={node.id}>
        <Link
          href={agentPageHref(node.id)}
          {...warmAgent(node.id)}
          className="flex items-start gap-3 py-3 pr-4 transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 lg:pr-5"
          style={{ paddingLeft: `calc(1rem + ${depth * INDENT}px)` }}
        >
          <AgentAvatar id={node.id} name={node.name} src={node.avatar_url ?? entry?.avatar ?? null} presence={dot} label={presence.label} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-sm font-medium text-white">{node.name}</span>
              {reports.length > 0 && <Pill tone="info">Orchestrator</Pill>}
              <Pill tone={presence.tone} dot>{presence.label}</Pill>
            </p>
            {node.title && <p className="mt-0.5 truncate text-xs text-zinc-400">{node.title}</p>}
            <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-1.5 text-xs text-zinc-500">
              <span>Who can use it: <span className="text-zinc-300">{node.audience_summary.words}</span></span>
              {reports.length > 0 && <><span aria-hidden="true">·</span><span className="truncate">Directs {reports.join(', ')}</span></>}
              {node.depth > 0 && !node.reachable_directly && <><span aria-hidden="true">·</span><span>Only through {names.get(node.orchestrator_id ?? '') ?? 'its orchestrator'}</span></>}
              {node.ask_first && <><span aria-hidden="true">·</span><span>Asks a manager first</span></>}
            </p>
          </div>
        </Link>
      </li>
    );
  }

  return (
    <Card
      title="Your agents"
      icon={<Network />}
      id="company-agents"
      // The agents in the tree; the folded suspended ones count on their own row.
      afterTitle={chart.length > 0 ? <span className="text-xs font-normal tabular-nums text-zinc-500">{chart.length}</span> : undefined}
      description="Orchestrators take the work and hand it to the agents under them. People only answer real decisions."
      action={search || undefined}
      bodyClassName="pb-1"
    >
      {body}
    </Card>
  );
}
