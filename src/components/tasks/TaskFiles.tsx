'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Check, Download, Eye, FileText, FolderOpen, Image as ImageIcon, Loader2, Mail, Plus, Upload, X } from 'lucide-react';
import type { Task } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { FileInput } from '@/components/ui/inputs/FileInput';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { CardAction } from '@/components/projects/TabLayout';
import { formatBytes, formatFullTime } from '@/components/inbox/inbox-badges';
import {
  downloadTaskFile, linkTaskFile, listTaskFiles, taskFileCandidates, taskFileViewUrl, trashTaskFile, uploadTaskFile,
  type TaskFileCandidates, type TaskFileView,
} from '@/lib/task-files/client';

// A task's files and what can be added to it (the Add menu's counts and
// lists), kept for the session: hovering a card fetches both, the panel
// refreshes them when it opens, and the menu and pickers open already full.
const filesCache = new Map<string, TaskFileView[]>();
const candidatesCache = new Map<string, TaskFileCandidates>();
const pending = new Map<string, Promise<unknown>>();

/** One request per task and kind at a time; the answer lands in its cache. */
function fetchInto<T>(cache: Map<string, T>, kind: string, taskId: string, load: (taskId: string) => Promise<T>): Promise<T> {
  const key = `${kind}:${taskId}`;
  const inFlight = pending.get(key) as Promise<T> | undefined;
  if (inFlight) return inFlight;
  const request = load(taskId)
    .then((value) => { cache.set(taskId, value); return value; })
    .finally(() => { pending.delete(key); });
  pending.set(key, request);
  return request;
}

const fetchFiles = (taskId: string) => fetchInto(filesCache, 'files', taskId, listTaskFiles);
const fetchCandidates = (taskId: string) => fetchInto(candidatesCache, 'candidates', taskId, taskFileCandidates);

/** Warm a task's files (and, for someone who can add, its Add menu) before it opens. */
export function usePrefetchTaskFiles(): (taskId: string) => void {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const canRead = hasPermission(access, 'files.read') || hasPermission(access, 'files.manage');
  const canAdd = hasPermission(access, 'files.upload');
  return (taskId: string) => {
    if (isDemoMode || !canRead) return;
    if (!filesCache.has(taskId)) void fetchFiles(taskId).catch(() => undefined);
    if (canAdd && !candidatesCache.has(taskId)) void fetchCandidates(taskId).catch(() => undefined);
  };
}

type Picker = 'email' | 'project';

/**
 * The task's Files: its own uploads and the email attachments and project
 * files linked to it (never copied). Add from the device (or drop files on
 * the section), from the task's emails, or from the project's files. The
 * caller's `section` draws the heading, so it matches the panel or the page.
 */
