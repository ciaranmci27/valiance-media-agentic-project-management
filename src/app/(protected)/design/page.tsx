'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, ArrowUpRight, Bell, Copy, FileText, FolderKanban, KeyRound, LayoutGrid, List, CalendarDays, Moon, PanelRight, Pencil,
  Settings as SettingsIcon, Sun, Trash2, CheckCircle2, Clock, AlertTriangle,
} from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CardLink } from '@/components/projects/TabLayout';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { Tabs, SubNav, tabId, tabPanelId } from '@/components/ui/Tabs';
import { FilterButton, FilterOption, FilterSection } from '@/components/ui/FilterButton';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { ShowMore } from '@/components/ui/ShowMore';
import { EmptyState } from '@/components/ui/EmptyState';
import { UndoLine } from '@/components/ui/UndoLine';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Pill, PILL_TONES, type PillTone } from '@/components/ui/Pill';
import { PriorityBadge, StatusBadge } from '@/components/ui/Badge';
import { SaveBar } from '@/components/ui/SaveBar';
import { StatStrip } from '@/components/ui/StatStrip';
import { LineChart } from '@/components/ui/LineChart';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { PermissionGrid } from '@/components/access/PermissionGrid';
import { GRID_LEVELS, GRID_LEVEL_LABELS, scopesToGrid } from '@/lib/permission-grid';
import { StepFooter, StepPanel, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Select } from '@/components/ui/inputs/Select';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ProviderPicker } from '@/components/ui/ProviderPicker';
import { AI_PROVIDER_CHOICES, LOGO_IDS, LOGOS, LOGO_BADGES, LOGO_BADGE_WORDS } from '@/lib/logos';
import { formatAgo, formatDay, formatElapsed, formatFull } from '@/lib/time-format';

/**
 * The live pattern page: every pattern DESIGN.md's Rules (binding) name, drawn
 * with the real components and sample data. Signed-in members and the demo;
 * no sidebar entry. The switch at the top flips only the preview area between
 * dark and light (a scoped data-theme), so both themes can be checked side by
 * side with the app's own. Dialogs, menus and tooltips open over the whole
 * app, so they follow the app's theme.
 */

type Theme = 'dark' | 'light';

const PILL_SAMPLES: Record<PillTone, { label: string; icon: ReactNode }> = {
  neutral: { label: 'Backlog', icon: <FileText /> },
  good: { label: 'Done', icon: <CheckCircle2 /> },
  waiting: { label: 'Needs you', icon: <Clock /> },
  problem: { label: 'Blocked', icon: <AlertTriangle /> },
  info: { label: 'In progress', icon: <Activity /> },
};

interface Person {
  id: string;
  name: string;
  role: string;
  kind: 'person' | 'agent';
  status: { tone: PillTone; label: string };
  lastActive: number;
}

const HOUR = 3_600_000;

function samplePeople(now: number): Person[] {
  return [
    { id: 'p-maya', name: 'Maya Chen', role: 'Owner', kind: 'person', status: { tone: 'good', label: 'Active' }, lastActive: now - 4 * 60_000 },
    { id: 'p-atlas', name: 'Atlas', role: 'Builder agent', kind: 'agent', status: { tone: 'info', label: 'Working' }, lastActive: now - 30_000 },
    { id: 'p-scout', name: 'Scout', role: 'Research agent', kind: 'agent', status: { tone: 'waiting', label: 'Needs you' }, lastActive: now - 2 * HOUR },
    { id: 'p-jordan', name: 'Jordan Ellis', role: 'Member', kind: 'person', status: { tone: 'neutral', label: 'Invited' }, lastActive: now - 30 * HOUR },
    { id: 'p-nova', name: 'Nova', role: 'Review agent', kind: 'agent', status: { tone: 'problem', label: 'Blocked' }, lastActive: now - 12 * 24 * HOUR },
  ];
}

const TASK_WORDS = ['Draft launch email', 'Review pricing page', 'Fix login redirect', 'Update brand colors', 'Write onboarding guide', 'Plan Q1 roadmap'];

const STEPS: FlowStep[] = [
  { key: 'role', label: 'Role' },
  { key: 'details', label: 'Details' },
  { key: 'powers', label: 'Powers' },
  { key: 'review', label: 'Review' },
];

const START_SCOPES = ['tasks.read_assigned', 'tasks.read', 'tasks.create', 'projects.read', 'contacts.read', 'agents.act_for'];
const EDITOR_HOLDS = [
  'tasks.read_assigned', 'tasks.read', 'tasks.create', 'tasks.manage_assigned', 'tasks.manage_all',
  'projects.read', 'projects.read_all', 'projects.manage', 'contacts.read', 'contacts.read_all',
  'leads.read', 'leads.read_all', 'team.read', 'templates.manage', 'files.read', 'files.upload',
  'project_context.read', 'project_context.manage', 'reminders.manage_own', 'agents.act_for', 'approvals.decide', 'questions.ask',
];

