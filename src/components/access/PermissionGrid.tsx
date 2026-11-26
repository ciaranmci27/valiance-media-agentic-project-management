'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Check, Lock, Minus, Search } from 'lucide-react';
import type { PermissionKey } from '@/lib/access-control';
import {
  GRID_LEVEL_LABELS, GRID_LEVELS, gridToScopes, grantableSet, scopeLock, scopesToGrid, setCell, togglePower, toggleCell,
  type GrantLimits, type GridArea, type GridCell, type GridLevel, type PermissionGridState,
} from '@/lib/permission-grid';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * The one way to pick what someone or something may do (DESIGN.md Rule 10):
 * a row per area, columns View, View all and Manage, then the special powers
 * as a short list with one plain sentence each. All logic is in
 * src/lib/permission-grid.ts; this only draws it.
 *
 * - A column title picks the whole column, as far as this person may give.
 * - A cell this person cannot give is locked, with the reason in a Tooltip.
 *   Turning off is always allowed, so a held locked cell stays clickable.
 * - A cell holding some of its permissions shows as indeterminate.
 * - Over `searchFrom` areas a search box filters the rows.
 * - On phones each area is a row of three labelled boxes.
 *
 * Controlled: `value` is the scopes held, `onChange` gets the new scopes
 * (unknown scopes in `value` are kept). Pass `limits` (the holder and the
 * editor) to derive what is grantable and why not, or `grantable` and
 * `lockedReason` directly.
 */

export interface PermissionGridProps {
  /** The scopes (or permissions) held now. */
  value: readonly string[];
  onChange?: (next: string[]) => void;
  /** Who is giving to whom: derives `grantable` and `lockedReason`. */
  limits?: GrantLimits;
  /** What may be turned on; null or left out: everything. */
  grantable?: ReadonlySet<string> | null;
  /** Why a permission cannot be turned on, in plain words. */
  lockedReason?: (key: PermissionKey) => string | null;
  /** Shows what is held without changing it. */
  readOnly?: boolean;
  /** Names the grid for screen readers ("What Nova may do"). */
  label: string;
  /** Hide areas (a module that is off). */
  isAreaVisible?: (area: GridArea) => boolean;
  /** Show the search box from this many areas. */
  searchFrom?: number;
  /** Leave the special powers out. */
  hidePowers?: boolean;
}

interface CellView {
  cell: GridCell;
  /** Some key in it can be turned on. */
  canAdd: boolean;
  /** Clicking it would do nothing. */
  disabled: boolean;
  /** Each locked key and why, for the tooltip. */
  locks: { label: string; reason: string }[];
}

