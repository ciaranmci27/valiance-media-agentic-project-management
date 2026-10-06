'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Flame, HelpCircle, Inbox as InboxIcon, Mail, Paperclip, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import { INBOX_TAB_LABELS, INBOX_TABS, type InboxSummary, type InboxTab, type InboxTabCounts, type InboxThreadSummary } from '@/lib/inbound-email/inbox-types';
import { isInboxTab } from '@/lib/inbound-email/inbox-view';
import { ThreadStateBadge, TrustBadge, formatListTime } from './inbox-badges';
import { ThreadView } from './ThreadView';
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
}

/**
 * The Inbox: threads on the left, the selected thread on the right (one pane
 * at a time on mobile). Modelled on the client app's conversations screen,
 * minus everything that writes email: there is no compose, reply, forward or
 * New Email here, by rule.
 */
export function InboxView({ projectId, embedded = false, emptyState }: InboxViewProps) {
  const { isDemoMode } = useDemo();
  const { projects } = useApp();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);

  const [inboxId, setInboxId] = useState('');
  const [projectFilter, setProjectFilter] = useState(projectId ?? '');
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
    set('q', search.trim());
    window.history.replaceState(null, '', url.toString());
  }, [embedded, urlReady, selectedId, focusMessageId, inboxId, tab, projectFilter, lockedProject, search]);

  // Search waits for a pause in typing.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

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
  }, [client, urlReady, inboxId, activeProject, tab, search]);

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
  const statusOptions = INBOX_TABS.map((key) => {
    const count = counts?.[key] ?? 0;
    const loud = (key === 'needs_you' || key === 'needs_reply') && count > 0;
    return {
      value: key,
      label: key === 'all' ? 'All statuses' : INBOX_TAB_LABELS[key],
      detail: key !== 'all' && count > 0 ? (
        <span className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ${loud ? 'bg-red-600 text-white' : 'bg-white/[0.08] text-zinc-300'}`}>
          {count}
        </span>
      ) : undefined,
    };
  });
  const filtersActive = tab !== 'all' || !!search.trim() || !!inboxId || (!lockedProject && !!projectFilter);
  // The full Inbox with nothing in it yet: one setup guide instead of two empty panes.
  const neverHadEmail = hasLoaded && threads.length === 0 && !filtersActive && !error && (!embedded || !!emptyState);
  const selectThread = useCallback((id: string | null, messageId: string | null = null) => {
    setSelectedId(id);
    setFocusMessageId(messageId);
  }, []);
  const clearSelection = useCallback(() => selectThread(null), [selectThread]);

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-white/[0.06] p-3">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              type="search"
              value={searchInput}
              onChange={setSearchInput}
              placeholder="Search email"
              leftIcon={Search}
              size="sm"
              aria-label="Search subject, sender or project"
            />
          </div>
          <div className="w-[9.5rem] flex-shrink-0">
            <Select ariaLabel="Status" value={tab} onChange={(value) => isInboxTab(value) && setTab(value)} options={statusOptions} size="sm" />
          </div>
        </div>
        {(showInboxFilter || !lockedProject) && (
          <div className={`grid gap-2 ${showInboxFilter && !lockedProject ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {showInboxFilter && <Select ariaLabel="Inbox" value={inboxId} onChange={setInboxId} options={inboxOptions} size="sm" />}
            {!lockedProject && (
              <Select ariaLabel="Project" value={projectFilter} onChange={setProjectFilter} options={projectOptions} searchable size="sm" />
            )}
          </div>
        )}
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
            <p className="text-sm font-medium text-zinc-300">{filtersActive ? 'No email matches' : 'No email yet'}</p>
            <p className="text-xs text-zinc-400">
              {filtersActive
                ? 'Try another status, inbox or search.'
                : lockedProject
                  ? 'Client email mapped to this project will appear here.'
                  : 'Client email forwarded to an agent inbox will appear here.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-white/[0.05]">
              {threads.map((thread) => {
                const active = thread.id === selectedId;
                const attention = thread.needs_you || thread.needs_reply;
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => selectThread(thread.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`relative w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                        active ? 'bg-brand-500/[0.10]' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-brand-400" aria-hidden="true" />}
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-sm ${attention || thread.has_new ? 'font-semibold text-white' : 'font-medium text-zinc-200'}`}>
                          {thread.sender?.name || thread.sender?.address || 'Unknown sender'}
                          {thread.message_count > 1 && <span className="ml-1.5 text-xs font-normal text-zinc-400">{thread.message_count}</span>}
                        </span>
                        <span className="flex-shrink-0 text-xs tabular-nums text-zinc-400">{formatListTime(thread.last_message_at)}</span>
                      </span>
                      <span className={`mt-0.5 block truncate text-[13px] ${attention ? 'text-zinc-100' : 'text-zinc-300'}`}>{thread.subject || '(no subject)'}</span>
                      {thread.snippet && <span className="mt-0.5 line-clamp-1 block text-xs text-zinc-400">{thread.snippet}</span>}
                      <span className="mt-2 flex flex-wrap items-center gap-1.5">
                        {thread.state !== 'handled' && <ThreadStateBadge state={thread.state} tooltip={false} />}
                        {thread.urgent && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                            <Flame size={11} aria-hidden="true" />
                            Urgent
                          </span>
                        )}
                        {thread.untrusted && <TrustBadge level="untrusted" compact />}
                        {thread.project ? (
                          !lockedProject && (
                            <span className="inline-flex max-w-[170px] items-center gap-1.5 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-zinc-300">
                              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: projectColor(thread.project.id) ?? 'currentColor' }} aria-hidden="true" />
                              <span className="truncate">{thread.project.name}</span>
                              {thread.project.source === 'inferred' && (
                                <>
                                  <Sparkles size={10} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
                                  <span className="sr-only">(inferred, needs confirming)</span>
                                </>
                              )}
                              {thread.project.source === 'guessed' && (
                                <>
                                  <HelpCircle size={10} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
                                  <span className="sr-only">(guessed, needs confirming)</span>
                                </>
                              )}
                            </span>
                          )
                        ) : (
                          thread.state !== 'ignored' && <span className="rounded-full border border-dashed border-white/[0.16] px-2 py-0.5 text-[11px] text-zinc-400">No project</span>
                        )}
                        {thread.attachment_count > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[11px] text-zinc-400">
                            <Paperclip size={11} aria-hidden="true" />
                            <span className="sr-only">Attachments:</span>
                            {thread.attachment_count}
                          </span>
                        )}
                        {!inboxId && inboxes.length > 1 && <span className="ml-auto text-[11px] text-zinc-400">{thread.inbox_name}</span>}
                      </span>
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
      {neverHadEmail ? (embedded ? emptyState : <InboxEmptyState inboxes={inboxes} />) : (
      <div className="grid h-full lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
        <div className={`h-full min-h-0 lg:border-r lg:border-white/[0.06] ${selectedId ? 'hidden lg:block' : 'block'}`}>{list}</div>
        <div className={`h-full min-h-0 flex-col ${selectedId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedId ? (
            <>
              <div className="flex items-center border-b border-white/[0.06] px-3 py-2 lg:hidden">
                <button
                  type="button"
                  onClick={() => selectThread(null)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  All email
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ThreadView
                  key={selectedId}
                  threadId={selectedId}
                  focusMessageId={focusMessageId}
                  onMissing={clearSelection}
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
