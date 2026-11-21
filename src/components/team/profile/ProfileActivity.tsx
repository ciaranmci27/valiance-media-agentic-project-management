'use client';

import { useState } from 'react';
import Link from 'next/link';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
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
    <section aria-labelledby="profile-activity">
      <SectionHeader label={<span id="profile-activity">Activity</span>} />
      <div className="glass-card rounded-xl overflow-hidden">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <History size={18} className="text-zinc-500" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">No activity yet</p>
            <p className="text-xs text-zinc-500 mt-1">
              {first.source === 'agent' ? `What ${name} reports doing shows up here.` : `What ${name} does in projects shows up here.`}
            </p>
          </div>
        ) : (
          <ol className="divide-y divide-white/[0.05]">
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
                      className="block px-5 py-2.5 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-5 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {cursor && !isDemo && (
          <div className="px-5 py-3 border-t border-white/[0.06] flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => void showMore()} disabled={loading}>
              {loading ? 'Loading more' : 'Show older activity'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
