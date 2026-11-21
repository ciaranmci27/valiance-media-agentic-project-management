'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { TimesheetView } from '@/components/time/TimesheetView';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { financeViews } from '@/lib/finance/finance-views';

/**
 * The timesheet as its own page, for anyone with no money view (both money
 * modules off, or a person who holds none of their permissions). When the
 * person has Finances, the timesheet is its Time tab and this page sends
 * them there, so an old or shared /time link still lands.
 */
export default function TimePage() {
  const { access } = useAuth();
  const router = useRouter();
  const views = financeViews(access);
  const inFinances = views.entry?.href === '/finances' && views.tabs.includes('time');
  const firstTab = views.tabs[0];

  useEffect(() => {
    if (inFinances) router.replace(firstTab === 'time' ? '/finances' : '/finances?tab=time');
  }, [inFinances, firstTab, router]);

  if (inFinances) return null;

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Time"
        subtitle={(
          <span className="hidden sm:inline">
            {hasPermission(access, 'time.read_all') ? 'Your hours and your team\'s, week by week.' : 'Your hours, week by week.'}
          </span>
        )}
      />
      <div className="p-4 lg:p-6">
        <TimesheetView />
      </div>
    </div>
  );
}
