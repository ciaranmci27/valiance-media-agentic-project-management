import Link from 'next/link';
import { UserX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatStrip } from '@/components/ui/StatStrip';

const bar = 'rounded bg-white/[0.06] motion-safe:animate-pulse';

/** The profile's layout while it loads: identity card, number strip, tasks and projects. */
export function ProfileSkeleton() {
  return (
    <div className="p-4 lg:p-6 space-y-6" aria-busy="true" aria-label="Loading profile">
      <div className="glass-card rounded-xl p-5">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-white/[0.06] motion-safe:animate-pulse flex-shrink-0" />
          <div className="space-y-2 flex-1">
            <div className={`${bar} h-3.5 w-32`} />
            <div className={`${bar} h-5 w-44`} />
          </div>
        </div>
        <div className="mt-5 pt-5 border-t border-white/[0.06] flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-x-10">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <div className={`${bar} h-2.5 w-16`} />
              <div className={`${bar} h-4 w-28`} />
            </div>
          ))}
        </div>
      </div>
      <StatStrip
        loading
        stats={[{ label: 'Open tasks', value: null }, { label: 'Overdue', value: null }, { label: 'Done', value: null }]}
      />
      <div className="card-row lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="glass-card rounded-xl p-4 lg:p-5 space-y-4">
          <div className={`${bar} h-3 w-24`} />
          {Array.from({ length: 4 }, (_, i) => <div key={i} className={`${bar} h-4 w-full`} />)}
        </div>
        <div className="glass-card rounded-xl p-4 lg:p-5 space-y-4">
          <div className={`${bar} h-3 w-20`} />
          {Array.from({ length: 3 }, (_, i) => <div key={i} className={`${bar} h-4 w-full`} />)}
        </div>
      </div>
    </div>
  );
}

/**
 * Not found and no access read the same, so the page never says whether
 * someone the viewer may not see exists.
 */
export function ProfileNotFound() {
  return (
    <div className="p-4 lg:p-6">
      <EmptyState
        framed
        icon={<UserX />}
        title="Team member not found"
        description="They are not on the team, or not on a project you share."
        action={<Link href="/team"><Button variant="secondary" size="sm">Back to Team</Button></Link>}
      />
    </div>
  );
}

export function ProfileError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="p-4 lg:p-6">
      <EmptyState framed variant="error" title="Could not load this profile" description="Check your connection and try again." onRetry={onRetry} />
    </div>
  );
}