export default function DesignPatternsPage() {
  const [theme, setTheme] = useState<Theme>('dark');
  // A fixed "now" at 2 pm today, so the time samples read the same whenever the page opens.
  const now = useMemo(() => { const d = new Date(); d.setHours(14, 0, 0, 0); return d.getTime(); }, []);

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Design patterns"
        subtitle={<span className="hidden sm:inline">Every pattern from DESIGN.md, with the real components</span>}
        actions={(
          <SubNav<Theme>
            label="Preview theme"
            active={theme}
            onChange={setTheme}
            items={[{ key: 'dark', label: 'Dark', icon: Moon }, { key: 'light', label: 'Light', icon: Sun }]}
          />
        )}
      />

      <div className="p-4 lg:p-6">
        <div data-theme={theme} className="space-y-6 rounded-2xl bg-surface p-3 text-white ring-1 ring-inset ring-white/[0.06] sm:p-5 lg:p-6">
          <p className="text-xs text-zinc-400">
            Preview in {theme} theme. Each block names its component and the DESIGN.md rule it follows. Dialogs, menus and tooltips open over the whole app, so they follow the app&apos;s own theme.
          </p>
          <HeadersBlock />
          <PanelBlock />
          <TabsBlock />
          <ListsBlock now={now} />
          <DataBlock now={now} />
          <RhythmBlock />
          <EmptyBlock />
          <UndoBlock />
          <PillBlock />
          <SaveBlock />
          <ButtonsBlock />
          <AvatarBlock />
          <LogoBlock />
          <PermissionBlock />
          <FlowBlock />
          <TimeBlock now={now} />
          <FormBlock />
        </div>
      </div>
    </div>
  );
}

