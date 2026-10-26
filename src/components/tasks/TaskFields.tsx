'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Check, Plus, Search, X, type LucideIcon } from 'lucide-react';
import type { AiReadiness, Task } from '@/lib/types';
import { Popover } from '@/components/ui/Popover';
import { Avatar } from '@/components/ui/Avatar';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';

/**
 * The task's fields, edited where they are shown (the side panel and the task
 * page): click a value to change it. Each field takes its value and reports a
 * change, so a saved task (updateTask) and a new task's draft use the same
 * editors. Text saves on Enter (the description on Ctrl or Cmd+Enter) or on
 * leaving the field; Escape puts the value back. Lists save each pick.
 */

export const STATUS_OPTIONS: { value: Task['status']; label: string; color: string }[] = [
  { value: 'backlog', label: 'Backlog', color: 'border border-dashed border-zinc-400' },
  { value: 'todo', label: 'To Do', color: 'bg-zinc-400' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-brand-500' },
  { value: 'in_review', label: 'In Review', color: 'bg-amber-500' },
  { value: 'done', label: 'Done', color: 'bg-emerald-500' },
];

export const PRIORITY_OPTIONS: { value: Task['priority']; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: 'bg-zinc-400' },
  { value: 'medium', label: 'Medium', color: 'bg-blue-500' },
  { value: 'high', label: 'High', color: 'bg-orange-500' },
  { value: 'urgent', label: 'Urgent', color: 'bg-red-500' },
];

// The due date edits in place, so it sheds the input chrome.
export const INLINE_DATE_CLASS = '!w-fit !justify-start !gap-1 !border-transparent !bg-transparent !shadow-none hover:!bg-white/[0.06] focus:!ring-0 focus:!border-transparent !px-1.5 !-mx-1.5 !py-0.5 !rounded-md';

export const WHO_DOES_IT: { value: AiReadiness | ''; label: string }[] = [
  { value: '', label: 'A person' },
  { value: 'needs_spec', label: 'Dev agent, needs spec' },
  { value: 'ai_ready', label: 'Dev agent, AI Ready' },
];

export const taskTypeLabel = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/** One row of the details list: an icon and label, then the value. */
export function DetailRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-xs text-zinc-400 min-h-7">
        <Icon size={14} aria-hidden="true" />
        {label}
      </dt>
      <dd className="min-w-0 flex items-center min-h-7">{children}</dd>
    </>
  );
}

// A value that turns into its editor in place: no box until it is clicked.
const EDITABLE = 'rounded-md -mx-1.5 px-1.5 text-left transition-colors hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
// The editor in place: the field's text, a quiet surface and a visible focus ring.
const IN_PLACE = '!border-transparent !bg-white/[0.04] !shadow-none !-mx-1.5 !px-1.5 focus:!ring-2 focus:!ring-brand-500';
// The title's editor is the title: same font, padding and height, only the
// hover's surface and a thin ring to show it has focus.
const TITLE_IN_PLACE = '!-mx-1.5 !px-1.5 !py-0 !border-0 !rounded-md !bg-white/[0.05] !shadow-none ![font:inherit] ![color:inherit] ![letter-spacing:inherit] focus-within:!ring-1 focus-within:!ring-white/25';
const MENU = 'bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1';
const MENU_ITEM = 'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:bg-white/[0.06]';

/** The title: a heading that becomes a text field. Empty puts the old title back. */
export function TitleField({ value, onChange, onSubmit, onTyping, canEdit, as: Tag = 'h2', id, className = '', placeholder = 'Task title', autoFocus = false }: {
  value: string;
  onChange: (title: string) => void;
  /** Enter, after the title is saved: a new task's draft creates the task. */
  onSubmit?: (title: string) => void;
  /** Each keystroke, before anything is saved (a draft's Create button follows it). */
  onTyping?: (text: string) => void;
  canEdit: boolean;
  as?: 'h1' | 'h2' | 'span';
  id?: string;
  className?: string;
  placeholder?: string;
  /** Open straight in the editor (a new task's draft). */
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(autoFocus ? value : null);
  if (!canEdit) return <Tag id={id} className={className}>{value}</Tag>;
  const save = () => {
    if (draft === null) return;
    const next = draft.replace(/\s+/g, ' ').trim();
    setDraft(null);
    onTyping?.(next || value);
    if (next && next !== value) onChange(next);
  };
  if (draft === null) {
    return (
      <Tag id={id} className={className}>
        <button type="button" onClick={() => setDraft(value)} className={`block w-full ${EDITABLE}`} aria-label={`Title: ${value}. Click to edit`}>
          {value || <span className="text-zinc-500">{placeholder}</span>}
        </button>
      </Tag>
    );
  }
  return (
    <div id={id} className={className}>
      <Textarea
        value={draft}
        onChange={(text) => {
          setDraft(text);
          onTyping?.(text);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const next = draft.replace(/\s+/g, ' ').trim();
            save();
            if (next) onSubmit?.(next);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
            onTyping?.(value);
          }
        }}
        autoFocus
        autoResize
        rows={1}
        minHeight="0"
        placeholder={placeholder}
        aria-label="Task title"
        inputClassName={TITLE_IN_PLACE}
      />
    </div>
  );
}

