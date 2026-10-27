'use client';

import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { CopyValueButton, relativeTime } from '@/components/settings/EmailConnectChecklist';
import { NONE, nextHop } from '@/components/settings/email/your-addresses';
import type { YourAddress, YourAddressInbox } from '@/lib/communications/inbox-types';

/**
 * One of your addresses. When the list itself is wide enough (a container
 * query on the list, not the window) it is a row of columns (address,
 * project, whose, the inbox when there are several, actions) under a header
 * row; narrower, it is a stacked card whose fields carry visible labels.
 *
 * While it saves, its controls keep focus (aria-disabled, not disabled) and
 * the section ignores their input, so the keyboard never drops to the page.
 */

/**
 * The list's classes for both shapes. Columns come in once the list is
 * @2xl (672px) wide, or @3xl (768px) with the inbox column too, which keeps
 * every select at about 150px or wider; narrower lists get stacked cards.
 * Each class is written out in full so Tailwind finds it.
 */
export interface AddressLayout {
  /** The column template, shared with the header row. */
  grid: string;
  /** The header row: hidden until there are columns. */
  header: string;
  row: string;
  actions: string;
  fields: string;
  /** A stacked field's own label, hidden once the header row names the columns. */
  label: string;
  /** The relay address: wraps in full on a stacked card, one truncated line in columns. */
  relay: string;
}

const PLAIN: AddressLayout = {
  grid: '@2xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem]',
  header: 'hidden @2xl:grid @2xl:gap-4',
  row: '@2xl:items-start @2xl:gap-4 @2xl:py-3',
  actions: '@2xl:order-last @2xl:col-start-auto @2xl:row-start-auto @2xl:justify-end @2xl:pt-1.5',
  fields: '@md:grid-cols-2 @2xl:contents',
  label: '@2xl:hidden',
  relay: 'break-words @2xl:truncate',
};

const WITH_INBOX: AddressLayout = {
  grid: '@3xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem]',
  header: 'hidden @3xl:grid @3xl:gap-4',
  row: '@3xl:items-start @3xl:gap-4 @3xl:py-3',
  actions: '@3xl:order-last @3xl:col-start-auto @3xl:row-start-auto @3xl:justify-end @3xl:pt-1.5',
  fields: '@md:grid-cols-2 @2xl:grid-cols-3 @3xl:contents',
  label: '@3xl:hidden',
  relay: 'break-words @3xl:truncate',
};

export const addressLayout = (showInbox: boolean): AddressLayout => (showInbox ? WITH_INBOX : PLAIN);

/**
 * An address that wraps after its "@" (ciaran@ / plan4thefuture.com) rather
 * than mid-word; with atDots, also after a dot in its domain, for a long
 * relay address beside a copy button (p4tf@relay. / valiancemedia.com).
 */
export function WrappingAddress({ value, atDots = false }: { value: string; atDots?: boolean }) {
  const at = value.lastIndexOf('@');
  if (at < 0) return <>{value}</>;
  if (!atDots) return <>{value.slice(0, at + 1)}<wbr />{value.slice(at + 1)}</>;
  const labels = value.slice(at + 1).split('.');
  return (
    <>
      {value.slice(0, at + 1)}<wbr />
      {labels.map((label, index) => (
        <span key={index}>{label}{index < labels.length - 1 ? '.' : ''}{index < labels.length - 1 && <wbr />}</span>
      ))}
    </>
  );
}

const ICON_BUTTON =
  'p-1.5 rounded-lg text-zinc-400 transition-colors flex-shrink-0 hover:text-red-300 hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-400';

export interface AddressRowProps {
  row: YourAddress;
  /** The inbox it delivers to; undefined when that inbox is gone. */
  inbox: YourAddressInbox | undefined;
  /** More than one inbox: show and change which one it delivers to. */
  showInbox: boolean;
  busy: boolean;
  /** Set when it got a new relay address here: it waits for mail through it from then. */
  relaySince: string | null;
  projectOptions: SelectOption[];
  ownerOptions: SelectOption[];
  inboxOptions: SelectOption[];
  /** The row itself, so focus can land on it after a change elsewhere. */
  rowRef: (node: HTMLLIElement | null) => void;
  onProject: (value: string) => void;
  onOwner: (value: string) => void;
  onInbox: (value: string) => void;
  onToggle: () => void;
  onRemove: () => void;
}

