'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Briefcase, CheckSquare, Clock, DollarSign, FileText, FolderKanban, KeyRound,
  Megaphone, MessageSquare, RotateCcw, Trash2, UserCircle, type LucideIcon,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { Bone, EmptyCard, NoMatches, SubNav, TabToolbar } from '@/components/projects/TabLayout';
import type { TrashItem } from '@/lib/types';

type Group = 'all' | 'projects' | 'tasks' | 'billing' | 'clients' | 'files';

const GROUPS: { key: Group; label: string; types: string[] }[] = [
  { key: 'all', label: 'All', types: [] },
  { key: 'projects', label: 'Projects', types: ['projects'] },
  { key: 'tasks', label: 'Tasks', types: ['tasks', 'task_comments', 'task_files', 'reminders'] },
  {
    key: 'billing',
    label: 'Billing',
    types: ['project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates', 'project_retainers', 'project_retainer_amounts'],
  },
  { key: 'clients', label: 'Clients', types: ['contacts', 'leads', 'lead_interactions', 'lead_proposals', 'lead_fields'] },
  { key: 'files', label: 'Files and portal', types: ['entity_files', 'project_credentials', 'portal_updates', 'portal_update_attachments'] },
];

const TYPES: Record<string, { label: string; icon: LucideIcon }> = {
  projects: { label: 'Project', icon: FolderKanban },
  tasks: { label: 'Task', icon: CheckSquare },
  task_comments: { label: 'Comment', icon: MessageSquare },
  task_files: { label: 'Task file', icon: FileText },
  reminders: { label: 'Reminder', icon: Clock },
  project_credentials: { label: 'Credential', icon: KeyRound },
  entity_files: { label: 'File', icon: FileText },
  portal_updates: { label: 'Portal update', icon: Megaphone },
  portal_update_attachments: { label: 'Portal attachment', icon: FileText },
  contacts: { label: 'Contact', icon: UserCircle },
  leads: { label: 'Lead', icon: Briefcase },
  lead_interactions: { label: 'Lead interaction', icon: MessageSquare },
  lead_proposals: { label: 'Proposal', icon: FileText },
  lead_fields: { label: 'Lead field', icon: Briefcase },
  project_time_entries: { label: 'Time entry', icon: Clock },
  project_invoices: { label: 'Invoice', icon: DollarSign },
  invoice_payments: { label: 'Payment', icon: DollarSign },
  project_hourly_rates: { label: 'Hourly rate', icon: DollarSign },
  project_retainers: { label: 'Retainer', icon: DollarSign },
  project_retainer_amounts: { label: 'Retainer amount', icon: DollarSign },
};

function timeAgo(dateStr: string): string {
  const diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function TrashPage() {
  // useSearchParams (?group=projects from the Projects page) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <TrashPageContent />
    </Suspense>
  );
}

