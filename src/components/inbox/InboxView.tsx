'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Bell, Flame, Inbox as InboxIcon, Mail, Paperclip, RefreshCw, Search, Sparkles, SquareCheck, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import { INBOX_TAB_LABELS, INBOX_TABS, type InboxSummary, type InboxTab, type InboxTabCounts, type InboxThreadSummary } from '@/lib/inbound-email/inbox-types';
import { isInboxTab } from '@/lib/inbound-email/inbox-view';
import { ThreadStateBadge, TrustBadge, formatListTime, projectSourceHint } from './inbox-badges';
import { Tooltip } from '@/components/ui/Tooltip';
import { ThreadView } from './ThreadView';
import { SenderRulesManager } from './SenderRulesManager';
import { InboxEmptyState } from './InboxEmptyState';
import { useInboxUpdates } from './use-inbox-updates';

const PAGE_SIZE = 50;
/** The most a quiet refresh re-reads at once (the route's cap). */
const MAX_REFRESH = 1000;

type LoadOptions =
  /** First page for the current filters, with the skeleton on first load. */
  | { mode: 'reset' }
  /** The next page, from `offset`. */
  | { mode: 'append'; offset: number }
  /** Every page already on screen, in place, without a spinner. */
  | { mode: 'refresh' };

interface InboxViewProps {
  /** Lock the list to one project (the project page's Emails panel). */
  projectId?: string;
  /** Inside another page: fills the host card's remaining height, no URL syncing. */
  embedded?: boolean;
  /** Embedded only: shown in place of both panes while nothing has arrived. */
  emptyState?: ReactNode;
  /** Embedded only: the host's toolbar search; the list then drops its own box. */
  searchQuery?: string;
}

/**
 * The Inbox: threads on the left, the selected thread on the right (one pane
 * at a time on mobile). Modelled on the client app's conversations screen,
 * minus everything that writes email: there is no compose, reply, forward or
 * New Email here, by rule.
 */
