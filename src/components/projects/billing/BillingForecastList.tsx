'use client';

import { CalendarClock, Infinity as Endless } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { BillingForecastItem } from '@/lib/types';

/**
 * Invoices ahead, grouped by month: what each will hold, which amounts are
 * exact (retainers) and which are estimates (hours, marked "est."), and what
 * is already drafted. Used by the Billing window and the billing calendar.
 */

export function money(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function monthLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const STATUS: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'; hint: string }> = {
  upcoming: { label: 'Upcoming', variant: 'default', hint: 'Will be drafted on its date. Nothing is sent without you.' },
  draft: { label: 'Drafted', variant: 'purple', hint: 'Drafted and waiting for you to review and send.' },
  sent: { label: 'Sent', variant: 'info', hint: 'Sent to the client.' },
  overdue: { label: 'Overdue', variant: 'danger', hint: 'Sent and past its due date.' },
  paid: { label: 'Paid', variant: 'success', hint: 'Paid.' },
  cancelled: { label: 'Cancelled', variant: 'default', hint: 'Cancelled.' },
  paused: { label: 'Paused', variant: 'warning', hint: 'Paused: nothing will be drafted until it is resumed.' },
  skipped: { label: 'Skipped', variant: 'default', hint: 'Skipped. You can still bill it by hand.' },
  nothing_due: { label: 'Nothing due', variant: 'default', hint: 'No unbilled hours on that date.' },
  below_minimum: { label: 'Under minimum', variant: 'default', hint: 'Too small to draft; the hours wait for the next one.' },
  failed: { label: 'Failed', variant: 'danger', hint: 'The draft could not be made. Check the project and bill by hand if needed.' },
};

export function ForecastStatus({ status }: { status: string }) {
  const config = STATUS[status] ?? STATUS.upcoming;
  return (
    <span title={config.hint}>
      <Badge variant={config.variant}>{config.label}</Badge>
    </span>
  );
}

interface Props {
  items: BillingForecastItem[];
  /** Show each item's project (the cross-project calendar). */
  showProject?: boolean;
  /** Open-ended billing continues past the last item shown. */
  continues?: boolean;
  onShowMore?: () => void;
  emptyText?: string;
  onOpenProject?: (projectId: string) => void;
}

export function BillingForecastList({ items, showProject = false, continues = false, onShowMore, emptyText, onOpenProject }: Props) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/[0.08] px-4 py-8 text-center">
        <CalendarClock size={20} className="mx-auto text-zinc-500" aria-hidden="true" />
        <p className="mt-2 text-sm text-zinc-300">{emptyText ?? 'No invoices scheduled.'}</p>
        <p className="mt-1 text-xs text-zinc-500">Add a retainer or schedule hourly drafts to see what is coming.</p>
      </div>
    );
  }

  // By date, then project: the calendar receives each project's items in turn.
  const sorted = [...items].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.project_name ?? '').localeCompare(b.project_name ?? ''));
  const months = new Map<string, BillingForecastItem[]>();
  for (const item of sorted) {
    const key = item.date.slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), item]);
  }

  return (
    <div className="space-y-5">
      {[...months.entries()].map(([key, monthItems]) => {
        const exact = monthItems.reduce((sum, item) => sum + item.exact, 0);
        const estimated = monthItems.reduce((sum, item) => sum + item.estimated, 0);
        return (
          <section key={key} aria-label={monthLabel(monthItems[0].date)}>
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{monthLabel(monthItems[0].date)}</h4>
              <p className="text-xs text-zinc-400 tabular-nums">
                {money(exact)}
                {estimated > 0 && <span className="text-zinc-500"> + {money(estimated)} est.</span>}
              </p>
            </div>
            <ul className="space-y-2">
              {monthItems.map((item) => (
                <li
                  key={`${item.project_id ?? ''}${item.date}${item.sources}`}
                  className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-white tabular-nums w-28 flex-shrink-0">{dayLabel(item.date)}</span>
                    {showProject && item.project_name && (
                      onOpenProject && item.project_id ? (
                        <button
                          type="button"
                          onClick={() => onOpenProject(item.project_id as string)}
                          className="text-sm text-zinc-200 hover:text-white underline-offset-2 hover:underline rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                        >
                          {item.project_name}
                        </button>
                      ) : (
                        <span className="text-sm text-zinc-200">{item.project_name}</span>
                      )
                    )}
                    <ForecastStatus status={item.status} />
                    {item.invoice_number && <span className="text-xs text-zinc-400">{item.invoice_number}</span>}
                    <span className="ml-auto text-sm font-semibold text-white tabular-nums">
                      {money(item.exact + item.estimated)}
                      {item.estimated > 0 && <span className="ml-1 text-xs font-normal text-zinc-500">est.</span>}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {item.lines.map((line, index) => (
                      <li key={index} className="flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <span className="text-zinc-300">{line.label}</span>
                          {line.note && <span className="block text-zinc-500">{line.note}</span>}
                        </div>
                        <span className={`tabular-nums flex-shrink-0 ${line.estimated ? 'text-zinc-400' : 'text-zinc-200'}`}>
                          {line.estimated ? '~' : ''}{money(line.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {item.sources.includes(',') && (
                    <p className="mt-1.5 text-[11px] text-zinc-500">Retainer and hours on one invoice.</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {continues && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3.5 py-2.5">
          <p className="flex items-center gap-2 text-xs text-zinc-400">
            <Endless size={14} aria-hidden="true" />
            Continues with no end date.
          </p>
          {onShowMore && (
            <button
              type="button"
              onClick={onShowMore}
              className="text-xs font-medium text-brand-300 hover:text-brand-200 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