function TrashPageContent() {
  const searchParams = useSearchParams();
  const { loadTrash, restoreRecord } = useApp();
  const initialGroup = GROUPS.some((g) => g.key === searchParams.get('group')) ? (searchParams.get('group') as Group) : 'all';
  const [group, setGroup] = useState<Group>(initialGroup);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // The store's functions change identity on every store update; load once on
  // open and after each restore, not on every render.
  const loadTrashRef = useRef(loadTrash);
  useEffect(() => { loadTrashRef.current = loadTrash; });
  const reload = useCallback(async () => {
    try {
      setItems(await loadTrashRef.current());
      setLoadFailed(false);
    } catch {
      // Never show "Trash is empty" for a Trash that failed to load.
      setLoadFailed(true);
      toast('error', 'Could not load Trash');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const restore = async (item: Pick<TrashItem, 'record_type' | 'id' | 'label'>) => {
    setRestoring(item.id);
    const ok = await restoreRecord(item.record_type, item.id);
    setRestoring(null);
    if (ok) toast('success', `${TYPES[item.record_type]?.label ?? 'Item'} restored`);
    // A failed restore may mean the list is stale (restored elsewhere, or a
    // new blocker), so it reloads either way.
    await reload();
  };

  const search = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const types = GROUPS.find((g) => g.key === group)?.types ?? [];
    return (items ?? []).filter((item) =>
      (types.length === 0 || types.includes(item.record_type))
      && (!search || item.label.toLowerCase().includes(search) || (item.context ?? '').toLowerCase().includes(search)));
  }, [items, group, search]);

  const counts = useMemo(() => {
    const result: Partial<Record<Group, number>> = {};
    for (const g of GROUPS) {
      result[g.key] = (items ?? []).filter((item) => g.types.length === 0 || g.types.includes(item.record_type)).length;
    }
    return result;
  }, [items]);

  // A record whose project is in Trash can come back once its project does.
  const trashedProjects = useMemo(
    () => new Map((items ?? []).filter((item) => item.record_type === 'projects').map((item) => [item.id, item])),
    [items],
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Trash"
        subtitle="Deleted items, kept until you restore them. Nothing here is ever permanently deleted."
      />

      <div className="p-4 lg:p-6 max-w-4xl mx-auto">
        <div className="mb-4">
          <Button href="/settings" variant="ghost" size="sm" icon={<ArrowLeft size={14} />}>Settings</Button>
        </div>

        <TabToolbar
          search={{ value: query, onChange: setQuery, placeholder: 'Search Trash...' }}
          filters={(
            <SubNav
              label="Trash type"
              items={GROUPS.map((g) => ({ key: g.key, label: g.label, count: items ? counts[g.key] : undefined }))}
              active={group}
              onChange={setGroup}
            />
          )}
        />

        {loadFailed && items === null ? (
          <EmptyCard
            icon={<Trash2 />}
            title="Trash could not load"
            description="Nothing has been lost. Check your connection and try again."
            action={<Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => void reload()}>Retry</Button>}
          />
        ) : items === null ? (
          <div className="glass-card rounded-xl divide-y divide-white/[0.06]" role="status" aria-busy="true" aria-label="Loading Trash">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-3 px-5 py-4">
                <Bone className="w-8 h-8 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Bone className="h-3.5 w-1/2" />
                  <Bone className="h-3 w-1/3" />
                </div>
                <Bone className="h-8 w-20 rounded-lg" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyCard
            icon={<Trash2 />}
            title="Trash is empty"
            description="When you delete a project, task, invoice or anything else, it lands here and you can bring it back."
          />
        ) : (
          <div className="glass-card rounded-xl">
            {visible.length === 0 ? (
              <NoMatches>Nothing in Trash matches.</NoMatches>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {visible.map((item) => {
                  const type = TYPES[item.record_type] ?? { label: 'Item', icon: FileText };
                  const Icon = type.icon;
                  // Offer the project's restore only when the project is what blocks it.
                  const parentProject = item.blocker?.startsWith('Restore the project') && item.project_id
                    ? trashedProjects.get(item.project_id) : undefined;
                  return (
                    <li key={`${item.record_type}:${item.id}`} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center flex-shrink-0">
                          <Icon size={16} className="text-zinc-400" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white truncate">{item.label}</p>
                          <p className="text-xs text-zinc-400 truncate">
                            {/* A subtask's context already says whose subtask it is. */}
                            {item.record_type === 'tasks' && item.context?.startsWith('Subtask of ')
                              ? item.context
                              : `${type.label}${item.context ? ` in ${item.context}` : ''}`}
                            {' · '}deleted {timeAgo(item.deleted_at)}{item.deleted_by_name ? ` by ${item.deleted_by_name}` : ''}
                          </p>
                          {item.blocker && <p className="text-xs text-amber-300 mt-1">{item.blocker}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 sm:flex-shrink-0">
                        {parentProject ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<RotateCcw size={14} />}
                            disabled={restoring !== null}
                            onClick={() => void restore(parentProject)}
                          >
                            Restore project<span className="sr-only"> {parentProject.label}</span>
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<RotateCcw size={14} />}
                            disabled={restoring !== null || !!item.blocker}
                            onClick={() => void restore(item)}
                          >
                            {restoring === item.id ? 'Restoring...' : 'Restore'}
                            <span className="sr-only"> {type.label.toLowerCase()} {item.label}</span>
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
