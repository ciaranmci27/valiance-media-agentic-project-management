'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { UpdateRow } from '@/components/notifications/UpdateRow';
import { useDemo } from '@/lib/demo-context';
import { fetchGroupRows } from '@/lib/reads';
import { groupLabel, type NotificationGroup, type NotificationView } from '@/lib/notifications';

type Member = { id: string; name: string; avatar?: string | null; role: string };

/**
 * One group of Updates: "Website wireframes: 3 updates" with its latest
 * notice under it. Opening it reads the whole group and follows the latest
 * link; Done finishes the whole group; Show updates lists each notice in
 * place (newest first), each with its own Done. A group of one is a plain row.
 */
export function UpdateGroupRow({ group, place, team, viewerId, onOpenGroup, onOpenOne, onDoneGroup, onDoneOne }: {
  group: NotificationGroup;
  /** What the group is about, by name (a task's title, a project's name), when the viewer can see it. */
  place: string | null;
  team: readonly Member[];
  viewerId: string | null;
  onOpenGroup: (group: NotificationGroup) => void;
  onOpenOne: (n: NotificationView) => void;
  onDoneGroup: (group: NotificationGroup) => void;
  onDoneOne: (n: NotificationView) => void;
}) {
  const { isDemoMode } = useDemo();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const many = group.group_count > 1;
  const listId = `update-group-${group.group_key}`;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || rows) return;
    setFailed(false);
    try {
      setRows(await fetchGroupRows(group.group_key, isDemoMode));
    } catch {
      setFailed(true);
    }
  };

  if (!many) {
    return <UpdateRow notification={group.latest} team={team} viewerId={viewerId} onOpen={() => onOpenGroup(group)} onDone={() => onDoneGroup(group)} />;
  }

  return (
    <div>
      <UpdateRow
        notification={group.latest}
        title={groupLabel(group, place)}
        message={group.latest.title}
        unread={group.unread_count > 0}
        team={team}
        viewerId={viewerId}
        onOpen={() => onOpenGroup(group)}
        onDone={() => onDoneGroup(group)}
        extra={(
          <IconButton
            size="sm"
            icon={<ChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
            label={open ? 'Hide updates' : `Show ${group.group_count} updates`}
            tooltipPosition="left"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => void toggle()}
          />
        )}
      />
      {open && (
        <ul id={listId} className="divide-y divide-white/[0.04] border-t border-white/[0.04] bg-white/[0.015]">
          {failed ? (
            <li className="py-2.5 pl-[60px] pr-4 text-xs text-red-300" role="alert">Could not load these updates. Close and open to try again.</li>
          ) : !rows ? (
            <li className="py-2.5 pl-[60px] pr-4 text-xs text-zinc-500" role="status">Loading</li>
          ) : rows.map((n) => (
            <li key={n.id}>
              <UpdateRow
                nested
                notification={n}
                team={team}
                viewerId={viewerId}
                onOpen={onOpenOne}
                onDone={(row) => {
                  setRows((now) => (now ?? []).filter((r) => r.id !== row.id));
                  onDoneOne(row);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