/** The description: its text, or a quiet prompt; a growing text box while editing. */
export function DescriptionField({ value, onChange, canEdit }: { value: string; onChange: (description: string) => void; canEdit: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = value.trim();
  if (draft === null) {
    if (!canEdit) {
      return text
        ? <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">{value}</p>
        : <p className="text-sm text-zinc-500">No description.</p>;
    }
    return (
      <button
        type="button"
        onClick={() => setDraft(value)}
        className={`block w-full py-1 text-sm leading-relaxed ${EDITABLE} ${text ? 'text-zinc-300 whitespace-pre-wrap break-words' : 'text-zinc-500'}`}
        aria-label={text ? 'Description. Click to edit' : 'Add a description'}
      >
        {text ? value : 'Add a description'}
      </button>
    );
  }
  const save = () => {
    const next = draft.trim();
    setDraft(null);
    if (next !== value.trim()) onChange(next);
  };
  return (
    <div>
      <Textarea
        value={draft}
        onChange={setDraft}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
          }
        }}
        autoFocus
        autoResize
        rows={4}
        maxHeight={480}
        placeholder="What needs doing, and anything worth knowing"
        aria-label="Description"
        inputClassName={`${IN_PLACE} !text-sm !leading-relaxed`}
      />
      <p className="mt-1 text-[11px] text-zinc-400">Saves when you click away. Ctrl+Enter to save now, Esc to cancel.</p>
    </div>
  );
}

export interface PickOption {
  value: string;
  label: string;
  /** Shown before the label: an avatar, a status dot. */
  leading?: ReactNode;
  /** Shown after it, quietly. */
  hint?: string;
}

/**
 * A value that opens a list to pick from: several (assignees, blockers) with
 * a search when the list is long, or one (task type). Each pick saves.
 */
export function PickField({ display, options, selected, onChange, multiple, canEdit, label, emptyText = 'None' }: {
  display: ReactNode | null;
  options: PickOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  multiple: boolean;
  canEdit: boolean;
  /** What is being picked, for screen readers ("Assignees"). */
  label: string;
  emptyText?: string;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = display ?? <span className="text-zinc-500">{emptyText}</span>;
  if (!canEdit) return <div className="min-w-0 flex-1 py-0.5">{shown}</div>;

  const searchable = options.length > 6;
  const needle = query.trim().toLowerCase();
  const visible = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;
  const pick = (value: string) => {
    if (multiple) {
      onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
    } else {
      onChange(selected[0] === value ? [] : [value]);
      setOpen(false);
    }
  };

  return (
    <div ref={anchor} className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setQuery(''); }}
        aria-expanded={open}
        aria-label={`${label}. Click to change`}
        className={`block w-full py-0.5 ${EDITABLE}`}
      >
        {shown}
      </button>
      <Popover anchorRef={anchor} open={open} onClose={() => setOpen(false)} align="start" width={288} className={MENU}>
        {searchable && (
          <div className="px-2 pb-1 pt-1">
            <TextInput size="sm" value={query} onChange={setQuery} placeholder="Search" leftIcon={Search} autoFocus aria-label={`Search ${label.toLowerCase()}`} />
          </div>
        )}
        <div role="listbox" aria-multiselectable={multiple || undefined} aria-label={label} className="max-h-72 overflow-y-auto">
          {visible.length === 0 && <p className="px-3 py-2 text-sm text-zinc-400">Nothing matches.</p>}
          {visible.map((option) => {
            const on = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => pick(option.value)}
                className={`${MENU_ITEM} ${on ? 'text-white' : 'text-zinc-300'}`}
              >
                {option.leading}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && <span className="flex-shrink-0 text-xs text-zinc-400">{option.hint}</span>}
                <Check size={14} className={`flex-shrink-0 ${on ? 'text-brand-300' : 'invisible'}`} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

/** People, as small avatar chips. */
export function PeopleChips({ people }: { people: { id: string; name: string; avatar?: string | null }[] }) {
  if (people.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {people.map((member) => (
        <span
          key={member.id}
          className="inline-flex items-center gap-1.5 max-w-full pl-1 pr-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-200"
        >
          <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
          <span className="truncate">{member.name}</span>
        </span>
      ))}
    </span>
  );
}

/** Tags as chips: x takes one off, "Add tag" opens a field (Enter or a comma adds). */
export function TagsField({ value, onChange, canEdit }: { value: string[]; onChange: (tags: string[]) => void; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = draft.split(',').map((tag) => tag.trim()).filter(Boolean);
    setDraft('');
    if (next.length) onChange([...new Set([...value, ...next])]);
  };
  if (!canEdit && value.length === 0) return <span className="text-zinc-500">None</span>;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5">
      {value.map((tag) => (
        <span key={tag} className="group inline-flex items-center gap-0.5 rounded-full bg-white/[0.06] py-0.5 pl-2 pr-1 text-xs text-zinc-300">
          {tag}
          {canEdit ? (
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={11} aria-hidden="true" />
            </button>
          ) : <span className="w-1" />}
        </span>
      ))}
      {canEdit && (adding ? (
        <div className="w-40">
          <TextInput
            size="sm"
            value={draft}
            onChange={setDraft}
            autoFocus
            placeholder="Tag name"
            aria-label="New tag"
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                add();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => { add(); setAdding(false); }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Plus size={12} aria-hidden="true" />
          {value.length ? 'Add' : 'Add tag'}
        </button>
      ))}
    </div>
  );
}
