'use client';

import { useState, useMemo, type ReactNode } from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';

export interface Column<T> {
  /** Stable key, also used as the sort key. */
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Extra classes applied to BOTH the header cell and body cells (e.g. responsive hiding). */
  className?: string;
  /** If provided, the column is sortable and this returns the comparable value. */
  sortValue?: (row: T) => string | number;
  /** Fixed width, e.g. "w-12". */
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  /** Mouse convenience: clicking a row/card runs this (keyboard users use the link in the primary cell). */
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Sticks the header below the app header (top-16). Default false — sticky is
   *  unreliable inside the horizontal-scroll wrapper, so it's opt-in only. */
  stickyHeader?: boolean;
  className?: string;
  /**
   * Renders each row as a card on small screens (<md). When provided, the table
   * is hidden below md and this stack of cards shows instead. Strongly recommended
   * so mobile users get a readable layout instead of a horizontally-scrolling table.
   */
  mobileCard?: (row: T) => ReactNode;
  /**
   * Uses `table-fixed` so column widths come from each column's `width` (not content).
   * Set this on grouped pages that render several sibling tables so their columns
   * line up across every table. Pair it with a `width` on each column.
   */
  fixedLayout?: boolean;
}

const alignClass = (align?: Column<unknown>['align']) =>
  align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyState,
  initialSort,
  stickyHeader = false,
  className = '',
  mobileCard,
  fixedLayout = false,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return data;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return data;
    const getVal = col.sortValue;
    return [...data].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [data, sort, columns]);

  const toggleSort = (key: string) => {
    setSort(prev => {
      if (prev?.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click clears sort
    });
  };

  const emptyContent = emptyState ?? 'No results';

  return (
    <>
      {/* Mobile: stacked cards */}
      {mobileCard && (
        <div className="md:hidden space-y-3">
          {sorted.length === 0 ? (
            <div className="glass-card rounded-xl px-4 py-10 text-center text-sm text-zinc-400">
              {emptyContent}
            </div>
          ) : (
            sorted.map((row) => (
              <div
                key={keyExtractor(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {mobileCard(row)}
              </div>
            ))
          )}
        </div>
      )}

      {/* Desktop (md+): table. If no mobileCard is supplied, the table shows on all sizes. */}
      <div className={`${mobileCard ? 'hidden md:block' : ''} glass-card rounded-xl overflow-hidden ${className}`}>
        <div className="overflow-x-auto">
          <table className={`w-full border-collapse text-left ${fixedLayout ? 'table-fixed' : ''}`}>
            <thead>
              <tr className={`bg-surface-overlay border-b border-white/[0.08] ${stickyHeader ? 'sticky top-16 z-10' : ''}`}>
                {columns.map((col) => {
                  const isSorted = sort?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      className={`px-4 py-3 text-xs font-semibold text-zinc-400 uppercase tracking-wider whitespace-nowrap ${alignClass(col.align)} ${col.width ?? ''} ${col.className ?? ''}`}
                    >
                      {col.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className={`inline-flex items-center gap-1 hover:text-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
                        >
                          {col.header}
                          {isSorted ? (
                            sort!.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                          ) : (
                            <ChevronsUpDown size={12} className="text-zinc-600" />
                          )}
                        </button>
                      ) : (
                        col.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-12 text-center text-sm text-zinc-400">
                    {emptyContent}
                  </td>
                </tr>
              ) : (
                sorted.map((row) => (
                  <tr
                    key={keyExtractor(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`border-b border-white/[0.05] last:border-0 transition-colors ${onRowClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 text-sm text-zinc-300 align-middle ${alignClass(col.align)} ${col.className ?? ''}`}
                      >
                        {col.render(row)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