/** One pattern: its name, the components it is built from and the rule it follows, then the live sample. */
function Block({ title, components, rule, children }: { title: string; components: string; rule: string; children: ReactNode }) {
  const id = `pattern-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-white/[0.06] pb-2">
        <h2 id={id} className="text-base font-semibold text-white">{title}</h2>
        <p className="text-[11px] text-zinc-400">
          <span className="font-mono text-zinc-300">{components}</span>
          <span aria-hidden="true"> · </span>
          <span>{rule}</span>
        </p>
      </div>
      {children}
    </section>
  );
}

function HeadersBlock() {
  return (
    <Block title="Headers" components="Header, CardHeader, SettingsSectionHeader" rule="Rule 2">
      <p className="text-xs text-zinc-400">The title at the top of this page is a <span className="font-mono">Header</span>. Inside the app a card uses the calm header; Settings pages use their own.</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent activity" icon={<Activity />} action={<CardLink onClick={() => toast('info', 'Opens the activity feed')}>Open</CardLink>}>
          <ul className="divide-y divide-white/[0.05] text-sm">
            <li className="flex items-center justify-between gap-3 py-2"><span className="text-zinc-200">Atlas finished Fix login redirect</span><span className="text-[11px] text-zinc-500">5 min ago</span></li>
            <li className="flex items-center justify-between gap-3 py-2"><span className="text-zinc-200">Maya added 3 tasks</span><span className="text-[11px] text-zinc-500">2 h ago</span></li>
          </ul>
        </Card>
        <div className="glass-card rounded-xl p-4 lg:p-5">
          <SettingsSectionHeader
            icon={SettingsIcon}
            title="Workspace"
            description="Your company's name and how the app looks for everyone."
            action={<Button size="sm" variant="secondary">Edit</Button>}
          />
          <p className="text-sm text-zinc-400">Settings pages only.</p>
        </div>
      </div>
    </Block>
  );
}

/** How panels title themselves (Rule 2): what the panel is, or the record itself. */
const PANEL_TITLES = [
  { title: 'Edit project', detail: 'Website relaunch' },
  { title: 'Project members', detail: 'Website relaunch' },
  { title: 'Use template', detail: 'Client onboarding, 12 tasks' },
  { title: 'Fix login redirect', detail: 'In Website relaunch' },
];

function PanelBlock() {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState('Website relaunch');
  const [name, setName] = useState('Website relaunch');
  const [saving, setSaving] = useState(false);
  const dirty = name !== saved;
  const close = () => { setOpen(false); setName(saved); };
  const { requestClose, dialog } = useDiscardGuard(dirty, close);
  const save = () => {
    setSaving(true);
    setTimeout(() => { setSaved(name); setSaving(false); toast('success', 'Project saved'); }, 600);
  };

  return (
    <Block title="Side panel" components="TaskPanelShell, PanelHeader, SaveBar" rule="Rules 1, 2 and 8">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col overflow-hidden rounded-xl bg-surface-raised ring-1 ring-inset ring-white/[0.06]">
          <PanelHeader id="design-panel-static" title="Edit project" detail={saved} onClose={() => toast('info', 'Closes the panel')} />
          <section className="flex-1 space-y-4 border-t border-white/[0.06] px-5 py-4">
            <h3 className="text-sm font-semibold text-white">Basics</h3>
            <TextInput label="Name" value={saved} onChange={() => {}} readOnly />
            <p className="text-xs text-zinc-400">Hairline sections, one column, the save bar pinned at the bottom.</p>
          </section>
          <SaveBar placement="panel" dirty saving={false} onDiscard={() => toast('info', 'Discards the changes')} onSave={() => toast('info', 'Saves the project')} />
        </div>
        <Card
          title="Panel titles"
          icon={<PanelRight />}
          action={<Button size="sm" variant="secondary" icon={<ArrowUpRight size={13} aria-hidden="true" />} onClick={() => setOpen(true)}>Open the side panel</Button>}
          description="The title says what the panel is, the record goes in the quiet line under it. A record opened as itself takes its own name."
          bodyClassName="pb-1"
        >
          <ul className="divide-y divide-white/[0.05] border-t border-white/[0.05]">
            {PANEL_TITLES.map((t) => (
              <li key={t.title + t.detail} className="px-4 py-2.5 lg:px-5">
                <p className="text-sm font-medium text-zinc-100">{t.title}</p>
                <p className="text-xs text-zinc-400">{t.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {open && (
        <TaskPanelShell
          labelledBy="design-panel-title"
          onClose={requestClose}
          after={dialog}
          header={<PanelHeader id="design-panel-title" title="Edit project" detail={saved} onClose={requestClose} />}
          footer={<SaveBar placement="panel" dirty={dirty} saving={saving} onDiscard={() => setName(saved)} onSave={save} />}
        >
          <section className="space-y-4 border-t border-white/[0.06] px-5 py-4">
            <h3 className="text-sm font-semibold text-white">Basics</h3>
            <TextInput label="Name" value={name} onChange={setName} description="Change it to see the save bar." />
            <Textarea label="Description" value="The new marketing site, live before the spring launch." onChange={() => {}} />
          </section>
        </TaskPanelShell>
      )}
    </Block>
  );
}

type TabKey = 'tasks' | 'overview' | 'files';
type ViewKey = 'board' | 'list' | 'calendar';

function TabsBlock() {
  const [tab, setTab] = useState<TabKey>('tasks');
  const [view, setView] = useState<ViewKey>('board');
  const [status, setStatus] = useState<string[]>(['in_progress']);
  const [owner, setOwner] = useState<string[]>([]);
  const flip = (list: string[], set: (v: string[]) => void, value: string) => set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  return (
    <Block title="Tabs and filters" components="Tabs, SubNav, FilterButton" rule="Rule 3">
      <Tabs<TabKey>
        label="Project sections"
        idPrefix="design"
        active={tab}
        onChange={setTab}
        tabs={[{ key: 'tasks', label: 'Tasks', count: 12 }, { key: 'overview', label: 'Overview' }, { key: 'files', label: 'Files', badge: { count: 2, label: '2 new files' } }]}
      />
      <div role="tabpanel" id={tabPanelId('design', tab)} aria-labelledby={tabId('design', tab)} className="flex flex-wrap items-center gap-3">
        <SubNav<ViewKey>
          label="Task view"
          active={view}
          onChange={setView}
          items={[
            { key: 'board', label: 'Board', icon: LayoutGrid, hideLabelOnMobile: true },
            { key: 'list', label: 'List', icon: List, hideLabelOnMobile: true },
            { key: 'calendar', label: 'Calendar', icon: CalendarDays, hideLabelOnMobile: true },
          ]}
        />
        <FilterButton activeCount={status.length + owner.length} onClear={() => { setStatus([]); setOwner([]); }}>
          <FilterSection label="Status">
            {['todo', 'in_progress', 'done'].map((s) => (
              <FilterOption key={s} selected={status.includes(s)} onToggle={() => flip(status, setStatus, s)}>{s === 'todo' ? 'To do' : s === 'in_progress' ? 'In progress' : 'Done'}</FilterOption>
            ))}
          </FilterSection>
          <FilterSection label="Assignee">
            {['Maya', 'Atlas', 'Scout'].map((n) => (
              <FilterOption key={n} selected={owner.includes(n)} onToggle={() => flip(owner, setOwner, n)}>
                <Avatar name={n} size="xs" />{n}
              </FilterOption>
            ))}
          </FilterSection>
        </FilterButton>
        <span className="text-xs text-zinc-400">Two to four views: SubNav. More: one FilterButton with a count.</span>
      </div>
    </Block>
  );
}

function ListsBlock({ now }: { now: number }) {
  const people = useMemo(() => samplePeople(now), [now]);
  const rows = useMemo(() => Array.from({ length: 76 }, (_, i) => ({ id: `t${i}`, title: `${TASK_WORDS[i % TASK_WORDS.length]} ${Math.floor(i / TASK_WORDS.length) + 1}`, due: now + (i - 10) * 24 * HOUR })), [now]);
  const [shown, setShown] = useState(5);
  const columns: Column<Person>[] = [
    {
      key: 'name', header: 'Name', sortValue: (p) => p.name,
      render: (p) => (
        <span className="flex items-center gap-2.5">
          {p.kind === 'agent' ? <AgentAvatar id={p.id} name={p.name} size="sm" /> : <Avatar id={p.id} name={p.name} size="sm" />}
          <span className="font-medium text-zinc-100">{p.name}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', render: (p) => <span className="text-zinc-300">{p.role}</span> },
    { key: 'status', header: 'Status', render: (p) => <Pill tone={p.status.tone} dot>{p.status.label}</Pill> },
    {
      key: 'active', header: 'Last active', align: 'right', sortValue: (p) => p.lastActive,
      render: (p) => <Tooltip content={formatFull(p.lastActive)}><span className="text-xs tabular-nums text-zinc-400">{formatAgo(p.lastActive, { now: new Date(now) })}</span></Tooltip>,
    },
  ];
  return (
    <Block title="Lists" components="DataTable, row list, RowActionsMenu, ShowMore" rule="Rule 4">
      <DataTable
        columns={columns}
        data={people}
        keyExtractor={(p) => p.id}
        mobileCard={(p) => (
          <div className="flex items-center gap-3">
            {p.kind === 'agent' ? <AgentAvatar id={p.id} name={p.name} size="sm" /> : <Avatar id={p.id} name={p.name} size="sm" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-100">{p.name}</p>
              <p className="truncate text-xs text-zinc-400">{p.role} · {formatAgo(p.lastActive, { now: new Date(now), midSentence: false })}</p>
            </div>
            <Pill tone={p.status.tone} dot>{p.status.label}</Pill>
          </div>
        )}
      />
      <Card title="Open tasks" icon={<FolderKanban />} afterTitle={<span className="text-xs font-normal tabular-nums text-zinc-500">{rows.length}</span>} bodyClassName="pb-1">
        <ul className="divide-y divide-white/[0.05] border-t border-white/[0.05]">
          {rows.slice(0, shown).map((row, i) => (
            <li key={row.id} className="flex items-center gap-3 px-4 py-2.5 lg:px-5">
              <FileText size={16} className="flex-shrink-0 text-zinc-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-100">{row.title}</p>
                <p className="text-[11px] text-zinc-500">Due {formatDay(row.due, new Date(now))}</p>
              </div>
              <PriorityBadge priority={i % 5 === 0 ? 'urgent' : i % 3 === 0 ? 'high' : 'medium'} />
              <RowActionsMenu
                label={`Actions for ${row.title}`}
                actions={[
                  { label: 'Edit', icon: <Pencil size={14} aria-hidden="true" />, onClick: () => toast('info', 'Opens the task') },
                  { label: 'Move to Trash', icon: <Trash2 size={14} aria-hidden="true" />, variant: 'danger', onClick: () => toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => toast('success', 'Restored') } }) },
                ]}
              />
            </li>
          ))}
        </ul>
        <ShowMore shown={shown} total={rows.length} step={24} onMore={() => setShown((n) => n + 24)} noun="tasks" />
      </Card>
    </Block>
  );
}

type MetricKey = 'runs' | 'done' | 'spend' | 'saved';

interface Metric {
  key: MetricKey;
  label: string;
  /** The chart's question, in plain words. */
  question: string;
  unit: string;
  format: (v: number) => string;
  total: (series: number[]) => string;
  change: { value: string; direction: 'up' | 'down' | 'flat'; good?: 'up' | 'down' };
  series: number[];
}

/** A steady, made-up 30 days: a base, a weekly rhythm and a gentle trend, so the samples look like real use. */
function sampleSeries(base: number, trend: number, weekly: number, seed: number): number[] {
  return Array.from({ length: 30 }, (_, i) => {
    const wiggle = Math.sin((i + seed) * 1.7) * 0.5 + Math.cos((i + seed) * 0.9) * 0.5;
    const weekend = (i + seed) % 7 >= 5 ? -weekly : 0;
    return Math.max(0, Math.round(base + trend * i + weekend + wiggle * base * 0.15));
  });
}

const sum = (series: number[]) => series.reduce((a, b) => a + b, 0);

const METRICS: Metric[] = [
  {
    key: 'runs', label: 'Agent runs', question: 'Runs per day, last 30 days', unit: 'runs',
    format: (v) => `${v} ${v === 1 ? 'run' : 'runs'}`, total: (s) => sum(s).toLocaleString(),
    change: { value: '12%', direction: 'up' }, series: sampleSeries(40, 0.6, 14, 1),
  },
  {
    key: 'done', label: 'Tasks done', question: 'Tasks done per day, last 30 days', unit: 'tasks',
    format: (v) => `${v} ${v === 1 ? 'task' : 'tasks'}`, total: (s) => sum(s).toLocaleString(),
    change: { value: '8%', direction: 'up', good: 'up' }, series: sampleSeries(9, 0.15, 5, 3),
  },
  {
    key: 'spend', label: 'Agent spend', question: 'Agent spend per day, last 30 days', unit: 'dollars',
    format: (v) => `$${v.toLocaleString()}`, total: (s) => `$${sum(s).toLocaleString()}`,
    change: { value: '5%', direction: 'up', good: 'down' }, series: sampleSeries(18, 0.2, 6, 5),
  },
  {
    key: 'saved', label: 'Hours saved', question: 'Hours saved per day, last 30 days', unit: 'hours',
    format: (v) => `${v} h`, total: (s) => `${sum(s).toLocaleString()} h`,
    change: { value: '0%', direction: 'flat' }, series: sampleSeries(6, 0, 3, 2),
  },
];

function DataBlock({ now }: { now: number }) {
  const [picked, setPicked] = useState<MetricKey>('runs');
  // The chart mounts loading and gets its data a moment later, as on a real screen.
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 900);
    return () => clearTimeout(timer);
  }, []);
  const metric = METRICS.find((m) => m.key === picked)!;
  const points = useMemo(() => metric.series.map((value, i) => {
    const day = new Date(now - (29 - i) * 24 * HOUR);
    return {
      value,
      label: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      title: day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  }), [metric, now]);

  return (
    <Block title="Data anyone can read" components="StatStrip, LineChart" rule="Rule 16">
      <StatStrip
        label="Last 30 days"
        stats={METRICS.map((m) => ({
          id: m.key,
          label: m.label,
          value: m.total(m.series),
          change: { ...m.change, against: 'vs last 30 days' },
          spark: m.series,
          onSelect: () => setPicked(m.key),
          selected: picked === m.key,
        }))}
      />
      <Card title={metric.question} icon={<Activity />}>
        <LineChart points={points} format={metric.format} unit={metric.unit} label={metric.question} empty="Runs show here once an agent has worked" loading={loading} />
      </Card>
      <p className="text-xs text-zinc-400">Pick a number to chart it. Spend going up is red; runs going up has no good or bad side, so it stays neutral. On a phone the strip becomes a list.</p>
    </Block>
  );
}

function RhythmBlock() {
  const [range, setRange] = useState('30');
  const [agents, setAgents] = useState<string[]>([]);
  const flip = (name: string) => setAgents((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));
  return (
    <Block title="One rhythm, no stray rows" components="Card action slot, FilterButton, Select, CardLink" rule="Rule 17">
      <Card
        title="Agent runs"
        icon={<Activity />}
        action={(
          <>
            <FilterButton activeCount={agents.length} onClear={() => setAgents([])} label="Agents" title="Show runs by">
              <FilterSection label="Agent">
                {['Atlas', 'Scout', 'Nova'].map((n) => (
                  <FilterOption key={n} selected={agents.includes(n)} onToggle={() => flip(n)}><Avatar name={n} size="xs" />{n}</FilterOption>
                ))}
              </FilterSection>
            </FilterButton>
            <Select
              ariaLabel="Date range"
              size="sm"
              value={range}
              onChange={setRange}
              options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]}
              className="w-36"
            />
            <CardLink onClick={() => toast('info', 'Opens the runs list, filtered the same way')}>See runs</CardLink>
          </>
        )}
      >
        <StatStrip
          bare
          label={`Runs, last ${range} days`}
          stats={[
            { label: 'Runs', value: range === '7' ? '312' : range === '30' ? '1,352' : '3,980' },
            { label: 'Finished', value: range === '7' ? '298' : range === '30' ? '1,301' : '3,811' },
            { label: 'Waiting on a person', value: range === '7' ? '6' : range === '30' ? '19' : '44' },
          ]}
        />
      </Card>
      <p className="text-xs text-zinc-400">
        The filter, the date range and See runs sit in the header of the card they act on and wrap together on a phone; never a row of their own under it. 24px between cards, 16px inside (20px from lg on wide cards), 12px between rows of controls.
      </p>
    </Block>
  );
}

function EmptyBlock() {
  const [retrying, setRetrying] = useState(false);
  return (
    <Block title="Empty states" components="EmptyState" rule="Rule 5">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="glass-card rounded-xl">
          <EmptyState icon={<FileText />} title="No templates yet" description="Templates you save show up here." action={<Button size="sm">New template</Button>} />
        </div>
        <div className="glass-card rounded-xl">
          <EmptyState variant="filtered" title="Nothing matches" description="No task matches these filters." onClearFilters={() => toast('info', 'Filters cleared')} />
        </div>
        <div className="glass-card rounded-xl">
          <EmptyState
            variant="error"
            title="Could not load runs"
            description="The server did not answer."
            retrying={retrying}
            onRetry={() => { setRetrying(true); setTimeout(() => setRetrying(false), 900); }}
          />
        </div>
      </div>
    </Block>
  );
}

function UndoBlock() {
  const [trashed, setTrashed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <Block title="Undo, not confirm" components="UndoLine, toast action, ConfirmDialog" rule="Rule 6">
      <Card title="Moving to Trash" icon={<Trash2 />}>
        <div className="space-y-4">
          {trashed ? (
            <UndoLine onUndo={() => setTrashed(false)}>Moved Draft launch email to Trash</UndoLine>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2.5">
              <span className="text-sm text-zinc-200">Draft launch email</span>
              <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden="true" />} onClick={() => setTrashed(true)}>Move to Trash</Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => toast('success', 'Moved to Trash', { action: { label: 'Undo', onClick: () => toast('success', 'Restored') } })}>
              Show a toast with Undo
            </Button>
            <Button size="sm" variant="danger" icon={<KeyRound size={13} aria-hidden="true" />} onClick={() => setConfirm(true)}>Revoke key</Button>
          </div>
          <p className="text-xs text-zinc-400">Only what cannot be undone asks first, with a sentence-case question.</p>
        </div>
      </Card>
      <ConfirmDialog
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { setConfirm(false); toast('success', 'Key revoked'); }}
        title="Revoke this key?"
        message="Anything using it stops working at once. This cannot be undone."
        confirmLabel="Revoke key"
        doubleConfirm={false}
      />
    </Block>
  );
}

function PillBlock() {
  return (
    <Block title="Status labels" components="Pill (Badge, StatusBadge, PriorityBadge)" rule="Rule 7">
      <div className="glass-card space-y-3 rounded-xl p-4 lg:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {PILL_TONES.map((tone) => <Pill key={tone} tone={tone}>{PILL_SAMPLES[tone].label}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PILL_TONES.map((tone) => <Pill key={tone} tone={tone} dot>{PILL_SAMPLES[tone].label}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {PILL_TONES.map((tone) => <Pill key={tone} tone={tone} icon={PILL_SAMPLES[tone].icon}>{PILL_SAMPLES[tone].label}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="todo" /><StatusBadge status="in_progress" /><StatusBadge status="in_review" /><StatusBadge status="done" />
          <PriorityBadge priority="medium" /><PriorityBadge priority="high" /><PriorityBadge priority="urgent" />
        </div>
        <p className="text-xs text-zinc-400">Money and counts are plain text, never a pill: $4,200 billed, 12 tasks.</p>
      </div>
    </Block>
  );
}

function SaveBlock() {
  const [saved, setSaved] = useState('Valiance Media');
  const [value, setValue] = useState('Valiance Media Studio');
  const [saving, setSaving] = useState(false);
  const [weekly, setWeekly] = useState(true);
  const [mentions, setMentions] = useState(false);
  const flip = (set: (v: boolean) => void, label: string) => (on: boolean) => {
    set(on);
    toast('success', `${label} ${on ? 'on' : 'off'}`, { action: { label: 'Undo', onClick: () => set(!on) } });
  };
  return (
    <Block title="Saving a form" components="SaveBar, useDiscardGuard, Toggle" rule="Rule 8">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="glass-card flex flex-col overflow-hidden rounded-xl">
          <div className="flex-1 space-y-4 p-4 lg:p-5">
            <SettingsSectionHeader icon={SettingsIcon} title="Workspace name" description="A form: the save bar shows once something changed." />
            <TextInput label="Name" value={value} onChange={setValue} />
          </div>
          <SaveBar
            dirty={value !== saved}
            saving={saving}
            onDiscard={() => setValue(saved)}
            onSave={() => { setSaving(true); setTimeout(() => { setSaved(value); setSaving(false); }, 600); }}
          />
        </div>
        <div className="glass-card space-y-4 rounded-xl p-4 lg:p-5">
          <SettingsSectionHeader icon={Bell} title="Notifications" description="Switches save at once, with Undo." />
          <Toggle label="Weekly summary" description="A Monday email with last week's work." checked={weekly} onChange={flip(setWeekly, 'Weekly summary')} />
          <Toggle label="Mentions" description="An email when someone mentions you." checked={mentions} onChange={flip(setMentions, 'Mentions')} />
        </div>
      </div>
    </Block>
  );
}

function ButtonsBlock() {
  return (
    <Block title="Buttons" components="Button, IconButton, RowActionsMenu" rule="Rule 11">
      <div className="glass-card flex flex-wrap items-center gap-3 rounded-xl p-4 lg:p-5">
        <Button>Add task</Button>
        <Button variant="secondary">From a template</Button>
        <Button variant="ghost">Cancel</Button>
        <span className="h-6 w-px bg-white/[0.08]" aria-hidden="true" />
        <IconButton icon={<Copy />} label="Copy link" size="sm" onClick={() => toast('success', 'Copied to clipboard')} />
        <IconButton icon={<Bell />} label="Notifications" onClick={() => {}} />
        <IconButton icon={<Trash2 />} label="Move to Trash" tone="danger" onClick={() => {}} />
        <RowActionsMenu label="More actions" actions={[{ label: 'Duplicate', onClick: () => {} }, { label: 'Move to Trash', variant: 'danger', onClick: () => {} }]} />
      </div>
    </Block>
  );
}

function AvatarBlock() {
  const names = ['Atlas', 'Scout', 'Nova', 'Maya Chen', 'Jordan Ellis', 'Priya Patel'];
  return (
    <Block title="Avatars" components="Avatar, AgentAvatar" rule="Rule 11">
      <div className="glass-card space-y-4 rounded-xl p-4 lg:p-5">
        <div className="flex flex-wrap items-end gap-6">
          {names.map((name) => (
            <div key={name} className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
                <Avatar name={name} size="md" />
                <AgentAvatar id={name} name={name} size="md" presence={name === 'Atlas' ? 'working' : name === 'Scout' ? 'idle' : undefined} />
              </div>
              <span className="text-[11px] text-zinc-400">{name}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-400">Left: Avatar, as on Team and Overview. Right: AgentAvatar, as on Agents. Same tone and initials for the same name.</p>
      </div>
    </Block>
  );
}

/** The logo bank (Rule 20): every provider mark, the state badges, the initials fallback and the picker. */
function LogoBlock() {
  const [provider, setProvider] = useState('');
  return (
    <Block title="Provider logos" components="ProviderLogo, ProviderPicker" rule="Rule 20">
      <div className="glass-card space-y-5 rounded-xl p-4 lg:p-5">
        <ul aria-label="Logo bank" className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:grid-cols-4 lg:grid-cols-6">
          {LOGO_IDS.map((id) => (
            <li key={id} className="flex min-w-0 items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
              <ProviderLogo provider={id} size="md" tile decorative />
              <span className="min-w-0 truncate text-xs text-zinc-300">{LOGOS[id].label}</span>
            </li>
          ))}
          <li className="flex min-w-0 items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
            <ProviderLogo provider="custom.mattermost" size="md" tile decorative />
            <span className="min-w-0 truncate text-xs text-zinc-300">Unknown (initials)</span>
          </li>
        </ul>
        <div className="flex flex-wrap items-end gap-6">
          {LOGO_BADGES.map((badge) => (
            <div key={badge} className="flex flex-col items-center gap-2">
              <ProviderLogo provider="telegram" size="xl" badge={badge} />
              <span className="text-[11px] text-zinc-400">{LOGO_BADGE_WORDS[badge]}</span>
            </div>
          ))}
          <div className="flex flex-col items-center gap-2">
            <ProviderLogo provider="github" size="lg" tile badge="done" />
            <span className="text-[11px] text-zinc-400">tile, connected</span>
          </div>
        </div>
        <ProviderPicker
          label="AI provider"
          choices={AI_PROVIDER_CHOICES}
          value={provider}
          onChange={setProvider}
          other={{ description: 'Any other provider', name: { label: 'Provider name', placeholder: 'Like mistral' } }}
        />
        <p className="text-xs text-zinc-400">The real mark, never a generic icon. Black or white marks sit on a quiet tile so they read in both themes; a provider the bank lacks gets its initials. A state is the small badge in the bottom right. Choosing a provider is ProviderPicker, never a text box.</p>
      </div>
    </Block>
  );
}

/** What a set of scopes adds up to: one plain line per column, then the special powers. */
function accessSummary(scopes: readonly string[]): { label: string; value: string }[] {
  const grid = scopesToGrid(scopes);
  const list = (names: string[]) => (names.length ? names.join(', ') : 'Nothing');
  return [
    ...GRID_LEVELS.map((level) => ({
      label: GRID_LEVEL_LABELS[level],
      value: list(grid.areas.filter((area) => (area.cells[level]?.state ?? 'off') !== 'off').map((area) => area.label)),
    })),
    { label: 'Special powers', value: list(grid.powers.filter((power) => power.held).map((power) => power.label)) },
  ];
}

const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function PermissionBlock() {
  const [saved, setSaved] = useState<string[]>(START_SCOPES);
  const [scopes, setScopes] = useState<string[]>(START_SCOPES);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = !sameScopes(scopes, saved);
  const close = () => { setOpen(false); setScopes(saved); };
  const { requestClose, dialog } = useDiscardGuard(dirty, close);
  const summary = useMemo(() => accessSummary(saved), [saved]);
  const save = () => {
    setSaving(true);
    setTimeout(() => { setSaved(scopes); setSaving(false); setOpen(false); toast('success', 'Access saved'); }, 600);
  };

  return (
    <Block title="Permissions" components="PermissionGrid in TaskPanelShell" rule="Rules 1, 10 and 19">
      <Card
        title="Access"
        icon={<KeyRound />}
        afterTitle={<span className="flex items-center gap-1.5 text-xs font-normal text-zinc-400"><AgentAvatar id="p-nova" name="Nova" size="xs" />Nova</span>}
        action={<Button size="sm" variant="secondary" icon={<Pencil size={13} aria-hidden="true" />} onClick={() => setOpen(true)}>Edit what Nova may do</Button>}
        bodyClassName="pb-1"
      >
        <dl className="divide-y divide-white/[0.05] border-t border-white/[0.05] text-sm">
          {summary.map((row) => (
            <div key={row.label} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4 lg:px-5">
              <dt className="text-zinc-400">{row.label}</dt>
              <dd className="text-zinc-100">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {open && (
        <TaskPanelShell
          labelledBy="design-access-title"
          onClose={requestClose}
          after={dialog}
          header={<PanelHeader id="design-access-title" title="Edit access" detail="Nova, Review agent" onClose={requestClose} />}
          footer={<SaveBar placement="panel" dirty={dirty} saving={saving} onDiscard={() => setScopes(saved)} onSave={save} />}
        >
          <div className="border-t border-white/[0.06] px-5 py-4">
            <PermissionGrid
              label="What Nova may do"
              value={scopes}
              onChange={setScopes}
              limits={{ channel: 'api', holderIsAgent: true, holderName: 'Nova', editorHolds: EDITOR_HOLDS }}
            />
          </div>
        </TaskPanelShell>
      )}
    </Block>
  );
}

function FlowBlock() {
  const [step, setStep] = useState(1);
  const [reached, setReached] = useState(1);
  const go = (next: number) => { setStep(next); setReached((r) => Math.max(r, next)); };
  return (
    <Block title="Guided flows" components="Stepper, StepPanel, StepFooter" rule="Rule 11">
      <div className="glass-card space-y-6 rounded-xl p-4 lg:p-5">
        <Stepper steps={STEPS} current={step} reached={reached} onJump={go} label="Hiring progress" />
        <StepPanel stepKey={STEPS[step].key} title={step === 3 ? 'Review and hire' : `Step: ${STEPS[step].label}`} description="One step at a time, each checked before Next.">
          <div className="max-w-md">
            <TextInput label="Agent name" value="Nova" onChange={() => {}} />
          </div>
        </StepPanel>
        <StepFooter
          onBack={step > 0 ? () => go(step - 1) : undefined}
          onNext={() => (step < STEPS.length - 1 ? go(step + 1) : toast('success', 'Hired Nova'))}
          nextLabel={step === STEPS.length - 1 ? 'Hire Nova' : 'Next'}
          error={step === 2 ? 'Pick at least one area Nova may view.' : null}
        />
      </div>
    </Block>
  );
}

function TimeBlock({ now }: { now: number }) {
  const at = new Date(now);
  const lastYear = new Date(at.getFullYear() - 1, 10, 26, 9, 0).getTime();
  const samples = [
    { label: 'Seconds ago', value: now - 30_000 },
    { label: 'Minutes ago', value: now - 5 * 60_000 },
    { label: 'Earlier today', value: now - 2 * HOUR },
    { label: 'Yesterday', value: now - 26 * HOUR },
    { label: 'This year', value: now - 40 * 24 * HOUR },
    { label: 'Another year', value: lastYear },
  ];
  return (
    <Block title="Time" components="lib/time-format" rule="Rule 11">
      <div className="glass-card overflow-hidden rounded-xl">
        <ul className="divide-y divide-white/[0.05]">
          {samples.map((s) => (
            <li key={s.label} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-4 px-4 py-2.5 text-sm lg:px-5">
              <span className="text-zinc-400">{s.label}</span>
              <Tooltip content={formatFull(s.value)}>
                <span className="justify-self-start tabular-nums text-zinc-100">{formatAgo(s.value, { now: at })}</span>
              </Tooltip>
            </li>
          ))}
          <li className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-4 px-4 py-2.5 text-sm lg:px-5">
            <span className="text-zinc-400">Durations</span>
            <span className="tabular-nums text-zinc-100">Idle for {formatElapsed(20_000)}, {formatElapsed(16 * 60_000)}, {formatElapsed(65 * 60_000)}</span>
          </li>
        </ul>
      </div>
    </Block>
  );
}

function FormBlock() {
  const [email, setEmail] = useState('maya@');
  const [role, setRole] = useState('member');
  return (
    <Block title="Form fields" components="TextInput, Select, Textarea, Checkbox, Toggle" rule="Rules 12 and 19">
      <div className="glass-card space-y-5 rounded-xl p-4 lg:p-5">
        <h3 className="text-sm font-semibold text-white">Invite someone</h3>
        <div className="grid gap-5 lg:grid-cols-2">
          <TextInput label="Email" type="email" value={email} onChange={setEmail} placeholder="name@company.com" error={email.includes('.') ? undefined : 'Enter a full email address, like name@company.com.'} />
          <Select
            label="Role"
            value={role}
            onChange={setRole}
            options={[{ value: 'owner', label: 'Owner' }, { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }]}
          />
          <TextInput label="Title" value="" onChange={() => {}} placeholder="Designer" description="Shown under their name on Team." />
          <div className="flex flex-col gap-3 lg:pt-6">
            <Checkbox label="Send a welcome email" description="They get a link to sign in." checked={false} onChange={() => {}} />
            <Checkbox label="Add to every project" checked onChange={() => {}} />
          </div>
        </div>
      </div>
    </Block>
  );
}