export function TaskFiles({ task, section }: {
  task: Task;
  section: (parts: { count?: ReactNode; action?: ReactNode; children: ReactNode }) => ReactNode;
}) {
  const { teamMemberId, access } = useAuth();
  const { isDemoMode } = useDemo();
  const canRead = hasPermission(access, 'files.read') || hasPermission(access, 'files.manage');
  const canAdd = hasPermission(access, 'files.upload');
  const canManage = hasPermission(access, 'files.manage');

  const [loaded, setLoaded] = useState<{ taskId: string; files: TaskFileView[] } | null>(null);
  const [uploading, setUploading] = useState<{ key: string; name: string }[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [candidates, setCandidates] = useState<{ taskId: string; value: TaskFileCandidates } | null>(null);
  const [preview, setPreview] = useState<TaskFileView | null>(null);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = canRead && !isDemoMode;

  // Both are refreshed on open; the kept copies show meanwhile.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchFiles(task.id)
      .then((files) => { if (!cancelled) setLoaded({ taskId: task.id, files }); })
      .catch(() => undefined);
    if (canAdd) {
      fetchCandidates(task.id)
        .then((value) => { if (!cancelled) setCandidates({ taskId: task.id, value }); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [enabled, canAdd, task.id]);

  const files = loaded?.taskId === task.id ? loaded.files : filesCache.get(task.id) ?? null;
  const setFiles = (update: (current: TaskFileView[]) => TaskFileView[]) => {
    const next = update(files ?? []);
    filesCache.set(task.id, next);
    setLoaded({ taskId: task.id, files: next });
  };
  // A file the task already had comes back as that entry: keep one of each.
  const keep = (file: TaskFileView) => setFiles((current) => [...current.filter((f) => f.id !== file.id), file]);

  // After an add or a removal, so "Added" stays true; quietly, in the background.
  const refreshCandidates = () => {
    fetchCandidates(task.id)
      .then((value) => setCandidates({ taskId: task.id, value }))
      .catch(() => undefined);
  };
  const shownCandidates = candidates?.taskId === task.id ? candidates.value : candidatesCache.get(task.id) ?? null;

  const upload = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = `${file.name}:${file.size}:${Date.now()}`;
      setUploading((current) => [...current, { key, name: file.name }]);
      try {
        keep(await uploadTaskFile(task.id, file));
      } catch (error) {
        toast('error', error instanceof Error ? error.message : `Could not add ${file.name}`);
      } finally {
        setUploading((current) => current.filter((row) => row.key !== key));
      }
    }
    refreshCandidates();
  };

  const remove = async (file: TaskFileView) => {
    try {
      await trashTaskFile(task.id, file.id);
      setFiles((current) => current.filter((f) => f.id !== file.id));
      refreshCandidates();
      toast('success', `Removed ${file.name}. It is in Trash if you need it back.`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove the file');
    }
  };

  const download = (file: TaskFileView) => {
    downloadTaskFile(task.id, file.id).catch((error) => toast('error', error instanceof Error ? error.message : 'Could not download the file'));
  };

  // Stable while open: the preview refetches whenever its file object changes.
  const previewFile = useMemo(
    () => (preview ? { name: preview.name, file_url: taskFileViewUrl(task.id, preview.id), mime_type: preview.mime_type } : null),
    [preview, task.id],
  );

  if (!enabled) return null;

  const dropProps = canAdd ? {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      void upload(event.dataTransfer.files);
    },
  } : {};

  const toggleMenu = () => setMenuOpen((open) => !open);
  const empty = files !== null && files.length === 0 && uploading.length === 0;
  const menu = canAdd && (
      <Popover
        anchorRef={menuRef}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        align={empty ? 'start' : 'end'}
        width={232}
        className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
      >
        <MenuItem icon={Upload} label="Upload from device" onClick={() => { setMenuOpen(false); inputRef.current?.click(); }} />
        <MenuItem
          icon={Mail}
          label="From this task's emails"
          hint={shownCandidates ? String(shownCandidates.email_attachments.length) : undefined}
          disabled={shownCandidates?.email_attachments.length === 0}
          onClick={() => { setMenuOpen(false); setPicker('email'); }}
        />
        <MenuItem
          icon={FolderOpen}
          label="From project files"
          hint={shownCandidates ? String(shownCandidates.project_files.length) : undefined}
          disabled={shownCandidates?.project_files.length === 0}
          onClick={() => { setMenuOpen(false); setPicker('project'); }}
        />
      </Popover>
  );
  // Empty, the section's own "+ Add a file" row opens the menu; with files, the heading does.
  const action = canAdd && !empty ? (
    <div ref={menuRef}>
      <CardAction onClick={toggleMenu} aria-expanded={menuOpen} aria-label="Add a file">
        <Plus size={14} aria-hidden="true" />
        Add
      </CardAction>
      {menu}
    </div>
  ) : undefined;

  const count = files && files.length > 0 ? files.length : undefined;
  const body = (
    <div {...dropProps} className={`relative rounded-lg transition-colors ${dragging ? 'bg-brand-500/[0.08] ring-2 ring-brand-500/60' : ''}`}>
      {canAdd && (
        <FileInput
          ref={inputRef}
          className="hidden"
          multiple
          aria-label="Choose files to add to this task"
          onChange={(event) => {
            if (event.target.files?.length) void upload(event.target.files);
            event.target.value = '';
          }}
        />
      )}

      {files === null ? (
        <ul className="space-y-1.5" aria-busy="true" aria-label="Loading files">
          {[0, 1].map((i) => (
            <li key={i} className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] p-2">
              <div className="h-8 w-8 animate-pulse rounded-md bg-white/[0.08] motion-reduce:animate-none" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-white/[0.05] motion-reduce:animate-none" />
              </div>
            </li>
          ))}
        </ul>
      ) : empty ? (
        canAdd ? (
          <div ref={menuRef}>
            <button
              type="button"
              onClick={toggleMenu}
              aria-expanded={menuOpen}
              className="w-full flex items-center gap-2 -mx-2 px-2 py-1.5 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Plus size={16} aria-hidden="true" />
              Add a file, or drop one here
            </button>
            {menu}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No files.</p>
        )
      ) : (
        <ul className="space-y-1.5">
          {files.map((file) => (
            <FileRow
              key={file.id}
              taskId={task.id}
              projectId={task.project_id}
              file={file}
              onPreview={() => setPreview(file)}
              onDownload={() => download(file)}
              onRemove={(file.added_by === teamMemberId ? canAdd || canManage : canManage) ? () => void remove(file) : undefined}
            />
          ))}
          {uploading.map((row) => (
            <li key={row.key} className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <Loader2 size={16} className="flex-shrink-0 animate-spin text-zinc-400 motion-reduce:animate-none" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{row.name}</span>
              <span className="text-[11px] text-zinc-400">Uploading</span>
            </li>
          ))}
        </ul>
      )}

      {dragging && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-surface/80 text-sm font-medium text-brand-200">
          Drop to add to this task
        </p>
      )}
      <span className="sr-only" aria-live="polite">{uploading.length > 0 ? `Uploading ${uploading.length} file${uploading.length === 1 ? '' : 's'}` : ''}</span>

      <FilePreviewModal isOpen={!!preview} onClose={() => setPreview(null)} file={previewFile} />
      {picker && (
        <CandidatePicker
          kind={picker}
          candidates={shownCandidates}
          onClose={() => setPicker(null)}
          onAdd={async (source) => {
            try {
              const file = await linkTaskFile(task.id, source);
              keep(file);
              refreshCandidates();
              return file;
            } catch (error) {
              toast('error', error instanceof Error ? error.message : 'Could not add the file');
              return null;
            }
          }}
          onRemove={async (fileId) => {
            try {
              await trashTaskFile(task.id, fileId);
              setFiles((current) => current.filter((f) => f.id !== fileId));
              refreshCandidates();
              return true;
            } catch (error) {
              toast('error', error instanceof Error ? error.message : 'Could not remove the file');
              return false;
            }
          }}
        />
      )}
    </div>
  );

  return <>{section({ count, action, children: body })}</>;
}

