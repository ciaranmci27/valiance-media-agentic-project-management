'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';

/**
 * The side panel's header (DESIGN.md Rules 1 and 2): the title and the close
 * button, with any header actions between them. No uppercase eyebrow. A
 * panel that truly needs context (the project a new task lands in) adds one
 * quiet `detail` line in normal case under the title; by default there is
 * none. Every TaskPanelShell uses it, so the one slide-out has one header.
 *
 * `title` as a string renders the panel's h2 with `id` (TaskPanelShell's
 * `labelledBy`). A node (an editable title field) renders as given and must
 * carry that id itself.
 */
export function PanelHeader({ id, title, detail, actions, onClose, closeLabel = 'Close' }: {
  /** The heading's id, the same as TaskPanelShell's labelledBy. */
  id?: string;
  title: ReactNode;
  /** Optional quiet context under the title, normal case ("In Website relaunch"). Leave out unless needed. */
  detail?: ReactNode;
  /** Header buttons before the close (a row menu). */
  actions?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="flex flex-shrink-0 items-start gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0 flex-1">
        {typeof title === 'string' ? (
          <h2 id={id} className="pt-0.5 text-base font-semibold leading-snug text-white break-words">{title}</h2>
        ) : title}
        {detail && <p className="mt-0.5 text-xs text-zinc-400">{detail}</p>}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {actions}
        <IconButton icon={<X />} label={closeLabel} onClick={onClose} tooltipPosition="left" />
      </div>
    </div>
  );
}
