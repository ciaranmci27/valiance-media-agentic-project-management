'use client';

import { useMemo, useState } from 'react';
import { Layers, Search } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { formatMoney, formatNumber } from '@/lib/format';
import { showMoreLabel } from '@/lib/agents-ui';
import {
  ESTIMATE_LABEL, MIXED_LABEL, NO_LABEL, UNSPLIT_MODEL, breakdown, costLabel, costText, marginOf, metricValue, rankRows, successRate,
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

const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'agent', label: 'Agents' },
  { key: 'project', label: 'Projects' },
  { key: 'model', label: 'Models' },
  { key: 'role', label: 'Roles' },
  { key: 'label', label: 'Labels' },
];

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
      render: (g) => {
        const rate = successRate(g.sums);
        return <>{formatNumber(g.sums.run)}{rate !== null && <span className="block text-[11px] text-zinc-500">{fmtPct(rate)} ok</span>}</>;
      },
    },
    busy: { key: 'busy', label: 'Busy time', metric: 'busy', has: (g) => g.sums.busyMs > 0, render: (g) => (g.sums.busyMs > 0 ? fmtDuration(g.sums.busyMs) : muted('0')) },
    tokens: {
      key: 'tokens', label: 'Tokens', metric: 'tokens', has: (g) => g.sums.tokensIn + g.sums.tokensOut > 0,
      render: (g) => (g.sums.tokensIn + g.sums.tokensOut > 0
        ? <>{fmtCount(g.sums.tokensIn + g.sums.tokensOut)}<span className="block text-[11px] text-zinc-500">{fmtCount(g.sums.tokensIn)} in · {fmtCount(g.sums.tokensOut)} out</span></>
        : muted('0')),
    },
    tokensIn: { key: 'tokensIn', label: 'Tokens in', metric: 'tokens', has: (g) => g.sums.tokensIn > 0, render: (g) => fmtCount(g.sums.tokensIn) },
    tokensOut: { key: 'tokensOut', label: 'Tokens out', has: (g) => g.sums.tokensOut > 0, render: (g) => fmtCount(g.sums.tokensOut) },
    cost: {
      key: 'cost', label: 'Model cost', metric: 'cost', has: (g) => costLabel(g.sums).kind !== 'none',
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
    revenue: { key: 'revenue', label: 'Revenue', metric: 'revenue', has: () => showMoney, render: (g) => <span className="text-emerald-300">{formatMoney(g.sums.revenue)}</span> },
    profit: {
      key: 'profit', label: 'Profit', metric: 'profit', has: () => showMoney,
      render: (g) => {
        const profit = metricValue('profit', g.sums);
        const margin = marginOf(g.sums);
        return <><span className={profit < 0 ? 'text-red-300' : 'text-emerald-300'}>{formatMoney(profit)}</span>{margin !== null && <span className="block text-[11px] text-zinc-500">{fmtPct(margin)} margin</span>}</>;
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
  const gridCols = `minmax(0,1fr) repeat(${shownColumns.length}, minmax(5.5rem, auto))`;

  const pick = (next: Dimension) => {
    setDimension(next);
    setSearch('');
    setPages(1);
  };

  // Agents and labels focus the page on the row; the No label row does not.
  const focusableRow = (row: BreakdownRow) => dimension === 'agent' || (dimension === 'label' && row.key !== '');
  const isFocused = (row: BreakdownRow) => (dimension === 'agent' ? focusedAgentId === row.key : dimension === 'label' && focusedLabel === row.key);
  const focusRow = (row: BreakdownRow) => (dimension === 'agent' ? onFocusAgent(row.key) : onFocusLabel(row.key));
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
    <section className="glass-card rounded-xl overflow-hidden" aria-label="Breakdown">
      <div className="px-5 pt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h2 className="font-semibold text-white">Breakdown</h2>
          {metricLabel && <span className="text-xs text-zinc-500 truncate">Ranked by {rankBy === metric ? metricLabel.toLowerCase() : 'runs'}</span>}
        </div>
        <div role="tablist" aria-label="Break down by" className="flex overflow-x-auto -mx-2 sm:mx-0 scrollbar-none">
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={dimension === d.key}
              onClick={() => pick(d.key)}
              className={`relative whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${dimension === d.key ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {d.label}
              <span aria-hidden="true" className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full ${dimension === d.key ? 'bg-brand-400' : 'bg-transparent'}`} />
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" aria-label={`By ${DIMENSIONS.find((d) => d.key === dimension)?.label.toLowerCase()}`}>
        {dimension === 'model' && !loading && all.length > 0 && (
          <p className="px-5 pt-3 text-[11px] text-zinc-500">
            Cost shows where the provider sends a price. Usage on a subscription, or with no price, shows its tokens and reads as unpriced, never as $0.
            {unsplitShown && ' Usage the server summed per hour before models were kept has no model, and its cost is priced or mixed.'}
            {subscriptionLine && ` ${subscriptionLine}: ${ESTIMATE_LABEL}.`}
          </p>
        )}
        {dimension === 'label' && !loading && all.length > 0 && (
          <p className="px-5 pt-3 text-[11px] text-zinc-500">
            Labels come from the agents and their harnesses. An event with several labels counts on each of its rows, so rows can add up to more than the total. Select a label to focus the page on it.
          </p>
        )}
        {dimension === 'project' && showMoney && projectCaveat && !loading && (
          <p className="px-5 pt-3 text-[11px] text-zinc-500">Profit on project rows: {projectCaveat.charAt(0).toLowerCase() + projectCaveat.slice(1)}.</p>
        )}
        {all.length > PAGE && (
          <div className="px-5 pt-3 w-full sm:w-72">
            <TextInput
              type="search"
              size="sm"
              aria-label={`Search ${DIMENSIONS.find((d) => d.key === dimension)?.label.toLowerCase()}`}
              placeholder={`Search ${DIMENSIONS.find((d) => d.key === dimension)?.label.toLowerCase()}`}
              value={search}
              onChange={(v) => { setSearch(v); setPages(1); }}
              leftIcon={Search}
              clearable
            />
          </div>
        )}

        {loading ? (
          <div className="p-5 space-y-3" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-8 w-full rounded bg-white/[0.05] motion-safe:animate-pulse" />)}
          </div>
        ) : ranked.rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-zinc-500 text-center">
            {search ? 'Nothing matches that search.' : 'Nothing measured in this selection yet.'}
          </p>
        ) : (
          <>
            {/* Desktop: a ranked table. */}
            <div className="hidden md:block mt-1">
              <div className="grid gap-x-5 px-5 py-2.5 text-[10px] uppercase tracking-wider font-medium text-zinc-500 border-b border-white/[0.06]"
                style={{ gridTemplateColumns: gridCols }}>
                <span>{DIMENSIONS.find((d) => d.key === dimension)?.label.replace(/s$/, '')}</span>
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
                  const rowClass = 'grid gap-x-5 px-5 py-3 items-center w-full text-left';
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
            <ul className="md:hidden divide-y divide-white/[0.06]">
              {ranked.rows.map((row) => {
                const focusable = focusableRow(row);
                const focused = focusable && isFocused(row);
                const body = (
                  <>
                    {rowName(row)}
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {shownColumns.map((c) => (
                        <div key={c.key} className="flex items-baseline justify-between gap-2 min-w-0">
                          <dt className={`text-[11px] truncate ${c.metric === rankBy ? 'text-brand-300' : 'text-zinc-500'}`}>{c.label}</dt>
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

        {!loading && (ranked.more > 0 || dimension === 'agent' || (dimension === 'label' && !!focusedLabel)) && (
          <div className="px-5 py-3 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
            <span className="text-[11px] text-zinc-500">
              {dimension === 'agent' ? (focusedAgentId ? 'Select the agent again to see everyone.' : 'Select an agent to focus the page on it.')
                : dimension === 'label' && focusedLabel ? 'Select the label again to see everything.' : ''}
            </span>
            {ranked.more > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(ranked.more, PAGE)}</Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