export function InboxView({ projectId, embedded = false, emptyState, searchQuery }: InboxViewProps) {
  const { isDemoMode } = useDemo();
  const { projects, tasks } = useApp();
  const { access } = useAuth();
  // Sender rules apply to every inbox: only inbox managers see and change them.
  const canManageRules = hasPermission(access, 'inbound_email.manage');
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const [rulesOpen, setRulesOpen] = useState(false);

  const [inboxId, setInboxId] = useState('');
  const [projectFilter, setProjectFilter] = useState(projectId ?? '');
  // The inbox for one task (/inbox?task=<id>, from the task's Communication).
  const [taskFilter, setTaskFilter] = useState('');
  const [tab, setTab] = useState<InboxTab>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(embedded);

  const [inboxes, setInboxes] = useState<InboxSummary[]>([]);
  const [threads, setThreads] = useState<InboxThreadSummary[]>([]);
  const [counts, setCounts] = useState<InboxTabCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const requestRef = useRef(0);
  /** What failed last, so Try again repeats it. */
  const failedRef = useRef<LoadOptions>({ mode: 'reset' });
  /** How many threads are on screen, for a refresh that keeps every loaded page. */
  const shownRef = useRef(0);
  /** A page asked for but not yet shown: a refresh that overtakes it fetches it too. */
  const pendingPageRef = useRef(0);
  useEffect(() => {
    shownRef.current = threads.length;
  }, [threads.length]);

  const lockedProject = projectId ?? null;
  const activeProject = lockedProject ?? (projectFilter || null);

  // Deep links: /inbox?thread=<id>&message=<id>&inbox=<id>&status=<tab>&project=<id>&q=<text>
  useEffect(() => {
    if (embedded) return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    if (isInboxTab(status)) setTab(status);
    setInboxId(params.get('inbox') ?? '');
    if (!lockedProject) setProjectFilter(params.get('project') ?? '');
    setTaskFilter(params.get('task') ?? '');
    const q = params.get('q') ?? '';
    setSearchInput(q);
    setSearch(q);
    setSelectedId(params.get('thread'));
    setFocusMessageId(params.get('message'));
    setUrlReady(true);
  }, [embedded, lockedProject]);

  useEffect(() => {
    if (embedded || !urlReady) return;
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null | undefined) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    set('thread', selectedId);
    set('message', selectedId ? focusMessageId : null);
    set('inbox', inboxId);
    set('status', tab === 'all' ? null : tab);
    set('project', lockedProject ? null : projectFilter);
    set('task', taskFilter);
    set('q', search.trim());
    window.history.replaceState(null, '', url.toString());
  }, [embedded, urlReady, selectedId, focusMessageId, inboxId, tab, projectFilter, taskFilter, lockedProject, search]);

  // Search waits for a pause in typing, whichever box it is typed in.
  const typedSearch = searchQuery ?? searchInput;
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typedSearch), 300);
    return () => window.clearTimeout(timer);
  }, [typedSearch]);

  // A new filter (a new `load`) starts over from the first page; a newer
  // request always wins, so a slow page never lands on the wrong filter.
  const load = useCallback(async (options: LoadOptions) => {
    if (!urlReady) return;
    const requestId = ++requestRef.current;
    if (options.mode === 'append') {
      pendingPageRef.current = PAGE_SIZE;
      setLoadingMore(true);
    } else if (options.mode === 'reset') {
      pendingPageRef.current = 0;
      setLoading(true);
    }
    try {
      const data = await client.listThreads({
        inboxId: inboxId || null,
        projectId: activeProject,
        taskId: taskFilter || null,
        tab,
        search,
        limit: options.mode === 'refresh' ? Math.min(Math.max(PAGE_SIZE, shownRef.current + pendingPageRef.current), MAX_REFRESH) : PAGE_SIZE,
        offset: options.mode === 'append' ? options.offset : 0,
      });
      if (requestRef.current !== requestId) return;
      setInboxes(data.inboxes);
      setThreads((current) => (options.mode === 'append' ? [...current, ...data.threads.filter((t) => !current.some((c) => c.id === t.id))] : data.threads));
      setCounts(data.counts);
      setTotal(data.total);
      setHasLoaded(true);
      setError('');
    } catch (err) {
      if (requestRef.current !== requestId) return;
      failedRef.current = options;
      setError(err instanceof Error ? err.message : 'Could not load the inbox');
    } finally {
      if (requestRef.current === requestId) {
        pendingPageRef.current = 0;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [client, urlReady, inboxId, activeProject, taskFilter, tab, search]);

  useEffect(() => { void load({ mode: 'reset' }); }, [load]);

  // Live updates, one source: realtime and actions both fire the inbox event.
  useInboxUpdates(() => { void load({ mode: 'refresh' }); });
  const retry = () => void load(failedRef.current);

  const projectColor = useCallback((id: string) => projects.find((p) => p.id === id)?.color, [projects]);
  const inboxOptions = [{ value: '', label: 'All inboxes' }, ...inboxes.map((inbox) => ({ value: inbox.id, label: inbox.enabled ? inbox.name : `${inbox.name} (disabled)` }))];
  const projectOptions = [
    { value: '', label: 'All projects' },
    ...projects
      .filter((p) => p.status !== 'archived')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  // One inbox needs no inbox filter; keep it while one is picked so it can be cleared.
  const showInboxFilter = inboxes.length > 1 || !!inboxId;
  // Plain rows: the status, then its count as quiet text on the right.
  const statusOptions = INBOX_TABS.map((key) => {
    const count = counts?.[key] ?? 0;
    const label = INBOX_TAB_LABELS[key];
    return {
      value: key,
      label,
      render: (
        <span className="flex w-full items-center justify-between gap-3">
          <span>{label}</span>
          {key !== 'all' && count > 0 && <span className="text-xs tabular-nums text-input-text-subtle">{count}</span>}
        </span>
      ),
    };
  });
  const filtersActive = tab !== 'all' || !!search.trim() || !!inboxId || !!taskFilter || (!lockedProject && !!projectFilter);
  const filteredTask = taskFilter ? tasks.find((task) => task.id === taskFilter) : null;
  // The full Inbox with nothing in it yet: one setup guide instead of two empty panes.
  // Updates and Filtered mail stay out of the Inbox; one quiet line says how much and opens each.
  const hiddenUpdates = tab === 'all' ? counts?.updates ?? 0 : 0;
  const hiddenFiltered = tab === 'all' ? counts?.ignored ?? 0 : 0;
  const hiddenLink = 'rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
  const filteredNote = (hiddenUpdates > 0 || hiddenFiltered > 0) && (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-3 text-xs text-zinc-400">
      <span>Not in your inbox:</span>
      {hiddenUpdates > 0 && (
        <button type="button" onClick={() => setTab('updates')} className={hiddenLink}>
          {hiddenUpdates} {hiddenUpdates === 1 ? 'update' : 'updates'}
        </button>
      )}
      {hiddenFiltered > 0 && (
        <button type="button" onClick={() => setTab('ignored')} className={hiddenLink}>
          {hiddenFiltered} filtered
        </button>
      )}
    </p>
  );
  const neverHadEmail = hasLoaded && threads.length === 0 && hiddenFiltered === 0 && hiddenUpdates === 0 && !filtersActive && !error && (!embedded || !!emptyState);
  const selectThread = useCallback((id: string | null, messageId: string | null = null) => {
    setSelectedId(id);
    setFocusMessageId(messageId);
  }, []);
  const clearSelection = useCallback(() => selectThread(null), [selectThread]);

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-white/[0.06] p-3">
        {searchQuery === undefined && (
          <TextInput
            type="search"
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Search email"
            leftIcon={Search}
            size="sm"
            aria-label="Search subject, sender or project"
          />
        )}
        {taskFilter && (
          <div className="flex items-center gap-2 rounded-lg bg-brand-500/[0.08] px-2.5 py-1.5 text-xs text-zinc-200">
            <SquareCheck size={13} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Email for <span className="font-medium text-white">{filteredTask?.title ?? 'one task'}</span></span>
            <button
              type="button"
              onClick={() => setTaskFilter('')}
              aria-label="Show all email"
              className="rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}
        {/* Status first, then project, sharing the row; an inbox filter (several inboxes) takes the next row. */}
        <div className={`grid gap-2 ${lockedProject && !showInboxFilter ? 'grid-cols-1' : 'grid-cols-2'}`}>
          <Select ariaLabel="Status" value={tab} onChange={(value) => isInboxTab(value) && setTab(value)} options={statusOptions} size="sm" />
          {!lockedProject && (
            <Select ariaLabel="Project" value={projectFilter} onChange={setProjectFilter} options={projectOptions} searchable size="sm" />
          )}
          {showInboxFilter && (
            <div className={lockedProject ? '' : 'col-span-2'}>
              <Select ariaLabel="Inbox" value={inboxId} onChange={setInboxId} options={inboxOptions} size="sm" />
            </div>
          )}
        </div>
      </div>

      {/* A later load failed: the list stays, with the problem and a retry above it. */}
      {error && hasLoaded && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-red-400/20 bg-red-500/[0.06] px-4 py-2.5">
          <AlertTriangle size={14} className="flex-shrink-0 text-red-300" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-xs text-zinc-200">{error}</p>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={retry} disabled={loading || loadingMore}>
            Try again
          </Button>
        </div>
      )}

      {(tab === 'updates' || tab === 'ignored') && (
        <p className="flex flex-wrap items-center gap-x-1.5 border-b border-white/[0.06] px-4 py-2 text-xs text-zinc-400">
          {tab === 'updates' ? 'Automatic mail nobody needs to act on.' : 'Mail nobody needs to read.'}
          {canManageRules && !isDemoMode ? (
            <button
              type="button"
              onClick={() => setRulesOpen(true)}
              className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Mail rules
            </button>
          ) : null}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {loading && !hasLoaded ? (
          <ul className="space-y-1 p-2" aria-label="Loading email">
            {Array.from({ length: 7 }).map((_, i) => (
              <li key={i} className="space-y-2 rounded-lg px-3 py-3">
                <div className="flex justify-between gap-3">
                  <div className="h-3.5 w-32 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
                  <div className="h-3 w-10 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
                </div>
                <div className="h-3 w-48 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
                <div className="h-3 w-full animate-pulse rounded bg-white/[0.04] motion-reduce:animate-none" />
              </li>
            ))}
          </ul>
        ) : error && !hasLoaded ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <AlertTriangle size={28} className="text-red-400" aria-hidden="true" />
            <p className="text-sm text-zinc-300">{error}</p>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={retry}>
              Try again
            </Button>
          </div>
        ) : threads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
            <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]">
              <Mail size={18} className="text-zinc-400" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-300">{filtersActive ? 'No email matches' : hiddenFiltered || hiddenUpdates ? 'Nothing that needs reading' : 'No email yet'}</p>
            {!hiddenFiltered && !hiddenUpdates && (
              <p className="text-xs text-zinc-400">
                {filtersActive
                  ? 'Try another status, inbox or search.'
                  : lockedProject
                    ? 'Client email mapped to this project will appear here.'
                    : 'Client email forwarded to an agent inbox will appear here.'}
              </p>
            )}
            {filteredNote}
          </div>
        ) : (
          <>
            <ul className="space-y-0.5 p-1.5">
              {threads.map((thread) => {
                const active = thread.id === selectedId;
                const attention = thread.needs_you || thread.needs_reply;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => selectThread(thread.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`relative w-full rounded-xl px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                        active
                          ? 'bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-inset ring-white/[0.08]'
                          : 'hover:bg-white/[0.035]'
                      }`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <SenderLine thread={thread} strong={attention || thread.has_new} />
                        <span className="flex-shrink-0 text-xs tabular-nums text-zinc-400">{formatListTime(thread.last_message_at)}</span>
                      </span>
                      <span className={`mt-0.5 block truncate text-[13px] ${attention ? 'text-zinc-100' : 'text-zinc-300'}`}>{thread.subject || '(no subject)'}</span>
                      {/* Where the thread stands, when the agent has said; else the newest email's opening. */}
                      {thread.summary ? (
                        <span className="mt-0.5 line-clamp-1 text-xs text-zinc-300"><span className="sr-only">Where it stands: </span>{thread.summary}</span>
                      ) : thread.snippet && <span className="mt-0.5 line-clamp-1 text-xs text-zinc-400">{thread.snippet}</span>}
                      {/* The project leads the details: which client, then what the thread led to. */}
                      {(!lockedProject || thread.state === 'needs_you' || thread.state === 'needs_reply' || thread.urgent || thread.untrusted || thread.task_count > 0 || thread.reminder_count > 0 || thread.attachment_count > 0) && (
                        <span className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                          {!lockedProject && (thread.project ? (
                            <Tooltip content={`${thread.project.name}: ${projectSourceHint(thread.project, 'The agent')}`}>
                              <span className="inline-flex max-w-[170px] items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
                                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: projectColor(thread.project.id) ?? 'currentColor' }} aria-hidden="true" />
                                <span className="truncate">{thread.project.name}</span>
                                {(thread.project.source === 'inferred' || thread.project.source === 'guessed') && (
                                  <>
                                    <Sparkles size={10} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
                                    <span className="sr-only">({thread.project.source}, needs confirming)</span>
                                  </>
                                )}
                              </span>
                            </Tooltip>
                          ) : thread.state !== 'ignored' && (
                            <Tooltip content="No project yet. Open the thread to set one.">
                              <span className="rounded-full border border-dashed border-white/[0.16] px-2 py-0.5 text-[11px] text-zinc-400">No project</span>
                            </Tooltip>
                          ))}
                          {(thread.state === 'needs_you' || thread.state === 'needs_reply') && <ThreadStateBadge state={thread.state} />}
                          {thread.urgent && (
                            <Tooltip content="The agent marked this urgent">
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-300">
                                <Flame size={11} aria-hidden="true" />
                                Urgent
                              </span>
                            </Tooltip>
                          )}
                          {thread.untrusted && (
                            <Tooltip content="The sender could not be verified. Treat any request with care.">
                              <TrustBadge level="untrusted" compact />
                            </Tooltip>
                          )}
                          <ThreadCount icon={SquareCheck} count={thread.task_count} one="task" many="tasks" hint="this thread created, changed or is about" />
                          <ThreadCount icon={Bell} count={thread.reminder_count} one="open reminder" many="open reminders" hint="set from this thread" />
                          <ThreadCount icon={Paperclip} count={thread.attachment_count} one="attachment" many="attachments" hint="in this thread" />
                          {!inboxId && inboxes.length > 1 && <span className="ml-auto text-[11px] text-zinc-400">{thread.inbox_name}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {threads.length < total && (
              <div className="flex justify-center border-t border-white/[0.06] p-3">
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void load({ mode: 'append', offset: threads.length })}>
                  {loadingMore ? 'Loading...' : `Load more (${threads.length} of ${total})`}
                </Button>
              </div>
            )}
            {threads.length >= total && filteredNote}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={embedded ? 'min-h-0 flex-1 overflow-hidden' : 'glass-card overflow-hidden rounded-xl'}
      style={embedded ? undefined : { height: 'calc(100dvh - 150px)', minHeight: 520 }}
    >
      <SenderRulesManager isOpen={rulesOpen} onClose={() => setRulesOpen(false)} onChanged={() => void load({ mode: 'refresh' })} />
      {neverHadEmail ? (embedded ? emptyState : <InboxEmptyState inboxes={inboxes} />) : (
      <div className="grid h-full grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <div className={`h-full min-h-0 lg:border-r lg:border-white/[0.06] ${selectedId ? 'hidden lg:block' : 'block'}`}>{list}</div>
        <div className={`h-full min-h-0 flex-col ${selectedId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedId ? (
            <>
              <div className="min-h-0 flex-1">
                <ThreadView
                  key={selectedId}
                  threadId={selectedId}
                  focusMessageId={focusMessageId}
                  onMissing={clearSelection}
                  onBack={() => selectThread(null)}
                />
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06]">
                <InboxIcon size={22} className="text-zinc-400" aria-hidden="true" />
              </div>
              <h2 className="text-sm font-semibold text-white">Pick a thread</h2>
              <p className="max-w-xs text-xs text-zinc-400">
                Read the email and what the agent did with it. Reply from your own mail; nothing is sent from here.
              </p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/** Who the thread is with, and how many emails it holds. */
function SenderLine({ thread, strong }: { thread: InboxThreadSummary; strong: boolean }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-sm ${strong ? 'font-semibold text-white' : 'font-medium text-zinc-200'}`}>
      <span className="truncate">{thread.sender?.name || thread.sender?.address || 'Unknown sender'}</span>
      {thread.message_count > 1 && (
        <span className="inline-flex flex-shrink-0 items-center gap-1 text-[11px] font-normal text-zinc-400">
          <Mail size={11} aria-hidden="true" />
          <span className="sr-only">{thread.message_count} emails</span>
          <span aria-hidden="true">{thread.message_count}</span>
        </span>
      )}
    </span>
  );
}

/** One thing a thread led to (tasks, reminders, files), shown only when there is any. */
function ThreadCount({ icon: Icon, count, one, many, hint }: { icon: typeof Paperclip; count: number; one: string; many: string; hint: string }) {
  if (count <= 0) return null;
  const label = `${count} ${count === 1 ? one : many}`;
  return (
    <Tooltip content={`${label} ${hint}`}>
      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
        <Icon size={11} aria-hidden="true" />
        <span className="sr-only">{label}</span>
        <span aria-hidden="true">{count}</span>
      </span>
    </Tooltip>
  );
}
