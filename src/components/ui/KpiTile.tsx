import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Sparkline } from '@/components/ui/Sparkline';

interface KpiTileProps {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
  /** One short line under the value: a comparison, a unit, a hint. */
  context?: ReactNode;
  /** Colors the value: 'positive' for money in, 'warning' for money owed. */
  tone?: 'default' | 'positive' | 'warning';
  spark?: number[];
  /** Extra content under the context line, e.g. a budget bar. */
  children?: ReactNode;
  /** 'compact' for rows of five, where the large value would truncate. */
  size?: 'default' | 'compact';
}

const TONES = {
  default: 'text-white',
  positive: 'text-emerald-300',
  warning: 'text-amber-300',
};

/**
 * The Dashboard's KPI tile as a component: label, large value, icon chip and a
 * context line, with an optional sparkline. Tab pages lead with a row of these
 * instead of a strip of small numbers.
 */
export function KpiTile({ label, value, icon: Icon, context, tone = 'default', spark, children, size = 'default' }: KpiTileProps) {
  return (
    <div className="glass-card rounded-xl p-4 lg:p-5 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs lg:text-sm text-zinc-500 font-medium">{label}</p>
          <p className={`${size === 'compact' ? 'text-2xl' : 'text-2xl lg:text-3xl'} font-bold tracking-tight tabular-nums mt-0.5 leading-none truncate ${TONES[tone]}`}>{value}</p>
        </div>
        <div className="w-8 h-8 lg:w-9 lg:h-9 flex-shrink-0 rounded-lg grid place-items-center bg-white/[0.06] text-zinc-400 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          <Icon size={17} aria-hidden="true" />
        </div>
      </div>
      {(context || spark) && (
        <div className="flex items-center justify-between gap-2 mt-3.5 min-h-[22px]">
          <span className="text-xs font-medium text-zinc-500 truncate">{context}</span>
          {spark && <Sparkline data={spark} />}
        </div>
      )}
      {children}
    </div>
  );
}

/** The row KPI tiles sit in: two up on phones, up to four across on desktop. */
export function KpiRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 ${className}`}>{children}</div>;
}