export function AddressRow({
  row,
  inbox,
  showInbox,
  busy,
  relaySince,
  projectOptions,
  ownerOptions,
  inboxOptions,
  rowRef,
  onProject,
  onOwner,
  onInbox,
  onToggle,
  onRemove,
}: AddressRowProps) {
  const hop = nextHop(row, inbox);
  const ownRelay = !!row.routing_address;
  const off = ownRelay && !row.enabled;
  // Waiting: its own relay address has had no mail yet (or none since it got it here).
  const waiting = ownRelay && !off && (!row.last_received_at || (relaySince !== null && row.last_received_at < relaySince));
  const layout = addressLayout(showInbox);
  const relayCode = (value: string) => (
    <code title={value} className={`min-w-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-zinc-200 ${layout.relay}`}>
      <WrappingAddress value={value} atDots />
    </code>
  );

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      aria-busy={busy || undefined}
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${layout.row} ${layout.grid}`}
    >
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`min-w-0 break-words font-mono text-sm ${off ? 'text-zinc-400' : 'text-zinc-100'}`}><WrappingAddress value={row.address} /></span>
          {off && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-zinc-300">Off</span>}
        </p>

        {waiting && hop ? (
          <div className="space-y-0.5 text-xs text-zinc-400">
            <p className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-zinc-400 motion-safe:animate-pulse" />
              <span className="flex-shrink-0">Waiting for its first email at</span>
            </p>
            {/* A div, not a p: the copy button's tooltip renders a div. */}
            <div className="flex min-w-0 items-center gap-1 pl-3.5">
              {relayCode(hop)}
              <CopyValueButton value={hop} label={`Copy ${hop}`} />
            </div>
            <p className="pl-3.5">Set its forwarder at your mail host to this address.</p>
          </div>
        ) : (
          <>
            {hop ? (
              <div className="min-w-0 space-y-0.5 text-xs text-zinc-400">
                {/* The label on its own line: the relay address gets the whole column. */}
                <span className="block">Forward it to</span>
                <div className="flex min-w-0 items-center gap-1.5">
                  {relayCode(hop)}
                  <CopyValueButton value={hop} label={`Copy ${hop}`} />
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-400">Its inbox is gone. Choose where it delivers.</p>
            )}
            <p className="text-xs text-zinc-400">
              {off
                ? 'Off. Mail sent to it is dropped.'
                : row.last_received_at
                  ? `Last email ${relativeTime(row.last_received_at)}`
                  : 'No email yet'}
            </p>
          </>
        )}

        {inbox && !inbox.enabled && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span className="min-w-0">{inbox.name} is off, so mail to this address is dropped.</span>
          </p>
        )}
      </div>

      <div className={`col-start-2 row-start-1 flex items-center gap-1 self-start ${layout.actions}`}>
        {busy && (
          <Loader2 size={14} className="flex-shrink-0 animate-spin text-zinc-400 motion-reduce:animate-none" role="status" aria-label={`Saving ${row.address}`} />
        )}
        {ownRelay && (
          <Tooltip content={row.enabled ? 'Turn off: mail to it is dropped' : 'Turn on'}>
            <Toggle
              size="sm"
              checked={row.enabled}
              onChange={onToggle}
              aria-disabled={busy || undefined}
              aria-label={`Receive mail at ${row.address}`}
            />
          </Tooltip>
        )}
        <Tooltip content="Remove">
          <button type="button" onClick={onRemove} aria-disabled={busy || undefined} aria-label={`Remove ${row.address}`} className={ICON_BUTTON}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {/* Stacked: the fields share a grid of their own. In columns they are columns of the row. */}
      <div className={`col-span-2 grid grid-cols-1 gap-3 ${layout.fields}`}>
        <Field label="Project" hide={layout.label}>
          <Select
            ariaLabel={`Project for ${row.address}`}
            value={row.project_id ?? NONE}
            onChange={onProject}
            options={projectOptions}
            searchable
            size="sm"
            ariaDisabled={busy}
          />
        </Field>
        <Field label="Whose" hide={layout.label}>
          <Select
            ariaLabel={`Whose address ${row.address} is`}
            value={row.owner_member_id ?? NONE}
            onChange={onOwner}
            options={ownerOptions}
            size="sm"
            ariaDisabled={busy}
          />
        </Field>
        {showInbox && (
          <Field label="Delivers to" hide={layout.label}>
            <Select
              ariaLabel={`Inbox ${row.address} delivers to`}
              value={inbox ? row.inbox_id : NONE}
              onChange={onInbox}
              options={inboxOptions}
              placeholder="Choose an inbox"
              size="sm"
              ariaDisabled={busy}
            />
          </Field>
        )}
      </div>
    </li>
  );
}

/** A field of a stacked row: its label shows until the list becomes columns with a header. */
function Field({ label, hide, children }: { label: string; hide: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className={`mb-1 block text-xs text-zinc-400 ${hide}`} aria-hidden="true">{label}</span>
      {children}
    </div>
  );
}