export function PermissionGrid({
  value,
  onChange,
  limits,
  grantable: grantableProp,
  lockedReason: lockedReasonProp,
  readOnly = false,
  label,
  isAreaVisible,
  searchFrom = 12,
  hidePowers = false,
}: PermissionGridProps) {
  const uid = useId();
  const [query, setQuery] = useState('');
  const grid = useMemo(() => scopesToGrid(value), [value]);

  const grantable = useMemo<ReadonlySet<string> | null>(
    () => (limits ? grantableSet(limits) : grantableProp ?? null),
    [limits, grantableProp],
  );
  const reasonOf = useMemo(
    () => (key: PermissionKey): string | null => {
      if (limits) return scopeLock(key, limits)?.reason ?? null;
      if (lockedReasonProp) return lockedReasonProp(key);
      return grantable && !grantable.has(key) ? "You can't give this here." : null;
    },
    [limits, lockedReasonProp, grantable],
  );
  const may = (key: string) => !grantable || grantable.has(key);

  const viewOf = (cell: GridCell): CellView => {
    const locks = cell.keys.filter((key) => !may(key)).map((key) => ({ label: labelOf(cell, key), reason: reasonOf(key) ?? "You can't give this here." }));
    const canAdd = cell.keys.some((key) => !cell.held.includes(key) && may(key));
    return { cell, canAdd, locks, disabled: readOnly || (cell.state === 'off' && !canAdd) };
  };

  const emit = (next: PermissionGridState) => onChange?.(gridToScopes(next));

  const areas = grid.areas.filter((area) => Object.keys(area.cells).length > 0 && (!isAreaVisible || isAreaVisible(area)));
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? areas.filter((area) => area.label.toLowerCase().includes(needle)
      || Object.values(area.cells).some((cell) => cell!.label.toLowerCase().includes(needle)))
    : areas;

  /** A column's state over the cells this person may change. */
  const columnState = (level: GridLevel) => {
    const cells = areas.map((area) => area.cells[level]).filter((cell): cell is GridCell => !!cell && cell.keys.some(may));
    const on = cells.filter((cell) => cell.keys.filter(may).every((key) => cell.held.includes(key))).length;
    const any = cells.some((cell) => cell.held.length > 0);
    return { cells, all: cells.length > 0 && on === cells.length, some: any };
  };

  const toggleColumn = (level: GridLevel) => {
    const { cells, all } = columnState(level);
    let next = grid;
    // Only cells this person may give: a column click never clears what they could not put back.
    for (const cell of cells) next = setCell(next, cell.area, level, !all, grantable);
    emit(next);
  };

  const showSearch = areas.length > searchFrom;
  const levelHeaderId = (level: GridLevel) => `${uid}-col-${level}`;

  return (
    <div className="max-w-xl space-y-5" role="group" aria-label={label}>
      {showSearch && (
        <div className="sm:max-w-xs">
          <TextInput type="search" aria-label="Search areas" placeholder="Search areas" value={query} onChange={setQuery} leftIcon={Search} />
        </div>
      )}

      {/* Desktop and tablet: a table with selectable column titles. */}
      <div className="hidden overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.06] sm:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-zinc-400">Area</th>
              {GRID_LEVELS.map((level) => {
                const col = columnState(level);
                return (
                  <th key={level} scope="col" id={levelHeaderId(level)} className="w-24 px-2 py-2.5 text-center text-xs font-medium text-zinc-400">
                    {readOnly || col.cells.length === 0 ? (
                      GRID_LEVEL_LABELS[level]
                    ) : (
                      <Tooltip content={col.all ? `Clear ${GRID_LEVEL_LABELS[level]} on every area` : `Give ${GRID_LEVEL_LABELS[level]} on every area you can`}>
                        <span className="inline-flex items-center justify-center gap-2">
                          <Checkbox
                            size="sm"
                            checked={col.all}
                            indeterminate={!col.all && col.some}
                            onChange={() => toggleColumn(level)}
                            ariaLabel={`${GRID_LEVEL_LABELS[level]}: select the whole column`}
                          />
                          <span aria-hidden="true">{GRID_LEVEL_LABELS[level]}</span>
                        </span>
                      </Tooltip>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {shown.map((area) => (
              <tr key={area.id}>
                <th scope="row" className="px-4 py-2.5 text-left font-medium text-zinc-200">{area.label}</th>
                {GRID_LEVELS.map((level) => (
                  <td key={level} className="px-2 py-2 text-center">
                    {area.cells[level]
                      ? <GridCellControl view={viewOf(area.cells[level]!)} area={area} readOnly={readOnly} onToggle={() => emit(toggleCell(grid, area.id, level, grantable))} />
                      : <span className="sr-only">Not available</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <EmptyState variant="filtered" compact title="No area matches" description={`Nothing is called "${query.trim()}".`} onClearFilters={() => setQuery('')} />}
      </div>

      {/* Phones: one row per area, three labelled boxes. */}
      <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.06] sm:hidden" aria-label={label}>
        {shown.map((area) => (
          <li key={area.id} className="px-4 py-3">
            <p className="text-sm font-medium text-zinc-200">{area.label}</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {GRID_LEVELS.map((level) => (
                <div key={level} className="flex items-center gap-1.5 text-xs text-zinc-400">
                  {area.cells[level] ? (
                    <>
                      <GridCellControl view={viewOf(area.cells[level]!)} area={area} readOnly={readOnly} onToggle={() => emit(toggleCell(grid, area.id, level, grantable))} />
                      <span aria-hidden="true">{GRID_LEVEL_LABELS[level]}</span>
                    </>
                  ) : <span className="sr-only">{GRID_LEVEL_LABELS[level]}: not available</span>}
                </div>
              ))}
            </div>
          </li>
        ))}
        {shown.length === 0 && (
          <li><EmptyState variant="filtered" compact title="No area matches" onClearFilters={() => setQuery('')} /></li>
        )}
      </ul>

      {!hidePowers && grid.powers.length > 0 && (
        <section aria-labelledby={`${uid}-powers`}>
          <h3 id={`${uid}-powers`} className="text-sm font-semibold text-white">Special powers</h3>
          <p className="mt-0.5 text-xs text-zinc-400">Things that reach beyond one area.</p>
          <ul className="mt-3 divide-y divide-white/[0.05] overflow-hidden rounded-xl ring-1 ring-inset ring-white/[0.06]">
            {grid.powers.map((power) => {
              const locked = !may(power.key);
              const reason = locked ? reasonOf(power.key) ?? "You can't give this here." : null;
              const disabled = readOnly || (locked && !power.held);
              const row = (
                <li key={power.key} className="flex items-start gap-3 px-4 py-3">
                  {readOnly ? (
                    <ReadOnlyMark state={power.held ? 'on' : 'off'} label={power.label} />
                  ) : (
                    <Checkbox
                      size="sm"
                      checked={power.held}
                      disabled={disabled}
                      onChange={() => emit(togglePower(grid, power.key, grantable))}
                      ariaLabel={power.label}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-200">
                      {power.label}
                      {locked && <Lock size={12} className="text-zinc-500" aria-hidden="true" />}
                    </p>
                    {power.description && <p className="mt-0.5 text-xs text-zinc-400">{power.description}</p>}
                    {reason && <p className="mt-0.5 text-xs text-zinc-500">{reason}</p>}
                  </div>
                </li>
              );
              return row;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function labelOf(cell: GridCell, key: PermissionKey): string {
  const labels = cell.label.split(', ');
  return labels[cell.keys.indexOf(key)] ?? key;
}

/** One cell: a box (indeterminate when partial), locked with its reason, or a mark when read-only. */
function GridCellControl({ view, area, readOnly, onToggle }: {
  view: CellView;
  area: GridArea;
  readOnly: boolean;
  onToggle: () => void;
}) {
  const { cell, locks, disabled } = view;
  const name = `${area.label}: ${GRID_LEVEL_LABELS[cell.level]}`;
  const lockedAll = locks.length === cell.keys.length;
  const tip: ReactNode = (
    <span className="block max-w-xs whitespace-normal text-left">
      <span className="block text-zinc-100">{cell.label}</span>
      {locks.map((lock) => (
        <span key={lock.label} className="mt-1 block text-zinc-400">
          {locks.length > 1 || !lockedAll ? `${lock.label}: ` : ''}{lock.reason}
        </span>
      ))}
    </span>
  );

  if (readOnly) {
    return (
      <Tooltip content={tip}>
        <span className="inline-flex"><ReadOnlyMark state={cell.state} label={name} /></span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={tip}>
      <span className="inline-flex items-center gap-1">
        <Checkbox
          size="sm"
          checked={cell.state === 'on'}
          indeterminate={cell.state === 'partial'}
          disabled={disabled}
          onChange={onToggle}
          ariaLabel={locks.length ? `${name}, ${lockedAll ? 'locked' : 'partly locked'}` : name}
        />
        {lockedAll && cell.state === 'off' && <Lock size={10} className="text-zinc-500" aria-hidden="true" />}
      </span>
    </Tooltip>
  );
}

function ReadOnlyMark({ state, label }: { state: 'on' | 'partial' | 'off'; label: string }) {
  const words = state === 'on' ? 'yes' : state === 'partial' ? 'partly' : 'no';
  return (
    <span role="img" aria-label={`${label}: ${words}`} className={`inline-flex h-4 w-4 items-center justify-center rounded-[5px] ${state === 'off' ? 'bg-white/[0.04]' : 'bg-brand-500/[0.18] text-brand-300'}`}>
      {state === 'on' ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : state === 'partial' ? <Minus size={11} strokeWidth={3} aria-hidden="true" /> : null}
    </span>
  );
}
