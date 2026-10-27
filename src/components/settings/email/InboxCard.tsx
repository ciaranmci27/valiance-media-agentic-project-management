'use client';

import Link from 'next/link';
import { AlertTriangle, Loader2, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { CopyValueButton, relativeTime } from '@/components/settings/EmailConnectChecklist';
import { EMAIL_PAGES } from '@/components/settings/settings-groups';
import { TRIAGE_MODE_OPTIONS, handlerSentence } from '@/components/settings/email/InboxForm';
import { currentError, inboxStatus, STATUS_DOT } from '@/components/settings/email/inbox-status';
import type { InboxSettings } from '@/lib/communications/inbox-types';
import type { TeamMember } from '@/lib/types';

/**
 * One inbox on Settings > Email > Who handles your mail: its name, who
 * handles it and what that means, its own address, how many of your
 * addresses deliver to it, who else can read it, how long mail is kept, which
 * triage runs, whether mail is coming in, and the switch and edit button.
 * How to connect it lives under Setup on the same page.
 */
/** The id of an inbox's Edit button, where focus returns when its form closes. */
export const inboxEditButtonId = (inboxId: string) => `inbox-edit-${inboxId}`;

export function InboxCard({
  inbox,
  team,
  toggling,
  editing,
  onEdit,
  onToggle,
}: {
  inbox: InboxSettings;
  team: TeamMember[];
  /** Its switch is saving: the switch and Edit keep focus but take no input. */
  toggling: boolean;
  /** Its edit form is open: the switch waits until the form is saved or closed. */
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const memberName = (id: string) => team.find((m) => m.id === id)?.name ?? 'Unknown member';
  const handler = inbox.handler_member_id ? team.find((m) => m.id === inbox.handler_member_id) ?? null : null;
  // A handler no longer on the team still reads as handled.
  const sentence = handlerSentence(handler ?? (inbox.handler_member_id ? { name: 'Its handler', role: 'member' } : null));
  const handlerLabel = inbox.handler_member_id
    ? `${handler?.name ?? 'Unknown member'}${handler?.role === 'agent' ? ' (agent)' : ''}`
    : 'Nobody';
  const others = inbox.access_member_ids
    .filter((id) => id !== inbox.handler_member_id)
    .map(memberName)
    .sort((a, b) => a.localeCompare(b));
  const triage = TRIAGE_MODE_OPTIONS.find((option) => option.value === inbox.triage_mode)?.label ?? 'Current triage';
  const status = inboxStatus(inbox);
  const error = currentError(inbox);
  const count = inbox.project_address_count;
  const switchLocked = toggling || editing;

  return (
    <li className="px-4 py-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-white break-words">{inbox.name}</h3>
            <Badge variant={inbox.enabled ? 'success' : 'default'}>{inbox.enabled ? 'On' : 'Off'}</Badge>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-zinc-400">
            <span title={inbox.address} className="min-w-0 truncate font-mono">{inbox.address}</span>
            <CopyValueButton value={inbox.address} label={`Copy ${inbox.address}`} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {toggling && (
            <Loader2 size={14} className="animate-spin text-zinc-400 motion-reduce:animate-none" role="status" aria-label={`Saving ${inbox.name}`} />
          )}
          <Tooltip content="Edit">
            <button
              type="button"
              id={inboxEditButtonId(inbox.id)}
              onClick={() => {
                if (!toggling) onEdit();
              }}
              aria-disabled={toggling || undefined}
              aria-label={`Edit ${inbox.name}`}
              className="p-1.5 text-zinc-400 hover:text-brand-300 hover:bg-brand-500/15 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={editing ? 'Save or cancel the edit first' : inbox.enabled ? 'Turn off' : 'Turn on'}>
            <Toggle
              size="sm"
              checked={inbox.enabled}
              onChange={() => {
                if (!switchLocked) onToggle();
              }}
              aria-disabled={switchLocked || undefined}
              aria-label={`Receive mail for ${inbox.name}`}
            />
          </Tooltip>
        </div>
      </div>

      <p className="text-sm text-zinc-300">{sentence}</p>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div className="min-w-0">
          <dt className="text-zinc-400">Handled by</dt>
          <dd className="text-zinc-200 break-words">{handlerLabel}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-400">Your addresses that deliver here</dt>
          <dd>
            <Link
              href={EMAIL_PAGES.addresses}
              className="rounded text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {count === 0 ? 'None yet. Add one' : count === 1 ? '1 address' : `${count} addresses`}
            </Link>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-400">{handler ? 'Who else can read it' : 'Who can read it'}</dt>
          <dd className="text-zinc-200 break-words">{others.length ? others.join(', ') : 'Nobody else'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-400">Keeps mail for</dt>
          <dd className="text-zinc-200">{inbox.retention_days === 1 ? '1 day' : `${inbox.retention_days} days`}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-400">Triage</dt>
          <dd className="text-zinc-200">{triage}</dd>
        </div>
      </dl>

      <p className="flex items-center gap-2 text-xs">
        <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} />
        <span className={status.tone === 'on' ? 'text-emerald-300' : 'text-zinc-400'}>{status.text}</span>
      </p>

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-red-300">
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span className="min-w-0 break-words">
            <span className="sr-only">Last error: </span>
            {error}
            {inbox.last_error_at && <span className="text-zinc-400"> ({relativeTime(inbox.last_error_at)})</span>}
          </span>
        </p>
      )}
    </li>
  );
}
