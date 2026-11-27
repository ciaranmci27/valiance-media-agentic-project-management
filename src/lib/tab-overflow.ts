/**
 * Which tabs of an underline tab row stay in the row when the row is too
 * narrow for them all (a phone, a narrow window); the rest go under More.
 * Pure, so scripts/verify-navigation.ts checks it alone.
 *
 * - Everything fits: every tab shows and there is no More.
 * - Otherwise: tabs in their order, as many as fit beside the More button,
 *   and the open tab always shows: when it would fall under More it takes
 *   the last place in the row, so the row never hides where you are.
 * - At least one tab always shows (the open one), however narrow.
 */
export function fitTabs({ widths, moreWidth, available, activeIndex, gap = 0 }: {
  /** Each tab's natural width, in order. */
  widths: readonly number[];
  /** The More button's width. */
  moreWidth: number;
  /** The row's width. */
  available: number;
  /** The open tab's index (-1: none). */
  activeIndex: number;
  /** The space between tabs. */
  gap?: number;
}): number[] {
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return all;

  // Room for tabs once More (and its gap) has its place.
  const room = available - moreWidth - gap;
  const shown: number[] = [];
  let used = 0;
  for (const index of all) {
    const next = used + (shown.length ? gap : 0) + widths[index];
    if (next > room) break;
    shown.push(index);
    used = next;
  }
  if (activeIndex < 0 || activeIndex >= widths.length || shown.includes(activeIndex)) {
    return shown.length ? shown : (widths.length ? [activeIndex >= 0 && activeIndex < widths.length ? activeIndex : 0] : []);
  }
  // The open tab takes the last places it needs, dropping tabs from the end.
  const width = (list: number[]) => list.reduce((sum, index) => sum + widths[index], 0) + gap * Math.max(0, list.length - 1);
  while (shown.length && width([...shown, activeIndex]) > room) shown.pop();
  return [...shown, activeIndex];
}
