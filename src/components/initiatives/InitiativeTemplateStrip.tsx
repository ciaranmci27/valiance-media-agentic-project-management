'use client';

import type { ReactNode } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { parseDateOnly } from '@/lib/date-utils';
import { appLocale } from '@/lib/region';
import { INITIATIVE_LABEL, type InitiativeTemplateRun } from '@/lib/initiatives';

const day = (value: string) => parseDateOnly(value).toLocaleDateString(appLocale(), { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * One quiet line under an initiative's header when a template run made it:
 * "From <template>", then the run's key dates, the main one (the target)
 * marked. `action` holds the run's own action on the right (Change dates,
 * for whoever may create tasks in the project).
 */
export function InitiativeTemplateStrip({ run, action }: { run: InitiativeTemplateRun; action?: ReactNode }) {
  return (
    <section
      aria-label={`Template this ${INITIATIVE_LABEL.lower} came from`}
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-white/[0.03] px-3.5 py-2 text-xs text-zinc-400"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
        <LayoutTemplate size={13} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
        <span className="truncate">From <span className="font-medium text-zinc-200">{run.template_name}</span></span>
      </span>
      {run.key_dates.length > 0 && (
        <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {run.key_dates.map((keyDate) => (
            <div key={keyDate.key} className="inline-flex items-baseline gap-1.5">
              <dt>{keyDate.label}</dt>
              <dd className={`tabular-nums ${keyDate.main ? 'font-medium text-brand-200' : 'text-zinc-200'}`}>
                {day(keyDate.date)}{keyDate.main && <span className="sr-only"> (the target date)</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {action && <div className="ml-auto flex-shrink-0">{action}</div>}
    </section>
  );
}
