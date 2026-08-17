/**
 * Tiny sparkline from a series of numbers. Colored purely via currentColor so
 * it themes for free. Handles negative values (profit series): the baseline
 * floor is min(0, lowest point) and the series is normalized over the full
 * signed span, so a dashboard-style all-positive series renders unchanged.
 */
export function Sparkline({ data, className = 'text-brand-400' }: { data: number[]; className?: string }) {
  if (data.length < 2) return null;
  const w = 72, h = 22, pad = 2;
  const min = Math.min(0, ...data);
  const span = Math.max(1, Math.max(...data) - min);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill="currentColor" />
    </svg>
  );
}