function MenuItem({ icon: Icon, label, hint, disabled = false, onClick }: { icon: typeof Upload; label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white transition-colors focus:outline-none focus-visible:bg-white/[0.06] disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent"
    >
      <Icon size={14} className="text-zinc-400" aria-hidden="true" />
      {label}
      {hint !== undefined && <span className="ml-auto font-mono text-xs tabular-nums text-zinc-400">{hint}</span>}
    </button>
  );
}

/**
 * Where a linked file comes from, in a few words, with the email one click
 * away: in the project's Communication tab when the task is open there, as
 * the task's email list links it.
 */
function sourceLabel(file: TaskFileView, emailHref: (threadId: string, messageId: string) => string): ReactNode {
  if (!file.available) return 'No longer available';
  if (file.source?.type === 'email') {
    if (!file.source.thread_id || !file.source.message_id) return 'From an email';
    return (
      <Link
        href={emailHref(file.source.thread_id, file.source.message_id)}
        className="rounded text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        From &ldquo;{file.source.subject || 'an email'}&rdquo;
      </Link>
    );
  }
  if (file.source?.type === 'project_file') return 'Project file';
  return null;
}

function FileRow({ taskId, projectId, file, onPreview, onDownload, onRemove }: {
  taskId: string;
  projectId: string;
  file: TaskFileView;
  onPreview: () => void;
  onDownload: () => void;
  onRemove?: () => void;
}) {
  const Icon = file.preview === 'image' ? ImageIcon : FileText;
  const previewable = file.available && file.preview !== null;
  const pathname = usePathname();
  const inProject = !!pathname?.startsWith(`/projects/${projectId}`);
  const source = sourceLabel(file, (threadId, messageId) => inProject
    ? `/projects/${projectId}?tab=communication&thread=${threadId}&message=${messageId}`
    : `/inbox?thread=${threadId}&message=${messageId}`);
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
      {file.preview === 'image' && file.available ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed storage link, not a static asset
        <img src={taskFileViewUrl(taskId, file.id)} alt="" loading="lazy" className="h-9 w-9 flex-shrink-0 rounded-md border border-white/[0.08] object-cover" />
      ) : (
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-white/[0.04]">
          <Icon size={16} className="text-zinc-400" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {previewable ? (
          <button
            type="button"
            onClick={onPreview}
            aria-label={`Preview ${file.name}`}
            title={file.name}
            className="block max-w-full truncate rounded text-left text-xs font-medium text-zinc-100 underline decoration-white/20 underline-offset-2 hover:text-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {file.name}
          </button>
        ) : (
          <p className="truncate text-xs font-medium text-zinc-200" title={file.name}>{file.name}</p>
        )}
        <p className="truncate text-[11px] text-zinc-400">
          {formatBytes(file.file_size)}
          {source && <> · {source}</>}
        </p>
        {file.note && <p className="mt-0.5 text-[11px] leading-snug text-zinc-300">{file.note}</p>}
      </div>
      <div className="flex flex-shrink-0 items-center">
        {file.available && (
          <Tooltip content="Download">
            <button
              type="button"
              onClick={onDownload}
              aria-label={`Download ${file.name}`}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Download size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {onRemove && (
          <Tooltip content="Remove from task">
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${file.name} from this task`}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/**
 * Picks files that already exist (an email's attachments, the project's
 * files) and links them to the task, or takes them off again. A click shows
 * its result at once; the request runs behind it and a failure puts the row
 * back with a message.
 */
function CandidatePicker({ kind, candidates, onClose, onAdd, onRemove }: {
  kind: Picker;
  candidates: TaskFileCandidates | null;
  onClose: () => void;
  /** The task file it became, or null when adding failed (the caller says why). */
  onAdd: (source: { email_attachment_id: string } | { entity_file_id: string }) => Promise<TaskFileView | null>;
  /** Whether it came off; the caller says why not. */
  onRemove: (taskFileId: string) => Promise<boolean>;
}) {
  // What a click changed, ahead of the server: candidate id to the task file
  // holding it (null: not on the task). Busy rows wait for their request.
  const [changed, setChanged] = useState<Map<string, string | null>>(new Map());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState<{ name: string; file_url: string; mime_type: string } | null>(null);
  const mark = (id: string, fileId: string | null | undefined) => setChanged((current) => {
    const next = new Map(current);
    if (fileId === undefined) next.delete(id);
    else next.set(id, fileId);
    return next;
  });
  const setBusyRow = (id: string, on: boolean) => setBusy((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  // Each file opens where it lives: an email's through the Inbox's own link,
  // a project file at its address. Pasted screenshots are all "image.png",
  // so an image shows itself.
  const rows = candidates
    ? kind === 'email'
      ? candidates.email_attachments.map((a) => ({
          id: a.id, name: a.name, size: a.file_size, mime_type: a.mime_type, taskFileId: a.task_file_id, preview: a.preview,
          url: `/api/workspace/inbox/attachments/${a.id}/view`,
          subject: a.subject || 'No subject', date: a.received_at, conversations: a.conversation_count,
        }))
      : candidates.project_files.map((f) => ({
          id: f.id, name: f.name, size: f.file_size, mime_type: f.mime_type, taskFileId: f.task_file_id, preview: f.preview, url: f.url,
          subject: null, date: f.created_at, conversations: 0,
        }))
    : null;

  const toggle = async (id: string, holding: string | null) => {
    setBusyRow(id, true);
    if (holding) {
      mark(id, null);
      if (!(await onRemove(holding))) mark(id, undefined);
    } else {
      mark(id, 'pending');
      const file = await onAdd(kind === 'email' ? { email_attachment_id: id } : { entity_file_id: id });
      mark(id, file ? file.id : undefined);
    }
    setBusyRow(id, false);
  };

  return (
    <Modal isOpen onClose={onClose} title={kind === 'email' ? "From this task's emails" : 'From project files'} size="2xl">
      <p className="sr-only">
        {kind === 'email' ? 'Attachments of the emails linked to this task.' : "Files on this task's project."} Adding links the file; nothing is copied.
      </p>
      {rows === null ? (
        <p className="py-6 text-center text-sm text-zinc-400" aria-busy="true">Loading files</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-400">
          {kind === 'email' ? 'The emails linked to this task have no attachments.' : 'This project has no files yet.'}
        </p>
      ) : (
        <ul className="max-h-[65vh] space-y-2 overflow-y-auto">
          {rows.map((row) => {
            const holding = changed.has(row.id) ? changed.get(row.id)! : row.taskFileId;
            const added = holding !== null;
            const open = () => setPreviewing({ name: row.name, file_url: row.url, mime_type: row.mime_type });
            return (
              <li key={row.id} className="flex items-center gap-3 sm:gap-3.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 sm:p-3">
                {row.preview === 'image' ? (
                  // A second way in for the mouse; the eye button is the one keyboards and screen readers get.
                  <button type="button" tabIndex={-1} aria-hidden="true" onClick={open} className="flex-shrink-0 rounded-md">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage link, not a static asset */}
                    <img src={row.url} alt="" loading="lazy" className="h-12 w-12 sm:h-14 sm:w-14 rounded-lg border border-white/[0.08] object-cover transition-opacity hover:opacity-80" />
                  </button>
                ) : (
                  <span className="flex h-12 w-12 sm:h-14 sm:w-14 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.04]">
                    <FileText size={20} className="text-zinc-400" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-100" title={row.name}>{row.name}</p>
                  {row.subject && <p className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-300" title={row.subject}>{row.subject}</p>}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
                    <span className="whitespace-nowrap">{formatBytes(row.size)} · {formatFullTime(row.date)}</span>
                    {row.conversations > 1 && (
                      <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                        In {row.conversations} conversations
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  {row.preview && (
                    <Tooltip content="Preview">
                      <button
                        type="button"
                        onClick={open}
                        aria-label={`Preview ${row.name}`}
                        className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        <Eye size={16} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  {added ? (
                    <Tooltip content="Remove from task">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Check size={14} aria-hidden="true" />}
                        onClick={() => void toggle(row.id, holding === 'pending' ? null : holding)}
                        disabled={busy.has(row.id)}
                        aria-label={`${row.name} is on this task. Remove it`}
                      >
                        Added
                      </Button>
                    </Tooltip>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void toggle(row.id, null)}
                      disabled={busy.has(row.id)}
                      aria-label={`Add ${row.name} to this task`}
                    >
                      Add
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <FilePreviewModal isOpen={!!previewing} onClose={() => setPreviewing(null)} file={previewing} />
    </Modal>
  );
}
