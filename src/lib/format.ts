/**
 * The app's one way to show money totals and hours, so a figure reads the
 * same on the Dashboard, Finances, a project's Overview and its tabs.
 * Invoice line amounts keep their own exact cents and do not use this.
 */

const hoursFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "2.5h", "2h", "0h"; a sliver under six minutes reads "<0.1h" rather than "0h". */
export function formatHours(hours: number): string {
  if (hours > 0 && hours < 0.05) return '<0.1h';
  return `${hoursFormat.format(hours)}h`;
}

/** "$1,500", "$12.50", "-$80": whole dollars from $1,000 up, cents below only when there are any. */
export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const hasCents = abs < 1000 && Math.round(abs * 100) % 100 !== 0;
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
  return value < 0 && text !== '0' ? `-$${text}` : `$${text}`;
}
