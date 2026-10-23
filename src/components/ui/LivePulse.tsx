/**
 * The green "time tracker is running" pulse. The ping ring stops for people
 * who prefer reduced motion; the solid dot stays. `label` is read to screen
 * readers in place of the dot.
 */
export function LivePulse({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="relative inline-flex h-2 w-2 flex-shrink-0">
      <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" aria-hidden="true" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
    </span>
  );
}
