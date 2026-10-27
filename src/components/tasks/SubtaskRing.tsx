/** How much of the work inside a task is done, as a small ring. Decorative: the count beside it says the same. */
export function SubtaskRing({ done, total, size = 18 }: { done: number; total: number; size?: number }) {
  const circumference = 2 * Math.PI * 14;
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" className="flex-shrink-0">
      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="5" className="stroke-white/[0.12]" />
      <circle
        cx="18" cy="18" r="14" fill="none" strokeWidth="5" className="stroke-emerald-500"
        strokeDasharray={`${total > 0 ? (done / total) * circumference : 0} ${circumference}`}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}
