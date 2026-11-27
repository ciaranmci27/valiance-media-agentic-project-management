/**
 * What to restore first when several records went to Trash together: a
 * parent before its children, so a subtask never waits on a parent that is
 * not back yet. Keeps the order otherwise.
 */
export function restoreOrder<T extends { id: string; parentId?: string | null }>(items: T[]): T[] {
  const ids = new Set(items.map((item) => item.id));
  const first = items.filter((item) => !item.parentId || !ids.has(item.parentId));
  const after = items.filter((item) => item.parentId && ids.has(item.parentId));
  return [...first, ...after];
}
