'use client';

import { useMemo, useState } from 'react';
import { Layers, Search } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { ShowMore } from '@/components/ui/ShowMore';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  ESTIMATE_LABEL, MIXED_LABEL, NO_LABEL, UNSPLIT_MODEL, breakdown, costLabel, costText, marginOf, metricValue, rankRows, runOutcomeLine,
  type BreakdownLabels, type BreakdownRow, type Dimension, type Fact, type Group, type MetricKey,
} from '@/lib/agent-analytics-model';
import { fmtCount, fmtDuration, fmtPct } from '@/components/agent/analytics/shared';

/**
 * The Analytics tab's breakdown: the same facts split by agent, project,
 * model, role or label, ranked by the metric the selected tile charts. A
 * window of rows with search and "Show 10 more", so a hundred agents stay one
 * card. Every row adds up to the tiles above (agent-analytics-model), except
 * labels: an event with two labels counts on both rows, as the tab says.
 */

const PAGE = 10;

const DIMENSIONS: { key: Dimension; label: string; noun: string }[] = [
  { key: 'agent', label: 'Agent', noun: 'agent' },
  { key: 'project', label: 'Project', noun: 'project' },
  { key: 'model', label: 'Model', noun: 'model' },
  { key: 'role', label: 'Role', noun: 'role' },
  { key: 'label', label: 'Label', noun: 'label' },
];
const PLURAL: Record<Dimension, string> = { agent: 'agents', project: 'projects', model: 'models', role: 'roles', label: 'labels' };

type ColumnKey = 'runs' | 'busy' | 'tokensIn' | 'tokensOut' | 'tokens' | 'cost' | 'tasks' | 'prs' | 'revenue' | 'profit';

interface Column {
  key: ColumnKey;
  label: string;
  /** The tile this column ranks with, so the selected tile's column stays. */
  metric?: MetricKey;
  has: (g: Group) => boolean;
  render: (g: Group) => React.ReactNode;
}

const muted = (text: string) => <span className="text-zinc-500">{text}</span>;

function columns(showMoney: boolean): Record<ColumnKey, Column> {
  return {
    runs: {
      key: 'runs', label: 'Runs', metric: 'runs', has: (g) => g.sums.run > 0,
      render: (g) => <>{formatNumber(g.sums.run)}<span className="block text-[11px] text-zinc-500">{runOutcomeLine(g.sums, true)}</span></>,
    },
    busy: { key: 'busy', label: 'Time working', metric: 'busy', has: (g) => g.sums.busyMs > 0, render: (g) => (g.sums.busyMs > 0 ? fmtDuration(g.sums.busyMs) : muted('0')) },
    tokens: {
      key: 'tokens', label: 'AI usage', metric: 'tokens', has: (g) => g.sums.tokensIn + g.sums.tokensOut > 0,
      render: (g) => (g.sums.tokensIn + g.sums.tokensOut > 0
        ? <>{fmtCount(g.sums.tokensIn + g.sums.tokensOut)}<span className="block text-[11px] text-zinc-500">tokens: {fmtCount(g.sums.tokensIn)} sent, {fmtCount(g.sums.tokensOut)} back</span></>
        : muted('0')),
    },
    tokensIn: { key: 'tokensIn', label: 'Tokens sent', metric: 'tokens', has: (g) => g.sums.tokensIn > 0, render: (g) => fmtCount(g.sums.tokensIn) },
    tokensOut: { key: 'tokensOut', label: 'Tokens back', has: (g) => g.sums.tokensOut > 0, render: (g) => fmtCount(g.sums.tokensOut) },
    cost: {
      key: 'cost', label: 'AI cost', metric: 'cost', has: (g) => costLabel(g.sums).kind !== 'none',
      render: (g) => {
        const label = costLabel(g.sums);
        const text = costText(label, formatMoney);
        if (!text) return muted('None');
        if (label.kind === 'unpriced') return <span className="text-xs text-zinc-400">Unpriced</span>;
        if (label.kind === 'mixed') return <>{formatMoney(label.usd)}<span className="block text-[11px] text-zinc-500">{MIXED_LABEL}</span></>;
        if (label.kind === 'partial') return <>{formatMoney(label.usd)}<span className="block text-[11px] text-zinc-500">+ unpriced</span></>;
        return text;
      },
    },
    tasks: { key: 'tasks', label: 'Tasks done', metric: 'tasks', has: (g) => g.sums.taskDone > 0, render: (g) => formatNumber(g.sums.taskDone) },
    prs: {
      key: 'prs', label: 'PRs merged', metric: 'prs', has: (g) => g.sums.prOpened + g.sums.prMerged + g.sums.review > 0,
      render: (g) => <>{formatNumber(g.sums.prMerged)}{g.sums.prOpened > 0 && <span className="block text-[11px] text-zinc-500">{g.sums.prOpened} opened</span>}</>,
    },
    revenue: { key: 'revenue', label: 'Revenue', metric: 'revenue', has: () => showMoney, render: (g) => formatMoney(g.sums.revenue) },
    profit: {
      key: 'profit', label: 'Profit', metric: 'profit', has: () => showMoney,
      render: (g) => {
        const profit = metricValue('profit', g.sums);
        const margin = marginOf(g.sums);
        return <>{formatMoney(profit)}{margin !== null && <span className="block text-[11px] text-zinc-500">{fmtPct(margin)} margin</span>}</>;
      },
    },
  };
}

