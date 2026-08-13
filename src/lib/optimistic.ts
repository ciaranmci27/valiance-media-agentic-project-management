/**
 * Undo an optimistic change without discarding anything else.
 *
 * The natural rollback, `setTasks(prev)`, restores a snapshot taken before the
 * request was sent, so every row that changed while it was in flight is rolled
 * back too: realtime updates, edits made in another tab, rows someone else
 * deleted. A single failed write silently rewinds unrelated data, and the
 * stale values stay on screen until the next refetch.
 *
 * Restoring only the rows the mutation actually touched leaves everything else
 * at its newest value. `scope` has to be keyed on something the mutation does
 * not change (an id, a foreign key) so that it selects the same rows before
 * and after.
 */
export function rollbackScope<T extends { id: string }>(before: T[], scope: (row: T) => boolean) {
  const restored = new Map(before.filter(scope).map(row => [row.id, row] as const));
  // Updaters can run more than once for the same state, so this never mutates
  // anything it captured.
  return (current: T[]): T[] => {
    const pending = new Map(restored);
    const out: T[] = [];
    for (const row of current) {
      if (!scope(row)) {
        out.push(row);
        continue;
      }
      const original = pending.get(row.id);
      // In scope and present before: put the old version back in place. In
      // scope but new: it only ever existed optimistically, so drop it.
      if (original) {
        out.push(original);
        pending.delete(row.id);
      }
    }
    // Whatever the mutation optimistically removed comes back.
    for (const row of pending.values()) out.push(row);
    return out;
  };
}
