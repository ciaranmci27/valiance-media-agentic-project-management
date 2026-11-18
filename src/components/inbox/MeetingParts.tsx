'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Bell, CalendarClock, Check, ChevronDown, CircleSlash, ExternalLink, ListChecks, Loader2, MessageSquare, PenLine, Plus, RefreshCw, SquarePlus, Undo2, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { useRead } from '@/lib/query-cache';
import { inboxFileTextRead } from '@/lib/reads';
import {
  MEETING_PACKAGE_LABELS, type InboxAttachment, type InboxMeeting, type InboxPlanItem, type MeetingPackageKind,
} from '@/lib/communications/inbox-types';
import { formatDay, formatMeetingTime } from './inbox-badges';

/** Guests shown before "Show all": a long list folds. */
const ATTENDEES_SHOWN = 4;

/**
 * Under a meeting's title: when it ran, who organized it, who was invited
 * (folded when long), its Google Doc, and, once someone said so, who marked
 * it nothing to do.
 */
export function MeetingDetails({ meeting }: { meeting: InboxMeeting }) {
  const [allAttendees, setAllAttendees] = useState(false);
  const when = formatMeetingTime(meeting.starts_at, meeting.ends_at);
  const organizer = meeting.organizer;
  const guests = meeting.attendees;
  const shown = allAttendees ? guests : guests.slice(0, ATTENDEES_SHOWN);
  return (
    <div className="mt-2 min-w-0 space-y-1.5 text-xs text-zinc-300">
      <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {when && (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <CalendarClock size={13} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
            <span><span className="sr-only">When: </span>{when}</span>
          </span>
        )}
        {organizer && (
          <span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
            <span className="text-zinc-400">Organizer </span>
            {organizer.name ? <>{organizer.name} <span className="text-zinc-400">{organizer.address}</span></> : organizer.address}
          </span>
        )}
        {meeting.doc_url && (
          <a
            href={meeting.doc_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Open in Google Docs
            <ExternalLink size={11} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </p>
      {guests.length > 0 && (
        <div className="flex min-w-0 items-start gap-1.5">
          <Users size={13} className="mt-px flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
            <span className="sr-only">{guests.length} {guests.length === 1 ? 'attendee' : 'attendees'}: </span>
            <ul className="inline" aria-label="Attendees">
              {shown.map((person, index) => (
                <li key={person.address} className="inline">
                  {person.name ? <>{person.name} <span className="text-zinc-400">{person.address}</span></> : person.address}
                  {index < shown.length - 1 && <span aria-hidden="true">, </span>}
                </li>
              ))}
            </ul>
            {guests.length > ATTENDEES_SHOWN && (
              <button
                type="button"
                onClick={() => setAllAttendees((value) => !value)}
                aria-expanded={allAttendees}
                className="ml-1.5 inline-flex items-center gap-0.5 rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {allAttendees ? 'Show fewer' : `Show all ${guests.length}`}
                <ChevronDown size={12} className={`transition-transform motion-reduce:transition-none ${allAttendees ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
      {meeting.dismissed && (
        <p className="flex min-w-0 items-start gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5" role="status">
          <CircleSlash size={13} className="mt-px flex-shrink-0 text-zinc-400" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Marked nothing to do by {meeting.dismissed.by?.name ?? 'someone'} on {formatDay(meeting.dismissed.at)}
          </span>
        </p>
      )}
    </div>
  );
}

/** A waiting suggestion as the checklist shows it: the plan item and the message it came from. */
export type MeetingSuggestion = InboxPlanItem;

/** What Change may edit before adding: a suggested task's title and due date, a reminder's title. */
export interface SuggestionEdits {
  title?: string;
  due_date?: string | null;
}

/** The line after Add all or Nothing to do, with its Undo while it is in reach. */
export interface SuggestionsOutcome {
  text: string;
  onUndo?: () => void;
  undoing: boolean;
}

/**
 * A meeting's waiting suggestions, under its notes or transcript, as a checklist: each
 * one can be added, changed then added, or skipped, and the whole set added
 * or waved off with Nothing to do. From a meeting the agent only suggests,
 * so nothing here exists until a person adds it.
 */
export function MeetingSuggestions({ items, agentName, onAdd, onSkip, pendingId, onAddAll, onNothingToDo, bulk, outcome }: {
  items: MeetingSuggestion[];
  agentName: string;
  /** Absent for members who only view the inbox. Resolves true once it was added. */
  onAdd?: (item: MeetingSuggestion, edits?: SuggestionEdits) => Promise<boolean>;
  onSkip?: (item: MeetingSuggestion) => Promise<void>;
  /** The suggestion whose action is running. */
  pendingId: string | null;
  onAddAll?: () => void;
  /** Offered while the meeting still waits on someone and is not marked yet. */
  onNothingToDo?: () => void;
  bulk: 'add_all' | 'nothing' | null;
  outcome: SuggestionsOutcome | null;
}) {
  const busy = bulk !== null || pendingId !== null;
  // The project shows on each row only when the suggestions span more than one.
  const mixedProjects = new Set(items.map((item) => item.project_id)).size > 1;
  if (!items.length && !outcome && !onNothingToDo) return null;
  const spinner = <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  return (
    <section aria-labelledby="meeting-suggestions" className="mt-4 min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 sm:p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="meeting-suggestions" className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-white">
          <ListChecks size={15} className="text-brand-300" aria-hidden="true" />
          {items.length ? `${agentName} suggests (${items.length})` : 'Suggestions'}
        </h3>
        {(onNothingToDo || (onAddAll && items.length > 0)) && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {onNothingToDo && (
              <Tooltip content={items.length ? 'Skips every suggestion and marks the meeting handled. Undo puts them back.' : 'Marks the meeting handled, with no new work from it.'}>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onNothingToDo}
                  icon={bulk === 'nothing' ? spinner : <CircleSlash size={13} aria-hidden="true" />}>
                  Nothing to do
                </Button>
              </Tooltip>
            )}
            {onAddAll && items.length > 0 && (
              <Button size="sm" disabled={busy} onClick={onAddAll} icon={bulk === 'add_all' ? spinner : <Plus size={13} aria-hidden="true" />}>
                {items.length === 1 ? 'Add it' : `Add all ${items.length}`}
              </Button>
            )}
          </span>
        )}
      </div>
      {outcome && (
        <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-200" role="status">
          <Check size={13} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{outcome.text}</span>
          {outcome.onUndo && (
            <Button size="sm" variant="ghost" className="!rounded-md !px-2 !py-0.5" disabled={outcome.undoing || busy} onClick={outcome.onUndo}
              icon={outcome.undoing ? spinner : <Undo2 size={12} aria-hidden="true" />}>
              Undo
            </Button>
          )}
        </p>
      )}
      {items.length > 0 ? (
        <div className="mt-3 space-y-3">
          {SUGGESTION_GROUPS.map((group) => {
            const inGroup = items.filter((item) => groupOf(item) === group.key);
            if (!inGroup.length) return null;
            return (
              <div key={group.key} className="min-w-0 space-y-1.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                  {group.icon}
                  {inGroup.length === 1 ? group.one : group.many} ({inGroup.length})
                </p>
                <ul className="space-y-2" aria-label={group.many}>
                  {inGroup.map((item) => (
                    <SuggestionRow key={item.id} item={item} onAdd={onAdd} onSkip={onSkip} pending={pendingId === item.id} busy={busy}
                      showProject={mixedProjects} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : !outcome && (
        <p className="mt-1.5 text-xs text-zinc-400">No suggestions are waiting.</p>
      )}
    </section>
  );
}

type SuggestionGroup = 'task' | 'reminder' | 'comment' | 'other';

/** The checklist in the order a person settles it: new work, then follow-ups, then notes on work that exists. */
const SUGGESTION_GROUPS: { key: SuggestionGroup; one: string; many: string; icon: ReactNode }[] = [
  { key: 'task', one: 'New task', many: 'New tasks', icon: <SquarePlus size={12} aria-hidden="true" /> },
  { key: 'reminder', one: 'Reminder', many: 'Reminders', icon: <Bell size={12} aria-hidden="true" /> },
  { key: 'comment', one: 'Comment on an existing task', many: 'Comments on existing tasks', icon: <MessageSquare size={12} aria-hidden="true" /> },
  { key: 'other', one: 'Other change', many: 'Other changes', icon: <ListChecks size={12} aria-hidden="true" /> },
];

function groupOf(item: MeetingSuggestion): SuggestionGroup {
  if (item.type === 'create_task') return 'task';
  if (item.type === 'add_reminder') return 'reminder';
  if (item.type === 'comment') return 'comment';
  return 'other';
}

/** The row's headline under its group: the title alone, without the "New task:" a group heading already says. */
function headline(item: MeetingSuggestion): string {
  if (item.type === 'create_task' || item.type === 'add_reminder') return item.title || item.label;
  // A task whose name is unknown keeps the whole label ("Comment on a task").
  if (item.type === 'comment') return item.label === 'Comment on a task' ? item.label : item.label.replace(/^Comment on /, '');
  return item.label;
}

/** A body longer than this folds to three lines with "Show more". */
const BODY_FOLD = 220;

function SuggestionRow({ item, onAdd, onSkip, pending, busy, showProject }: {
  item: MeetingSuggestion;
  onAdd?: (item: MeetingSuggestion, edits?: SuggestionEdits) => Promise<boolean>;
  onSkip?: (item: MeetingSuggestion) => Promise<void>;
  pending: boolean;
  busy: boolean;
  showProject: boolean;
}) {
  const changeable = !!onAdd && (item.type === 'create_task' || item.type === 'add_reminder');
  const [changing, setChanging] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(item.title ?? '');
  const [due, setDue] = useState(item.due_date ?? '');
  const spinner = <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  const addChanged = () => {
    const edits: SuggestionEdits = {};
    if (title.trim() && title.trim() !== (item.title ?? '')) edits.title = title.trim();
    if (item.type === 'create_task' && (due || null) !== (item.due_date ?? null)) edits.due_date = due || null;
    // A failed add keeps the editor open with the edits, to try again.
    void onAdd?.(item, edits).then((added) => { if (added) setChanging(false); });
  };
  const name = headline(item);
  // A comment's task opens where it lives, so the person can read it before adding to it.
  const taskHref = item.type === 'comment' && item.task_id && item.project_id ? `/projects/${item.project_id}?task=${item.task_id}` : null;
  const long = (item.body?.length ?? 0) > BODY_FOLD;
  return (
    <li className="min-w-0 rounded-lg bg-white/[0.03] px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* Phones: the text takes the whole row and the buttons wrap under it. */}
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
          <p className="break-words text-sm font-medium text-zinc-100 [overflow-wrap:anywhere]">
            {taskHref ? (
              <Link href={taskHref} className="rounded underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                {name}
              </Link>
            ) : name}
            {item.type === 'create_task' && item.due_date && (
              <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-white/[0.06] px-1.5 py-px align-middle text-[11px] font-normal text-zinc-300">
                <CalendarClock size={11} aria-hidden="true" />
                Due {formatDay(`${item.due_date}T12:00:00`)}
              </span>
            )}
            {item.type === 'add_reminder' && item.remind_on && (
              <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-white/[0.06] px-1.5 py-px align-middle text-[11px] font-normal text-zinc-300">
                <Bell size={11} aria-hidden="true" />
                {formatDay(`${item.remind_on}T12:00:00`)}
              </span>
            )}
          </p>
          {showProject && item.project_name && <p className="mt-0.5 truncate text-[11px] text-zinc-400">{item.project_name}</p>}
          {item.body && (
            <div className="mt-1">
              <p className={`whitespace-pre-line break-words text-xs leading-relaxed text-zinc-300 [overflow-wrap:anywhere] ${long && !open ? 'line-clamp-3' : ''}`}>
                {item.body}
              </p>
              {long && (
                <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
                  className="mt-0.5 rounded text-[11px] font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  {open ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
          {item.evidence && (
            <p className="mt-1 break-words text-[11px] italic text-zinc-400 [overflow-wrap:anywhere]">
              <span className="not-italic text-zinc-500">Said: </span>{item.evidence}
            </p>
          )}
        </div>
        {(onAdd || onSkip) && !changing && (
          <span className="ml-auto flex flex-shrink-0 items-center gap-1">
            {changeable && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(true)} aria-label={`Change: ${item.label}`}
                icon={<PenLine size={12} aria-hidden="true" />}>
                Change
              </Button>
            )}
            {onSkip && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onSkip(item)} aria-label={`Skip: ${item.label}`}
                icon={<X size={12} aria-hidden="true" />}>
                Skip
              </Button>
            )}
            {onAdd && (
              <Button size="sm" disabled={busy} onClick={() => void onAdd(item)} aria-label={`Add: ${item.label}`}
                icon={pending ? spinner : <Plus size={12} aria-hidden="true" />}>
                Add
              </Button>
            )}
          </span>
        )}
      </div>
      {changing && (
        <div className="mt-2.5 space-y-2.5 border-t border-white/[0.06] pt-2.5">
          <div className={`grid gap-2.5 ${item.type === 'create_task' ? 'sm:grid-cols-[minmax(0,1fr)_11rem]' : ''}`}>
            <TextInput label="Title" size="sm" value={title} onChange={setTitle} maxLength={500} autoFocus />
            {item.type === 'create_task' && <DateInput label="Due" size="sm" value={due} onChange={setDue} clearable />}
          </div>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(false)}>Cancel</Button>
            <Button size="sm" disabled={busy || !title.trim()} onClick={addChanged} icon={pending ? spinner : <Plus size={12} aria-hidden="true" />}>
              Add
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Speaker lines in a transcript: "Dana Lee: words" (a short name, then the words). */
const SPEAKER_LINE = /^([^:\n]{1,60}?):\s+(.+)$/;
/** Past this the reader shows the start and points at the file for the rest. */
const READER_CHARS = 400_000;

/**
 * A meeting package's words, read in place: a scrolling panel in the app's
 * own type (never monospace), each speaker's name set apart from what they
 * said. The whole file stays a click away in the list under it.
 */
export function TranscriptReader({ attachment, kind }: { attachment: InboxAttachment; kind: MeetingPackageKind }) {
  const read = useRead(attachment.available ? inboxFileTextRead(attachment.id) : null);
  // Starts short so the suggestions under it stay in reach; opens to most of the screen to read it through.
  const [tall, setTall] = useState(false);
  const label = MEETING_PACKAGE_LABELS[kind];
  const lines = useMemo(() => {
    const text = read.data ?? '';
    return text.slice(0, READER_CHARS).replace(/\r\n?/g, '\n').split('\n');
  }, [read.data]);
  if (!attachment.available) return null;
  if (read.failed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-zinc-300">
        <span className="min-w-0 flex-1">Could not load the {label.toLowerCase()}. The file is listed below.</span>
        <Button size="sm" variant="ghost" onClick={read.reload} icon={<RefreshCw size={12} aria-hidden="true" />}>Try again</Button>
      </div>
    );
  }
  if (read.data === undefined) {
    return (
      <div className="space-y-2 rounded-lg bg-white/[0.03] p-3" aria-busy="true" aria-label={`Loading the ${label.toLowerCase()}`}>
        {[0.9, 0.75, 0.85, 0.6].map((width, i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" style={{ width: `${width * 100}%` }} />
        ))}
      </div>
    );
  }
  const cut = (read.data?.length ?? 0) > READER_CHARS;
  return (
    <div className="min-w-0 space-y-1.5">
    <div
      role="region"
      aria-label={label}
      // Focusable so the keyboard can scroll it.
      tabIndex={0}
      className={`${tall ? 'max-h-[70vh]' : 'max-h-56'} overflow-y-auto rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm leading-relaxed text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
    >
      {lines.map((line, index) => {
        if (!line.trim()) return <div key={index} className="h-2" aria-hidden="true" />;
        const speaker = SPEAKER_LINE.exec(line);
        return (
          <p key={index} className="break-words [overflow-wrap:anywhere]">
            {speaker ? (
              <Fragment>
                <span className="font-semibold text-white">{speaker[1]}</span>
                <span className="text-zinc-400">: </span>
                {speaker[2]}
              </Fragment>
            ) : line}
          </p>
        );
      })}
      {cut && <p className="mt-3 text-xs text-zinc-400">That is the first part. Download the file below to read the rest.</p>}
    </div>
    {lines.length > 12 && (
      <button type="button" onClick={() => setTall((value) => !value)} aria-expanded={tall}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        {tall ? 'Show less' : `Read the whole ${kind === 'transcript' ? 'transcript' : 'notes'}`}
        <ChevronDown size={12} className={`transition-transform motion-reduce:transition-none ${tall ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
    )}
    </div>
  );
}

/**
 * The lines of a meeting message's text worth showing over the header: the
 * script's note on the package and the organizer's description. The rest
 * (subject, source, when, who, length, Doc) the header already shows.
 */
export function meetingNoteLines(text: string | null): string[] {
  if (!text) return [];
  const known = /^(Meeting transcript:|Meeting summary:|Source:|When:|Organizer:|Attendees:|Length:|Doc:)/;
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !known.test(line));
}