/** The columns a dimension offers, in order. Models carry no money or task facts of their own. */
const LAYOUT: Record<Dimension, ColumnKey[]> = {
  agent: ['revenue', 'profit', 'runs', 'busy', 'tasks', 'prs', 'tokens', 'cost'],
  project: ['revenue', 'profit', 'runs', 'busy', 'tasks', 'prs', 'tokens', 'cost'],
  role: ['revenue', 'profit', 'runs', 'busy', 'tasks', 'prs', 'tokens', 'cost'],
  model: ['runs', 'busy', 'tokensIn', 'tokensOut', 'cost'],
  // Labels come from events: runs, tasks and time sit on the No label row.
  label: ['runs', 'tasks', 'prs', 'tokens', 'cost'],
};

export interface BreakdownEntity {
  avatar?: string | null;
  color?: string | null;
}

export function AnalyticsBreakdown({
  facts,
  totals,
  metric,
  metricLabel,
  showMoney,
  projectCaveat,
  labels,
  entity,
  loading,
  focusedAgentId,
  onFocusAgent,
  focusedLabel,
  onFocusLabel,
  subscriptionLine,
}: {
  facts: Fact[];
  totals: Group;
  metric: MetricKey | null;
  metricLabel: string | null;
  showMoney: boolean;
  /** What project rows' profit leaves out: usage with no project. */
  projectCaveat: string | null;
  labels: BreakdownLabels;
  entity: (dimension: Dimension, key: string) => BreakdownEntity;
  loading: boolean;
  focusedAgentId: string | null;
  onFocusAgent: (agentId: string) => void;
  focusedLabel: string | null;
  onFocusLabel: (label: string) => void;
  /** A provider plan's estimate, said beside the model rows; null without plans. */
  subscriptionLine: string | null;
}) {
  const [dimension, setDimension] = useState<Dimension>('agent');
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState(1);

  const all = useMemo(() => breakdown(facts, dimension, labels), [facts, dimension, labels]);
  // Rank by the charted metric where this dimension can show it; runs otherwise.
  const cols = useMemo(() => columns(showMoney), [showMoney]);
  const layout = LAYOUT[dimension];
  const rankBy: MetricKey = metric && layout.some((k) => cols[k].metric === metric) ? metric : 'runs';
  const ranked = useMemo(() => rankRows(all, rankBy, { search, limit: pages * PAGE }), [all, rankBy, search, pages]);
  const shownColumns = layout.filter((key) => cols[key].has(totals) || cols[key].metric === rankBy).map((key) => cols[key]);
  const gridCols = `minmax(8rem,1fr) repeat(${shownColumns.length}, minmax(5.5rem, auto))`;

  const pick = (next: Dimension) => {
    setDimension(next);
    setSearch('');
    setPages(1);
  };

  // Agents and labels focus the page on the row; the No label row does not.
  const focusableRow = (row: BreakdownRow) => dimension === 'agent' || (dimension === 'label' && row.key !== '');
  const isFocused = (row: BreakdownRow) => (dimension === 'agent' ? focusedAgentId === row.key : dimension === 'label' && focusedLabel === row.key);
  const focusRow = (row: BreakdownRow) => (dimension === 'agent' ? onFocusAgent(row.key) : onFocusLabel(row.key));
  const dimensionNoun = PLURAL[dimension];
  const focusHint = dimension === 'agent' ? (focusedAgentId ? 'Select the agent again to see everyone' : 'Select an agent to focus the report on it')
    : dimension === 'label' ? (focusedLabel ? 'Select the label again to see everything' : 'Select a label to focus the report on it') : null;
  const unsplitShown = dimension === 'model' && all.some((row) => row.label === UNSPLIT_MODEL);

  const rowName = (row: BreakdownRow) => {
    const look = entity(dimension, row.key);
    return (
      <div className="flex items-center gap-2.5 min-w-0">
        {dimension === 'agent' && <Avatar name={row.label} src={look.avatar || undefined} size="sm" />}
        {dimension === 'project' && <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full flex-shrink-0 bg-white/[0.12]" style={look.color ? { backgroundColor: look.color } : undefined} />}
        <div className="min-w-0">
          <span className={`text-sm font-medium truncate block ${dimension === 'label' && row.key ? 'font-mono text-white' : row.label === NO_LABEL ? 'text-zinc-400' : 'text-white'}`}>{row.label}</span>
          {row.sublabel && <span className="text-[11px] text-zinc-500 truncate block">{row.sublabel}</span>}
        </div>
      </div>
    );
  };

  return (
    <section className="glass-card rounded-xl overflow-hidden" aria-labelledby="analytics-breakdown">
      <CardHeader
        id="analytics-breakdown"
        icon={<Layers />}
        title="Breakdown"
        afterTitle={metricLabel ? <span className="text-xs font-normal text-zinc-500 truncate">ranked by {rankBy === metric ? metricLabel.toLowerCase() : 'runs'}</span> : null}
        description={focusHint}
        action={(
          <>
            {all.length > PAGE && (
              <TextInput
                type="search"
                size="sm"
                aria-label={`Search ${dimensionNoun}`}
                placeholder={`Search ${dimensionNoun}`}
                value={search}
                onChange={(v) => { setSearch(v); setPages(1); }}
                leftIcon={Search}
                clearable
                className="w-44"
              />
            )}
            <Select size="sm" ariaLabel="Break down by" value={dimension} onChange={(v) => pick(v as Dimension)}
              options={DIMENSIONS.map((d) => ({ value: d.key, label: `By ${d.noun}` }))} />
          </>
        )}
      />

      <div>
        {dimension === 'model' && !loading && all.length > 0 && (
          <p className="px-4 lg:px-5 pt-3 text-[11px] text-zinc-500">
            Cost shows where the provider sends a price. Usage on a subscription, or with no price, shows its tokens and reads as unpriced, never as $0.
            {unsplitShown && ' Usage the server summed per hour before models were kept has no model, and its cost is priced or mixed.'}
            {subscriptionLine && ` ${subscriptionLine}: ${ESTIMATE_LABEL}.`}
          </p>
        )}
        {dimension === 'label' && !loading && all.length > 0 && (
          <p className="px-4 lg:px-5 pt-3 text-[11px] text-zinc-500">
            Labels come from the agents and their harnesses. An event with several labels counts on each of its rows, so rows can add up to more than the total.
          </p>
        )}
        {dimension === 'project' && showMoney && projectCaveat && !loading && (
          <p className="px-4 lg:px-5 pt-3 text-[11px] text-zinc-500">Profit on project rows: {projectCaveat.charAt(0).toLowerCase() + projectCaveat.slice(1)}.</p>
        )}
        {loading ? (
          <div className="px-4 pb-4 lg:px-5 space-y-3" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-8 w-full rounded bg-white/[0.05] motion-safe:animate-pulse" />)}
          </div>
        ) : ranked.rows.length === 0 ? (
          <div className="px-4 pb-4 lg:px-5">
            {search ? (
              <EmptyState compact variant="filtered" title="Nothing matches that search" onClearFilters={() => { setSearch(''); setPages(1); }} />
            ) : (
              <EmptyState compact title="Nothing measured here yet" description="Rows show here once your agents work in this range." />
            )}
          </div>
        ) : (
          <>
            {/* Desktop: a ranked table. */}
            <div className="hidden lg:block mt-1">
              <div className="grid gap-x-5 px-4 lg:px-5 py-2.5 text-xs font-medium text-zinc-500 border-b border-white/[0.06]"
                style={{ gridTemplateColumns: gridCols }}>
                <span>{DIMENSIONS.find((d) => d.key === dimension)?.label}</span>
                {shownColumns.map((c) => (
                  <span key={c.key} className={`text-right ${c.metric === rankBy ? 'text-brand-300' : ''}`}>{c.label}</span>
                ))}
              </div>
              <ul className="divide-y divide-white/[0.06]">
                {ranked.rows.map((row) => {
                  const focusable = focusableRow(row);
                  const focused = focusable && isFocused(row);
                  const cells = (
                    <>
                      {rowName(row)}
                      {shownColumns.map((c) => (
                        <span key={c.key} className="text-sm text-zinc-200 font-medium text-right tabular-nums">{c.render(row.group)}</span>
                      ))}
                    </>
                  );
                  const rowClass = 'grid gap-x-5 px-4 lg:px-5 py-3 items-center w-full text-left';
                  return (
                    <li key={row.key}>
                      {focusable ? (
                        <button
                          type="button"
                          aria-pressed={focused}
                          onClick={() => focusRow(row)}
                          className={`${rowClass} transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${focused ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.03]'}`}
                          style={{ gridTemplateColumns: gridCols }}
                        >
                          {cells}
                        </button>
                      ) : (
                        <div className={rowClass} style={{ gridTemplateColumns: gridCols }}>{cells}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Phones: each row as a label and value list. */}
            <ul className="lg:hidden divide-y divide-white/[0.06]">
              {ranked.rows.map((row) => {
                const focusable = focusableRow(row);
                const focused = focusable && isFocused(row);
                const body = (
                  <>
                    {rowName(row)}
                    <dl className="mt-2.5 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
                      {shownColumns.map((c) => (
                        <div key={c.key} className="flex items-baseline justify-between gap-2 min-w-0">
                          <dt className={`text-[11px] flex-shrink-0 whitespace-nowrap ${c.metric === rankBy ? 'text-brand-300' : 'text-zinc-500'}`}>{c.label}</dt>
                          <dd className="text-xs text-zinc-200 font-medium text-right tabular-nums">{c.render(row.group)}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                );
                return (
                  <li key={row.key}>
                    {focusable ? (
                      <button type="button" aria-pressed={focused} onClick={() => focusRow(row)}
                        className={`block w-full text-left p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${focused ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.03]'}`}>
                        {body}
                      </button>
                    ) : (
                      <div className="p-4">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {!loading && ranked.more > 0 && (
          <div className="border-t border-white/[0.06] px-4 py-2 lg:px-5">
            <ShowMore shown={ranked.rows.length} total={ranked.matched} step={PAGE} onMore={() => setPages(pages + 1)} noun={dimensionNoun} />
          </div>
        )}
      </div>
    </section>
  );
}
