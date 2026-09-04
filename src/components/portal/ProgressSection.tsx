'use client';

import { useId, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import type { PortalData } from '@/lib/types';
import { SectionCard, SectionHeader } from './SectionHeader';
import { formatDay } from './format';

const RING = 112;
const STROKE = 6;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ProgressRing({ percent }: { percent: number }) {
  // useId can contain characters SVG url() references choke on.
  const gradientId = `vm-ring-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;

  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--vm-teal-300)" />
            <stop offset="100%" stopColor="var(--vm-teal-200)" />
          </linearGradient>
        </defs>
        <circle cx={RING / 2} cy={RING / 2} r={RADIUS} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={STROKE} />
        <circle
          cx={RING / 2}
          cy={RING / 2}
          r={RADIUS}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          className="vm-ring-fill"
          style={{ '--vm-ring-c': CIRCUMFERENCE, strokeDashoffset: offset } as CSSProperties}
        />
      </svg>
      <span
        role="img"
        aria-label={`${clamped} percent complete`}
        className="vm-stat absolute inset-0 flex items-center justify-center text-[1.7rem]"
      >
        {clamped}%
      </span>
    </div>
  );
}

function MilestoneRow({ label, date, done }: { label: string; date: string | null; done: boolean }) {
  return (
    <li className="vm-row flex items-center gap-3.5 py-3.5 first:pt-0 last:pb-0">
      {done ? (
        <span
          className="vm-tile vm-tile-teal flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-(--vm-teal-200)"
          aria-hidden="true"
        >
          <Check size={13} strokeWidth={2.25} />
        </span>
      ) : (
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-(--vm-line-strong)"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 text-[15px]">
        {label}
        <span className="sr-only">{done ? ', done' : ', upcoming'}</span>
      </span>
      {date && <span className="vm-mono vm-soft shrink-0 text-[15px]">{formatDay(date)}</span>}
    </li>
  );
}

export function ProgressSection({
  project,
  progress,
}: {
  project: PortalData['project'];
  progress: PortalData['progress'];
}) {
  const completed = project.status === 'completed';
  const remaining = progress.days_remaining;
  const absDays = remaining == null ? 0 : Math.abs(remaining);
  const dayWord = absDays === 1 ? 'day' : 'days';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const started = project.start_date ? new Date(`${project.start_date}T00:00:00`) <= today : false;

  return (
    <SectionCard sectionKey="show_progress">
      <SectionHeader
        title="Progress"
        right={completed ? <span className="vm-chip vm-chip-teal">Completed</span> : undefined}
      />

      {/* A main-column card, so the ring and the dates sit side by side on a wide
          screen instead of leaving a long list stretched across it. */}
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:gap-12">
        <div className="flex items-center gap-6 lg:shrink-0">
          <ProgressRing percent={progress.percent} />
          <div className="min-w-0 flex-1">
            {completed ? (
              <>
                <p className="text-[15px] font-medium">Complete</p>
                <p className="vm-faint mt-1 text-[13px]">Project delivered</p>
              </>
            ) : progress.is_overdue ? (
              <>
                <span className="vm-chip vm-chip-error">Overdue</span>
                <p className="vm-faint mt-2 text-[13px]">{absDays} {dayWord} past delivery</p>
              </>
            ) : remaining != null ? (
              <>
                <p className="vm-mono text-[17px] text-(--vm-copper-300)">{remaining} {dayWord} left</p>
                <p className="vm-faint mt-1 text-[13px]">until delivery</p>
              </>
            ) : null}
          </div>
        </div>

        <ul className="lg:ml-auto lg:w-[24rem]">
          {project.start_date && <MilestoneRow label="Kickoff" date={project.start_date} done={started} />}
          <MilestoneRow
            label={completed ? 'Delivered' : 'Delivery'}
            date={project.due_date}
            done={completed}
          />
        </ul>
      </div>
    </SectionCard>
  );
}
