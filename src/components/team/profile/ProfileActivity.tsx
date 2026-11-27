'use client';

import { useState } from 'react';
import Link from 'next/link';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { toast } from '@/components/ui/Toast';
import { timeAgo } from '@/lib/task-times';
import { loadTeamProfileActivity } from '@/lib/reads';
import type { ProfileActivityItem, ProfileActivityPage } from '@/lib/team/profile';

/**
 * What the person did, newest first, 30 at a time. Older pages are this
 * screen's own: the cached profile holds only the first.
 */
export function ProfileActivity({
  memberId,
  first,
  name,
  isDemo,
}: {
  memberId: string;
  first: ProfileActivityPage;
  name: string;
  isDemo: boolean;
}) {
  const [older, setOlder] = useState<ProfileActivityItem[]>([]);
  const [cursor, setCursor] = useState(first.next_cursor);
  const [loading, setLoading] = useState(false);
  const items = [...first.items, ...older];

  const showMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await loadTeamProfileActivity(memberId, cursor);
      setOlder((current) => [...current, ...page.items]);
      setCursor(page.next_cursor);
    } catch {
      toast('error', 'Could not load more activity');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Activity" icon={<History />} id="profile-activity" className="overflow-hidden" bodyClassName="pb-1">
        {items.length === 0 ? (
          <EmptyState
            compact
            icon={<History />}
            title="No activity yet"
            description={first.source === 'agent' ? `What ${name} reports doing shows up here.` : `What ${name} does in projects shows up here.`}
          />
        ) : (
          <ol className="divide-y divide-white/[0.05] border-t border-white/[0.06]">
            {items.map((item) => {
              const body = (
                <>
                  <span className="block text-sm text-zinc-200 break-words">{item.text}</span>
                  <span className="block text-[11px] text-zinc-500 mt-0.5">
                    {item.project_name ? `${item.project_name}, ` : ''}
                    <time dateTime={item.at}>{timeAgo(item.at)}</time>
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="block px-4 py-2.5 lg:px-5 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-4 py-2.5 lg:px-5">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {cursor && !isDemo && (
          <div className="px-4 pt-2 pb-1 border-t border-white/[0.06] flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => void showMore()} disabled={loading}>
              {loading ? 'Loading more' : 'Show older activity'}
            </Button>
          </div>
        )}
    </Card>
  );
}
