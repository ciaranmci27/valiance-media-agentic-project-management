'use client';

import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import {
  Clock,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  Play,
  Pause,
  Square,
  Timer,
  CircleDollarSign,
  CalendarDays,
  Users,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { KpiRow, KpiTile } from '@/components/ui/KpiTile';
import { Button } from '@/components/ui/Button';
import { EmptyCard, GroupLabel, NoMatches, RailCard, RailLayout, SubNav, TabToolbar } from '@/components/projects/TabLayout';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/inputs/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { TimeEntry, TimeSegment } from '@/lib/types';
import { siteConfig } from '@/site-config';
import { toLocalTimeString, toLocalDateString } from '@/lib/date-utils';
import {
  getWorkedHours,
  getWorkedMs,
  resegmentEntry,
  isPaused,
  isStalePause,
  isClientBillable,
} from '@/lib/time-entry-utils';
import {
  paidHourlyLineItemTotal,
  fifoPaymentBreakdowns,
  type PaymentBreakdown,
} from '@/lib/invoice-utils';
import { hasPermission } from '@/lib/access-control';

/* ── Types ── */

type TrackingMode = 'timer' | 'manual';
type ManualEntryMode = 'range' | 'duration';

interface TimeTrackingPanelProps {
  projectId: string;
  projectColor?: string;
}

function formatRate(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ── Helpers ── */

function formatHM(decimal: number): string {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}h`;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatGap(ms: number): string {
  if (ms < 60_000) return '< 1m';
  return formatHM(ms / 3_600_000);
}

/** Elapsed ms of a still-open segment; the 1s tick keeps renders fresh. */
function liveSegMs(startIso: string): number {
  return Math.max(0, Date.now() - new Date(startIso).getTime());
}

function formatTime(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

function getDateKey(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : undefined);
}

/**
 * Whole calendar days between two instants' local dates (in `timezone`):
 * 0 for same-day, 1 when `toIso` lands on the next day. Time editors carry
 * only HH:MM, so an overnight span's end needs its day offset restored
 * before the two can be compared.
 */
function calendarDayOffset(fromIso: string, toIso: string, timezone?: string): number {
  const from = Date.parse(`${getDateKey(fromIso, timezone)}T00:00:00`);
  const to = Date.parse(`${getDateKey(toIso, timezone)}T00:00:00`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getStorageKey(projectId: string) {
  return `time-tracking-mode-${projectId}`;
}

/* ── Component ── */

export function TimeTrackingPanel({ projectId, projectColor: rawColor }: TimeTrackingPanelProps) {
  const projectColor = rawColor || '#A1A1AA';
  const {
    getTimeEntriesByProject,
    team,
    tasks,
    getProject,
    getInvoicesByProject,
    addTimeEntry,
    updateTimeEntry,
    deleteTimeEntry,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    resumeStoppedTimer,
    getRunningTimer,
  } = useApp();
  const { teamMemberId, access } = useAuth();

  const tz = team.find((m) => m.id === teamMemberId)?.timezone;
  const entries = getTimeEntriesByProject(projectId);
  const project = getProject(projectId);
  const projectMembers = team.filter((m) => project?.member_ids?.includes(m.id));
  const canManageAllTime = hasPermission(access, 'time.manage_all');
  const canManageOwnTime = hasPermission(access, 'time.manage_own');
  const canSeeClientBilling =
    hasPermission(access, 'billing.manage') || hasPermission(access, 'invoices.read');
  const currentMember = team.find((member) => member.id === teamMemberId);
  const availableMembers =
    projectMembers.length > 0
      ? [
          ...projectMembers,
          ...(currentMember && !projectMembers.some((member) => member.id === currentMember.id)
            ? [currentMember]
            : []),
        ]
      : team;
  const memberOptions = canManageAllTime
    ? availableMembers
    : availableMembers.filter((member) => member.id === teamMemberId);
  // Current user's own running timer (may be null even when teammates are tracking).
  const runningTimer = getRunningTimer(projectId, teamMemberId || undefined);
  // Other members' running timers on this same project ; rendered as read-only cards.
  // Guard on teamMemberId so an unauthenticated render doesn't misclassify the
  // user's own entry as a "teammate" one.
  const teammateTimers = useMemo(
    () =>
      teamMemberId
        ? entries.filter((e) => e.end_time === null && e.member_id !== teamMemberId)
        : [],
    [entries, teamMemberId],
  );

  // ── Per-entry payment status (FIFO waterfall against paid hourly invoices) ──
  const invoices = getInvoicesByProject(projectId);
  const hourlyRate = project?.hourly_rate ?? 0;
  const isHourly = project?.client_time_billing
    ? project.client_time_billing === 'hourly'
    : (project?.hourly_tracking ?? false);

  const paymentBreakdownMap = useMemo<Map<string, PaymentBreakdown>>(() => {
    if (!isHourly) return new Map();
    const finalized = entries
      .filter(isClientBillable)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
      .map((e) => ({ id: e.id, hours: getWorkedHours(e), hourly_rate: e.hourly_rate }));
    return fifoPaymentBreakdowns(finalized, paidHourlyLineItemTotal(invoices), hourlyRate);
  }, [isHourly, hourlyRate, invoices, entries]);

  // ── Mode selection (persisted per project, defaults to timer) ──
  const [mode, setMode] = useState<TrackingMode>(() => {
    if (typeof window === 'undefined') return 'timer';
    const stored = localStorage.getItem(getStorageKey(projectId));
    if (stored === 'timer' || stored === 'manual') return stored;
    return 'timer';
  });
  // A running timer always shows timer mode. Derived, not forced via
  // setState: the stored preference is untouched, so stopping the timer
  // returns the panel to whatever the user last chose.
  const effectiveMode: TrackingMode = runningTimer ? 'timer' : mode;

  const toggleMode = () => {
    if (runningTimer) {
      toast('error', 'Stop the running timer before switching modes');
      return;
    }
    const next: TrackingMode = mode === 'manual' ? 'timer' : 'manual';
    // Carry description across modes
    if (mode === 'manual' && manualDescription) {
      setTimerDescription(manualDescription);
    } else if (mode === 'timer' && timerDescription) {
      setManualDescription(timerDescription);
    }
    setMode(next);
    localStorage.setItem(getStorageKey(projectId), next);
  };

  // ── Live tick for running timer cards ──
  // A single interval drives re-renders for every visible running card (mine +
  // teammates'). Each card reads its own elapsed from getWorkedMs(entry), which
  // is stable when paused (last segment already has an end), so paused cards
  // naturally freeze without special handling.
  const [, setTick] = useState(0);
  const hasAnyActiveSegment = useMemo(() => {
    const all = runningTimer ? [runningTimer, ...teammateTimers] : teammateTimers;
    return all.some((e) => {
      const last = e.segments[e.segments.length - 1];
      return last && last.end === null;
    });
  }, [runningTimer, teammateTimers]);

  useEffect(() => {
    if (!hasAnyActiveSegment) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasAnyActiveSegment]);

  const runningTimerIsPaused = runningTimer ? isPaused(runningTimer) : false;

  // ── Timer form state ──
  const [timerMemberId, setTimerMemberId] = useState('');
  const [timerDescription, setTimerDescription] = useState('');
  const [timerWorkType, setTimerWorkType] = useState<'client' | 'internal'>('client');
  const [timerTaskIds, setTimerTaskIds] = useState<string[]>([]);
  const [adjustingStart, setAdjustingStart] = useState(false);
  const [adjustStartTime, setAdjustStartTime] = useState('');
  const descDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-entry state sync, done with the render-derive pattern rather than an
  // effect (setState inside an effect is a cascading-render lint error).
  // When the running entry changes: seed the description input from it, and
  // drop any in-progress start adjustment, which belonged to the previous
  // entry. Mode forcing needs no state at all; see effectiveMode above.
  const [syncedTimerId, setSyncedTimerId] = useState<string | null>(null);
  if ((runningTimer?.id ?? null) !== syncedTimerId) {
    setSyncedTimerId(runningTimer?.id ?? null);
    if (runningTimer) setTimerDescription(runningTimer.description || '');
    // The timer ended (here, in another tab, or by an agent): the form is for
    // the next timer, so it starts empty instead of echoing the saved entry.
    else if (syncedTimerId) {
      setTimerDescription('');
      setTimerTaskIds([]);
    }
    setAdjustingStart(false);
    setAdjustStartTime('');
  }

  // ── Manual entry form state ──
  const [manualEntryMode, setManualEntryMode] = useState<ManualEntryMode>('range');
  const [manualDate, setManualDate] = useState(toLocalDateString(tz));
  const [manualStartTime, setManualStartTime] = useState('');
  const [manualEndTime, setManualEndTime] = useState('');
  const [manualDurationHours, setManualDurationHours] = useState<number | ''>('');
  const [manualDurationMinutes, setManualDurationMinutes] = useState<number | ''>('');
  const [manualMemberId, setManualMemberId] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualWorkType, setManualWorkType] = useState<'client' | 'internal'>('client');
  const [manualTaskIds, setManualTaskIds] = useState<string[]>([]);

  useEffect(() => {
    if (!teamMemberId) return;
    if (!canManageAllTime) {
      setTimerMemberId(teamMemberId);
      setManualMemberId(teamMemberId);
      return;
    }
    setManualMemberId((current) => current || teamMemberId);
  }, [canManageAllTime, teamMemberId]);

  // ── Edit state ──
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<{
    date: string;
    startTime: string;
    endTime: string;
    description: string;
    memberId: string;
    workType: 'client' | 'internal';
    taskIds: string[];
    // What the end field was seeded with. For a RUNNING entry the seed is
    // "now", so recomputing "now" again at save time to detect changes would
    // drift across a minute boundary and spuriously finalize a live timer on
    // a task-only edit. Change detection must compare against the seed.
    seededEndTime: string;
  } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── Segment edit/delete state ──
  const [editingSegment, setEditingSegment] = useState<{
    entryId: string;
    index: number;
    startTime: string;
    endTime: string;
  } | null>(null);
  const [deleteSegmentTarget, setDeleteSegmentTarget] = useState<{
    entryId: string;
    index: number;
  } | null>(null);

  // ── Computed ──
  const completedEntries = useMemo(() => entries.filter((e) => e.end_time !== null), [entries]);

  const totalHours = useMemo(
    () => completedEntries.reduce((sum, e) => sum + getWorkedHours(e), 0),
    [completedEntries],
  );

  // ── Resume after stop ──
  // Your own most recent completed entry can be reopened while its stop is
  // still fresh, the undo for an accidental Stop click. Freshness reuses the
  // pause staleness rule (not across a 4h-old midnight, judged by the browser
  // clock) so both resume paths draw the same line. Hidden while any of your
  // timers runs on the project (one unfinalized entry per member).
  //
  // Approval status is deliberately NOT checked here: the DB trigger stamps
  // owner and auto-approved entries 'approved' the instant they stop, so an
  // approved-check hid the icon from the very people it was built for. The
  // same trigger resets a reopened entry to 'draft' and re-approves it on the
  // next stop, so the lifecycle round-trips cleanly. Who may reopen follows
  // the row's canModifyEntry (this icon renders inside that block), which
  // mirrors the server PATCH rule: managers can edit approved entries,
  // everyone else gets a 409.
  const resumableEntryId = useMemo(() => {
    if (!teamMemberId || runningTimer) return null;
    const own = completedEntries.filter((e) => e.member_id === teamMemberId && e.end_time !== null);
    if (own.length === 0) return null;
    const latest = own.reduce((a, b) =>
      new Date(a.end_time!).getTime() >= new Date(b.end_time!).getTime() ? a : b,
    );
    if (isStalePause(latest.end_time!)) return null;
    return latest.id;
  }, [completedEntries, teamMemberId, runningTimer]);

  const handleResumeStopped = async (entryId: string) => {
    const reopened = await resumeStoppedTimer(entryId);
    if (reopened) toast('success', 'Timer resumed');
  };

  const thisWeekHours = useMemo(() => {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return completedEntries
      .filter((e) => {
        const d = new Date(e.start_time);
        return d >= monday && d <= sunday;
      })
      .reduce((sum, e) => sum + getWorkedHours(e), 0);
  }, [completedEntries]);

  const uniqueMembers = useMemo(() => {
    const ids = new Set(entries.map((e) => e.member_id));
    return Array.from(ids)
      .map((id) => team.find((m) => m.id === id))
      .filter(Boolean) as typeof team;
  }, [entries, team]);

  const groupedByDate = useMemo(() => {
    const completed = [...completedEntries].sort(
      (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime(),
    );
    const groups: Record<string, TimeEntry[]> = {};
    for (const entry of completed) {
      const dateKey = getDateKey(entry.start_time, tz);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(entry);
    }
    return groups;
  }, [completedEntries, tz]);

  // When the tab opened: the anchor for the 7-day sparkline (render stays pure).
  const [openedAt] = useState(() => Date.now());
  const [openDescriptions, setOpenDescriptions] = useState<Set<string>>(() => new Set());
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionRange, setSessionRange] = useState<'all' | 'week' | 'month'>('all');
  const toggleDescription = (id: string) =>
    setOpenDescriptions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const getMember = (id: string) => team.find((m) => m.id === id);
  const getTaskTitle = (id: string | null | undefined) =>
    id ? tasks.find((t) => t.id === id)?.title : undefined;
  const projectTaskOptions = useMemo(
    () =>
      tasks
        .filter((t) => t.project_id === projectId && t.status !== 'done')
        .map((t) => ({ value: t.id, label: t.title })),
    [tasks, projectId],
  );

  // ── Handlers ──

  const handleStartTimer = () => {
    const memberId = timerMemberId || teamMemberId;
    if (!memberId) {
      toast('error', 'Please select a team member');
      return;
    }
    startTimer(projectId, memberId, timerDescription, undefined, timerWorkType, timerTaskIds);
    setTimerDescription('');
    setTimerTaskIds([]);
    toast('success', 'Timer started');
  };

  const handleAdjustStart = () => {
    if (!runningTimer || !adjustStartTime) return;
    const dateKey = getDateKey(runningTimer.start_time, tz);
    const adjusted = new Date(`${dateKey}T${adjustStartTime}`);
    if (adjusted.getTime() > Date.now()) {
      toast('error', 'Start time cannot be in the future');
      return;
    }
    // Keep the first segment's start in sync with the denormalized start_time.
    // getWorkedMs reads durations from segments, so a bare start_time update
    // would silently leave the elapsed display unchanged.
    const firstSeg = runningTimer.segments[0];
    if (firstSeg?.end && adjusted.getTime() >= new Date(firstSeg.end).getTime()) {
      toast('error', 'Start time must be before the first pause');
      return;
    }
    const adjustedIso = adjusted.toISOString();
    const newSegments =
      runningTimer.segments.length > 0
        ? runningTimer.segments.map((seg, i) => (i === 0 ? { ...seg, start: adjustedIso } : seg))
        : [{ start: adjustedIso, end: null }];
    updateTimeEntry(runningTimer.id, { start_time: adjustedIso, segments: newSegments });
    setAdjustingStart(false);
    setAdjustStartTime('');
    toast('success', 'Start time adjusted');
  };

  const handlePauseTimer = () => {
    if (!runningTimer) return;
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }
    // One request: the description rides along with the pause, so there is
    // no in-between answer that still shows the timer running.
    pauseTimer(
      runningTimer.id,
      timerDescription && timerDescription !== runningTimer.description ? { description: timerDescription } : {},
    );
  };

  const handleResumeTimer = () => {
    if (!runningTimer) return;
    // Flush the pending description debounce like pause/stop do. The stale
    // path of resumeTimer copies the entry's description into the fresh
    // timer it starts, so an unflushed edit would be dropped there.
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }
    if (timerDescription && timerDescription !== runningTimer.description) {
      updateTimeEntry(runningTimer.id, { description: timerDescription });
    }
    resumeTimer(runningTimer.id);
  };

  const handleStopTimer = () => {
    if (!runningTimer) return;
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }
    stopTimer(
      runningTimer.id,
      timerDescription && timerDescription !== runningTimer.description ? { description: timerDescription } : {},
    );
    setTimerDescription('');
    setTimerTaskIds([]);
    toast('success', 'Timer stopped');
  };

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualMemberId) {
      toast('error', 'Please select a team member');
      return;
    }
    if (!manualStartTime) {
      toast('error', 'Please select a start time');
      return;
    }

    const start = new Date(`${manualDate}T${manualStartTime}`);
    let end: Date;

    if (manualEntryMode === 'duration') {
      const hrs = typeof manualDurationHours === 'number' ? manualDurationHours : 0;
      const mins = typeof manualDurationMinutes === 'number' ? manualDurationMinutes : 0;
      if (hrs === 0 && mins === 0) {
        toast('error', 'Please enter a duration');
        return;
      }
      end = new Date(start.getTime() + hrs * 3_600_000 + mins * 60_000);
    } else {
      if (!manualEndTime) {
        toast('error', 'Please select an end time');
        return;
      }
      end = new Date(`${manualDate}T${manualEndTime}`);
      if (end < start) {
        end.setDate(end.getDate() + 1);
      } else if (end.getTime() === start.getTime()) {
        toast('error', 'End time must be after start time');
        return;
      }
    }

    addTimeEntry({
      project_id: projectId,
      member_id: manualMemberId,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      segments: [{ start: start.toISOString(), end: end.toISOString() }],
      hourly_rate: project?.hourly_rate ?? 0,
      description: manualDescription,
      work_type: manualWorkType,
      task_ids: manualTaskIds,
    });
    toast('success', 'Time entry added');
    setManualDescription('');
    setManualTaskIds([]);
    setManualStartTime('');
    setManualEndTime('');
    setManualDurationHours('');
    setManualDurationMinutes('');
    setManualDate(toLocalDateString(tz));
  };

  const startEdit = (entry: TimeEntry) => {
    setEditingSegment(null); // segment edit and entry edit are mutually exclusive
    setEditingId(entry.id);
    const seededEndTime = toLocalTimeString(entry.end_time || new Date().toISOString(), tz);
    setEditState({
      date: getDateKey(entry.start_time, tz),
      startTime: toLocalTimeString(entry.start_time, tz),
      endTime: seededEndTime,
      seededEndTime,
      description: entry.description,
      memberId: entry.member_id,
      workType: entry.work_type || 'client',
      taskIds: entry.task_ids || [],
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditState(null);
  };

  // ── Segment handlers ──
  const startEditSegment = (entry: TimeEntry, index: number) => {
    const seg = entry.segments[index];
    if (!seg) return;
    setEditingId(null);
    setEditState(null);
    setEditingSegment({
      entryId: entry.id,
      index,
      startTime: toLocalTimeString(seg.start, tz),
      // An open (live) segment has no end yet; only its start is editable.
      endTime: seg.end ? toLocalTimeString(seg.end, tz) : '',
    });
  };

  const cancelEditSegment = () => setEditingSegment(null);

  const saveEditSegment = () => {
    if (!editingSegment) return;
    const entry = entries.find((e) => e.id === editingSegment.entryId);
    if (!entry) return;
    const origSeg = entry.segments[editingSegment.index];
    if (!origSeg) return;

    // Anchor both fields to the segment's own start date. Segments CAN span
    // midnight (a timer left running overnight), so the end's calendar day
    // is resolved below rather than assumed to match.
    const dateKey = getDateKey(origSeg.start, tz);
    const newStart = new Date(`${dateKey}T${editingSegment.startTime}`);
    if (Number.isNaN(newStart.getTime())) {
      toast('error', 'Invalid time');
      return;
    }
    let newSeg: TimeSegment;
    if (origSeg.end === null) {
      // The live segment: only its start moves, and never into the future.
      if (newStart.getTime() > Date.now()) {
        toast('error', 'Start time cannot be in the future');
        return;
      }
      newSeg = { start: newStart.toISOString(), end: null };
    } else {
      const newEnd = new Date(`${dateKey}T${editingSegment.endTime}`);
      if (Number.isNaN(newEnd.getTime())) {
        toast('error', 'Invalid time');
        return;
      }
      // Resolve which day the end lands on. HH:MM alone cannot say, and
      // parsing it onto the start's date made an overnight segment's editor
      // invalid the moment it opened (11:03 PM - 11:24 AM read as ending
      // before it began). An unchanged field keeps the segment's original
      // day offset; an edited one rolls forward a day when it reads before
      // the start, mirroring the manual-entry form's rule.
      const endFieldChanged = editingSegment.endTime !== toLocalTimeString(origSeg.end, tz);
      if (!endFieldChanged) {
        newEnd.setDate(newEnd.getDate() + calendarDayOffset(origSeg.start, origSeg.end, tz));
      } else if (newEnd < newStart) {
        // Strictly before: an end EQUAL to the start is an input error, not
        // a day rollover (rolling it would mint a 24h segment).
        newEnd.setDate(newEnd.getDate() + 1);
      }
      if (newEnd <= newStart) {
        toast('error', 'End time must be after start time');
        return;
      }
      newSeg = { start: newStart.toISOString(), end: newEnd.toISOString() };
    }

    // Build the updated segments array and validate ordering against neighbors.
    const newSegments = entry.segments.map((s, i) => (i === editingSegment.index ? newSeg : s));
    const before = newSegments[editingSegment.index - 1];
    const after = newSegments[editingSegment.index + 1];
    if (before && before.end && new Date(before.end).getTime() > newStart.getTime()) {
      toast('error', 'Segment cannot overlap the previous one');
      return;
    }
    if (after && newSeg.end && new Date(after.start).getTime() < new Date(newSeg.end).getTime()) {
      toast('error', 'Segment cannot overlap the next one');
      return;
    }

    // Keep denormalized start_time / end_time mirrored on the first/last
    // segment. Never mirror end_time onto an unfinalized entry: a PAUSED
    // entry's last segment has an end, and writing it to end_time would
    // silently stop the timer.
    const firstStart = newSegments[0].start;
    const lastEnd = newSegments[newSegments.length - 1].end;
    updateTimeEntry(entry.id, {
      segments: newSegments,
      start_time: firstStart,
      ...(entry.end_time !== null && lastEnd ? { end_time: lastEnd } : {}),
    });
    setEditingSegment(null);
    toast('success', 'Segment updated');
  };

  const executeDeleteSegment = () => {
    if (!deleteSegmentTarget) return;
    const entry = entries.find((e) => e.id === deleteSegmentTarget.entryId);
    if (!entry) {
      setDeleteSegmentTarget(null);
      return;
    }
    if (entry.segments.length <= 1) {
      toast('error', 'Cannot delete the only segment ; delete the entry instead');
      setDeleteSegmentTarget(null);
      return;
    }
    const newSegments = entry.segments.filter((_, i) => i !== deleteSegmentTarget.index);
    const firstStart = newSegments[0].start;
    const lastEnd = newSegments[newSegments.length - 1].end;
    updateTimeEntry(entry.id, {
      segments: newSegments,
      start_time: firstStart,
      // Same unfinalized guard as saveEditSegment: deleting a closed block
      // from a running or paused session must not finalize the entry.
      ...(entry.end_time !== null && lastEnd ? { end_time: lastEnd } : {}),
    });
    setDeleteSegmentTarget(null);
    toast('success', 'Segment removed');
  };

  const saveEdit = () => {
    if (!editingId || !editState) return;
    const original = entries.find((e) => e.id === editingId);
    if (!original) return;

    // Detect time-field changes by comparing the editState values against
    // what they were seeded with in startEdit. Comparing raw ISO strings
    // doesn't work: Supabase returns `+00:00` while `toISOString()` returns
    // `.000Z` for the same instant, so a string `!==` would always flag
    // "changed" and nuke the segments on every save.
    const originalDate = getDateKey(original.start_time, tz);
    const originalStartTime = toLocalTimeString(original.start_time, tz);
    const originalEndTime = editState.seededEndTime;
    const timeFieldsChanged =
      editState.date !== originalDate ||
      editState.startTime !== originalStartTime ||
      editState.endTime !== originalEndTime;

    const patch: Partial<
      Pick<
        TimeEntry,
        | 'member_id'
        | 'start_time'
        | 'end_time'
        | 'segments'
        | 'description'
        | 'work_type'
        | 'task_ids'
      >
    > = {
      description: editState.description,
      member_id: editState.memberId,
      work_type: editState.workType,
    };

    // Only send task links when they actually changed: the PATCH replaces the
    // whole link set, so an unconditional send would rewrite rows on every
    // save, and order is irrelevant to equality.
    const originalTaskKey = [...(original.task_ids || [])].sort().join(',');
    const editedTaskKey = [...editState.taskIds].sort().join(',');
    if (editedTaskKey !== originalTaskKey) {
      patch.task_ids = editState.taskIds;
    }

    if (timeFieldsChanged) {
      const start = new Date(`${editState.date}T${editState.startTime}`);
      const end = new Date(`${editState.date}T${editState.endTime}`);
      // Resolve the end's calendar day. An overnight session ends on a later
      // day than it starts; parsing the unchanged end onto the start's date
      // would silently truncate the span (10:46 AM - 11:24 AM next day would
      // collapse to 38 minutes on a date-only edit). Unchanged keeps the
      // original day offset; edited rolls forward when it reads before the
      // start, as before.
      const endFieldChanged = editState.endTime !== editState.seededEndTime;
      if (!endFieldChanged && original.end_time) {
        end.setDate(end.getDate() + calendarDayOffset(original.start_time, original.end_time, tz));
      } else if (end < start) {
        end.setDate(end.getDate() + 1);
      }
      if (end.getTime() <= start.getTime()) {
        toast('error', 'End time must be after start time');
        return;
      }
      // Segments are re-derived rather than flattened. resegmentEntry owns
      // every case (start or end landing mid-segment or inside a pause, the
      // whole session moving day, nothing surviving at all) and guarantees no
      // edit can invent worked time; see its docs for the rules.
      const resegmented = resegmentEntry({
        segments: original.segments || [],
        previousStart: original.start_time,
        newStart: start.getTime(),
        newEnd: end.getTime(),
        dayShifted: editState.date !== originalDate,
      });
      // Persist the bounds the segments justify, not the raw input: dragging
      // an edge into a pause settles on the neighbouring block's own edge, and
      // the entry's start/end must agree with its segments.
      patch.start_time = new Date(resegmented.start).toISOString();
      patch.end_time = new Date(resegmented.end).toISOString();
      patch.segments = resegmented.segments;
    }

    updateTimeEntry(editingId, patch);
    toast('success', 'Time entry updated');
    cancelEdit();
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    const entry = entries.find((item) => item.id === deleteTarget);
    const canModifyEntry = Boolean(
      entry &&
        (canManageAllTime ||
          (canManageOwnTime &&
            entry.member_id === teamMemberId &&
            entry.approval_status !== 'approved')),
    );
    if (!canModifyEntry) {
      setDeleteTarget(null);
      return;
    }
    const deleted = await deleteTimeEntry(deleteTarget);
    if (deleted) toast('success', 'Time entry moved to Trash');
  };

  const dateGroups = Object.entries(groupedByDate);

  // Toolbar search and period, applied to the sessions list only (the tiles
  // always show the whole project).
  const sessionRangeStart = (() => {
    if (sessionRange === 'all') return 0;
    const start = new Date(openedAt);
    start.setHours(0, 0, 0, 0);
    if (sessionRange === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    else start.setDate(1);
    return start.getTime();
  })();
  const sessionNeedle = sessionQuery.trim().toLowerCase();
  const sessionMatches = (entry: TimeEntry) =>
    new Date(entry.start_time).getTime() >= sessionRangeStart &&
    (!sessionNeedle ||
      (entry.description || '').toLowerCase().includes(sessionNeedle) ||
      (getMember(entry.member_id)?.name || '').toLowerCase().includes(sessionNeedle) ||
      (entry.task_ids || []).some((id) => (getTaskTitle(id) || '').toLowerCase().includes(sessionNeedle)));
  const visibleDateGroups = dateGroups
    .map(([date, list]) => [date, list.filter(sessionMatches)] as [string, TimeEntry[]])
    .filter(([, list]) => list.length > 0);

  // Segment breakdown list, shared by the live timer card and history rows.
  // The open (still running) segment shows "start – now" with a live
  // duration; its START is editable like any other row, but it has no end
  // to edit and cannot be deleted (that would be a disguised pause).
  // History rows keep their own margins; the live card's space-y already
  // provides spacing, so it passes marginClass ''.
  const renderSegmentList = (entry: TimeEntry, canModify: boolean, marginClass = 'mt-2 mb-1') => (
    <ul
      className={`seg-zone ${marginClass} rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-1.5 space-y-1`}
    >
      {entry.segments.map((seg, i) => {
        const isEditingThisSegment =
          editingSegment?.entryId === entry.id && editingSegment.index === i;
        const segDurationHours = seg.end
          ? (new Date(seg.end).getTime() - new Date(seg.start).getTime()) / 3_600_000
          : 0;
        // Gap to the next segment = pause duration. Only shown when this
        // segment has an end (otherwise it's still running and there's no
        // "pause" yet) and a next segment exists.
        const nextSeg = entry.segments[i + 1];
        const gapMs =
          seg.end && nextSeg ? new Date(nextSeg.start).getTime() - new Date(seg.end).getTime() : 0;
        const showGap = gapMs > 0;
        const gapLabel = showGap ? (
          <li key={`gap-${i}`} className="flex items-center gap-1.5 pl-[3px] select-none">
            <span className="w-px h-2.5 bg-white/[0.08] ml-[2px]" />
            <span className="text-[10px] italic text-zinc-500">Paused for {formatGap(gapMs)}</span>
          </li>
        ) : null;
        if (isEditingThisSegment && editingSegment) {
          return (
            <Fragment key={i}>
              <li className="flex items-center gap-1.5 py-0.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: projectColor }}
                />
                <div className="w-[88px]">
                  <TimeInput
                    size="sm"
                    value={editingSegment.startTime}
                    onChange={(v) => setEditingSegment({ ...editingSegment, startTime: v })}
                  />
                </div>
                {seg.end !== null ? (
                  <>
                    <span className="text-[10px] text-zinc-600 select-none">–</span>
                    <div className="w-[88px]">
                      <TimeInput
                        size="sm"
                        value={editingSegment.endTime}
                        onChange={(v) => setEditingSegment({ ...editingSegment, endTime: v })}
                      />
                    </div>
                  </>
                ) : (
                  <span className="text-[10px] text-zinc-500 select-none">– now</span>
                )}
                <button
                  aria-label="Save segment changes"
                  onClick={saveEditSegment}
                  className="p-1 text-emerald-400 hover:bg-emerald-500/15 rounded transition-colors flex-shrink-0"
                >
                  <Check size={12} />
                </button>
                <button
                  aria-label="Cancel segment changes"
                  onClick={cancelEditSegment}
                  className="p-1 text-zinc-500 hover:bg-white/[0.06] rounded transition-colors flex-shrink-0"
                >
                  <X size={12} />
                </button>
              </li>
              {gapLabel}
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            <li className="flex items-center gap-2 group/seg">
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${seg.end === null ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: projectColor }}
              />
              <span className="text-[11px] font-medium text-zinc-300 tabular-nums">
                {formatTime(seg.start, tz)} – {seg.end ? formatTime(seg.end, tz) : 'now'}
              </span>
              <span className="text-[10px] text-zinc-500 tabular-nums">
                {seg.end ? formatHM(segDurationHours) : formatGap(liveSegMs(seg.start))}
              </span>
              {canModify ? (
                <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/seg:opacity-100 transition-opacity">
                  <Tooltip content={seg.end ? 'Edit segment' : 'Edit start time'}>
                    <button
                      aria-label={seg.end ? 'Edit segment' : 'Edit start time'}
                      onClick={() => startEditSegment(entry, i)}
                      className="p-1 text-zinc-500 hover:text-brand-300 hover:bg-surface-raised rounded transition-colors"
                    >
                      <Pencil size={11} />
                    </button>
                  </Tooltip>
                  {seg.end && (
                    <Tooltip content="Delete segment">
                      <button
                        aria-label="Delete segment"
                        onClick={() => setDeleteSegmentTarget({ entryId: entry.id, index: i })}
                        className="p-1 text-zinc-500 hover:text-red-500 hover:bg-surface-raised rounded transition-colors"
                      >
                        <Trash2 size={11} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              ) : null}
            </li>
            {gapLabel}
          </Fragment>
        );
      })}
    </ul>
  );

  // ── Tab summary ──
  // Daily hours for the last 7 days (oldest first), for the This week sparkline.
  const sparkKeys = Array.from({ length: 7 }, (_, i) =>
    getDateKey(new Date(openedAt - (6 - i) * 86_400_000).toISOString(), tz));
  const lastSevenDays = sparkKeys.map(() => 0);
  for (const entry of completedEntries) {
    const index = sparkKeys.indexOf(getDateKey(entry.start_time, tz));
    if (index >= 0) lastSevenDays[index] += getWorkedHours(entry);
  }
  const unpaidTimeTotal = canSeeClientBilling && isHourly
    ? Array.from(paymentBreakdownMap.values()).reduce((sum, b) => sum + b.unpaidAmount, 0)
    : null;

  const workTypeOptions = [
    { value: 'client', label: 'Client work' },
    { value: 'internal', label: 'Internal work' },
  ];
  const memberSelectOptions = memberOptions.map((m) => ({
    value: m.id,
    label: m.name,
    icon: <Avatar name={m.name} src={m.avatar} size="xs" />,
  }));

  /* ================================================================
     RENDER
     A tab of its own: the tracker sits in a sticky right rail (first on
     phones), the summary and every session fill the main column.
  ================================================================ */
  const modeToggle = (
    <div className="seg-track seg-sm" role="tablist" aria-label="Tracking mode">
      <button
        type="button"
        role="tab"
        aria-selected={effectiveMode === 'timer'}
        onClick={() => {
          if (effectiveMode !== 'timer') toggleMode();
        }}
        className={`seg-item flex items-center gap-1.5 ${effectiveMode === 'timer' ? 'is-active' : ''}`}
      >
        <Timer size={12} aria-hidden="true" />
        Timer
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={effectiveMode === 'manual'}
        onClick={() => {
          if (effectiveMode !== 'manual') toggleMode();
        }}
        className={`seg-item flex items-center gap-1.5 ${effectiveMode === 'manual' ? 'is-active' : ''}`}
      >
        <Clock size={12} aria-hidden="true" />
        Manual
      </button>
    </div>
  );

  const trackCard = (
    <RailCard title="Track time" icon={<Timer size={16} className="text-zinc-400" aria-hidden="true" />} action={modeToggle}>
      {effectiveMode === 'timer' && runningTimer && (
        <div
          className="rounded-xl border p-4 space-y-4"
          style={{
            borderColor: runningTimerIsPaused ? 'var(--color-surface-border)' : projectColor + '30',
            backgroundColor: runningTimerIsPaused ? 'rgba(var(--ink), 0.04)' : projectColor + '06',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 relative">
              <Avatar
                name={getMember(runningTimer.member_id)?.name || '?'}
                src={getMember(runningTimer.member_id)?.avatar}
                size="sm"
              />
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface-raised ${runningTimerIsPaused ? '' : 'motion-safe:animate-pulse'}`}
                style={{ backgroundColor: runningTimerIsPaused ? 'var(--color-zinc-400)' : projectColor }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-100 truncate">
                {getMember(runningTimer.member_id)?.name}
                {runningTimerIsPaused && <span className="ml-1.5 text-xs font-normal text-zinc-500">· Paused</span>}
              </p>
              {/* "Started X" (and its adjust pencil) is the single-segment
                  affordance. Once a pause splits the session, the segment
                  list below carries the same fact with its editor. */}
              {runningTimer.segments.length > 1 ? null : adjustingStart ? (
                <div className="flex items-center gap-1.5 mt-1">
                  <div className="w-[120px]">
                    <TimeInput size="sm" value={adjustStartTime} onChange={setAdjustStartTime} />
                  </div>
                  <button
                    type="button"
                    aria-label="Save start time"
                    onClick={handleAdjustStart}
                    className="p-1 text-emerald-400 hover:bg-emerald-500/15 rounded transition-colors flex-shrink-0"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel start time change"
                    onClick={() => {
                      setAdjustingStart(false);
                      setAdjustStartTime('');
                    }}
                    className="p-1 text-zinc-500 hover:bg-white/[0.06] rounded transition-colors flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                  Started {formatTime(runningTimer.start_time, tz)}
                  <button
                    type="button"
                    aria-label="Adjust start time"
                    onClick={() => {
                      setAdjustingStart(true);
                      setAdjustStartTime(toLocalTimeString(runningTimer.start_time, tz));
                    }}
                    className="text-zinc-600 hover:text-zinc-400 transition-colors flex-shrink-0"
                  >
                    <Pencil size={11} />
                  </button>
                </p>
              )}
            </div>
          </div>

          <p
            className="text-4xl font-bold font-mono tabular-nums tracking-tight leading-none"
            style={{ color: runningTimerIsPaused ? 'var(--color-zinc-400)' : projectColor }}
            aria-live="off"
          >
            {formatElapsed(Math.floor(getWorkedMs(runningTimer) / 1000))}
          </p>

          <Textarea
            autoResize
            maxHeight={168}
            aria-label="What are you working on?"
            value={timerDescription}
            onChange={(val) => {
              setTimerDescription(val);
              if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
              descDebounceRef.current = setTimeout(() => {
                updateTimeEntry(runningTimer.id, { description: val });
              }, 500);
            }}
            placeholder="What are you working on?"
          />

          <div className="grid grid-cols-2 gap-2">
            {runningTimerIsPaused ? (
              <Button type="button" className="w-full" onClick={handleResumeTimer} icon={<Play size={13} aria-hidden="true" />}>
                Resume
              </Button>
            ) : (
              <Button type="button" variant="secondary" className="w-full" onClick={handlePauseTimer} icon={<Pause size={13} aria-hidden="true" />}>
                Pause
              </Button>
            )}
            <Button type="button" variant="danger" className="w-full" onClick={handleStopTimer} icon={<Square size={12} aria-hidden="true" />}>
              Stop
            </Button>
          </div>

          {/* Segment breakdown for the LIVE session, visible once a pause has
              split it, so each worked block can be corrected without stopping. */}
          {runningTimer.segments.length > 1 &&
            renderSegmentList(runningTimer, canManageAllTime || canManageOwnTime, '')}

          {/* Task links on the LIVE session write through immediately. Done
              tasks already linked stay in the options so a change cannot
              silently drop them. */}
          {(projectTaskOptions.length > 0 || (runningTimer.task_ids || []).length > 0) && (
            <MultiSelect
              options={[
                ...projectTaskOptions,
                ...(runningTimer.task_ids || [])
                  .filter((id) => !projectTaskOptions.some((o) => o.value === id))
                  .map((id) => ({ value: id, label: getTaskTitle(id) || 'Removed task' })),
              ]}
              value={runningTimer.task_ids || []}
              onChange={(v) => updateTimeEntry(runningTimer.id, { task_ids: v })}
              placeholder="Link tasks (optional)"
              searchable={projectTaskOptions.length > 4}
            />
          )}
        </div>
      )}

      {effectiveMode === 'timer' && !runningTimer && (
        <div className="space-y-3">
          <Textarea
            autoResize
            maxHeight={168}
            aria-label="What are you working on?"
            value={timerDescription}
            onChange={setTimerDescription}
            placeholder="What are you working on?"
          />
          <div className={`grid gap-2 ${canManageAllTime ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {canManageAllTime && (
              <div className="min-w-0">
                <Select
                  value={timerMemberId || teamMemberId || ''}
                  onChange={setTimerMemberId}
                  options={memberSelectOptions}
                  placeholder="Select member"
                />
              </div>
            )}
            <div className="min-w-0">
              <Select
                value={timerWorkType}
                onChange={(value) => setTimerWorkType(value as 'client' | 'internal')}
                options={workTypeOptions}
              />
            </div>
          </div>
          {projectTaskOptions.length > 0 && (
            <MultiSelect
              options={projectTaskOptions}
              value={timerTaskIds}
              onChange={setTimerTaskIds}
              placeholder="Link tasks (optional)"
              searchable={projectTaskOptions.length > 4}
            />
          )}
          <Button type="button" className="w-full h-10" onClick={handleStartTimer} icon={<Play size={14} aria-hidden="true" />}>
            Start timer
          </Button>
        </div>
      )}

      {effectiveMode === 'manual' && (
        <form onSubmit={handleManualAdd} className="space-y-3">
          <div className={`grid gap-2 ${canManageAllTime ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <div className="min-w-0">
              <DateInput value={manualDate} onChange={setManualDate} placeholder="Date" />
            </div>
            {canManageAllTime && (
              <div className="min-w-0">
                <Select
                  value={manualMemberId}
                  onChange={setManualMemberId}
                  options={memberSelectOptions}
                  placeholder="Team member"
                />
              </div>
            )}
          </div>

          <div className="seg-track seg-sm w-full" role="tablist" aria-label="Entry type">
            <button
              type="button"
              role="tab"
              aria-selected={manualEntryMode === 'range'}
              onClick={() => setManualEntryMode('range')}
              className={`seg-item flex-1 ${manualEntryMode === 'range' ? 'is-active' : ''}`}
            >
              Time range
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={manualEntryMode === 'duration'}
              onClick={() => setManualEntryMode('duration')}
              className={`seg-item flex-1 ${manualEntryMode === 'duration' ? 'is-active' : ''}`}
            >
              Duration
            </button>
          </div>
          {manualEntryMode === 'duration' ? (
            <div className="space-y-2">
              <TimeInput value={manualStartTime} onChange={setManualStartTime} placeholder="Start time" />
              <div className="grid grid-cols-2 gap-2">
                <NumberInput
                  value={manualDurationHours}
                  onChange={setManualDurationHours}
                  min={0}
                  max={23}
                  placeholder="0"
                  suffix="hr"
                  showButtons={false}
                />
                <NumberInput
                  value={manualDurationMinutes}
                  onChange={setManualDurationMinutes}
                  min={0}
                  max={59}
                  step={5}
                  placeholder="0"
                  suffix="min"
                  showButtons={false}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <TimeInput value={manualStartTime} onChange={setManualStartTime} placeholder="Start time" />
              <TimeInput value={manualEndTime} onChange={setManualEndTime} placeholder="End time" />
            </div>
          )}

          <Textarea
            autoResize
            maxHeight={168}
            aria-label="What did you work on?"
            value={manualDescription}
            onChange={setManualDescription}
            placeholder="What did you work on?"
          />
          <Select
            value={manualWorkType}
            onChange={(value) => setManualWorkType(value as 'client' | 'internal')}
            options={workTypeOptions}
          />
          {projectTaskOptions.length > 0 && (
            <MultiSelect
              options={projectTaskOptions}
              value={manualTaskIds}
              onChange={setManualTaskIds}
              placeholder="Link tasks (optional)"
              searchable={projectTaskOptions.length > 4}
            />
          )}
          <Button type="submit" className="w-full h-10" icon={<Plus size={16} aria-hidden="true" />}>
            Add entry
          </Button>
        </form>
      )}
    </RailCard>
  );

  // Teammates' live timers: read-only, in both modes.
  const teammatesCard = teammateTimers.length > 0 && (
    <RailCard title="Also tracking" icon={<Users size={16} className="text-zinc-400" aria-hidden="true" />}>
      <ul className="space-y-2">
        {teammateTimers.map((entry) => {
          const member = getMember(entry.member_id);
          const paused = isPaused(entry);
          return (
            <li key={entry.id} className="flex items-center gap-2.5">
              <div className="flex-shrink-0 relative">
                <Avatar name={member?.name || '?'} src={member?.avatar} size="sm" />
                <span
                  className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-surface-raised ${paused ? '' : 'motion-safe:animate-pulse'}`}
                  style={{ backgroundColor: paused ? 'var(--color-zinc-400)' : projectColor }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">
                  {member?.name || 'Unknown'}
                  {paused && <span className="ml-1 text-xs font-normal text-zinc-500">· Paused</span>}
                </p>
                <p className="text-xs text-zinc-500 truncate">
                  {entry.description || <span className="italic text-zinc-600">No description</span>}
                </p>
              </div>
              <span
                className="text-sm font-semibold font-mono tabular-nums flex-shrink-0"
                style={{ color: paused ? 'var(--color-zinc-400)' : projectColor }}
              >
                {formatElapsed(Math.floor(getWorkedMs(entry) / 1000))}
              </span>
            </li>
          );
        })}
      </ul>
    </RailCard>
  );

  const renderEntry = (entry: TimeEntry) => {
    const member = getMember(entry.member_id);
    const canModifyEntry =
      canManageAllTime ||
      (canManageOwnTime && entry.member_id === teamMemberId && entry.approval_status !== 'approved');
    const isEditing = canModifyEntry && editingId === entry.id;
    const hours = getWorkedHours(entry);
    const hasMultipleSegments = entry.segments && entry.segments.length > 1;

    if (isEditing && editState) {
      return (
        <div key={entry.id} className="px-5 py-4 bg-white/[0.03] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 sm:items-center">
            <DateInput value={editState.date} onChange={(v) => setEditState({ ...editState, date: v })} />
            <div className="grid grid-cols-2 gap-2 items-center sm:contents">
              <TimeInput
                value={editState.startTime}
                onChange={(v) => setEditState({ ...editState, startTime: v })}
                placeholder="Start"
              />
              <span className="hidden sm:inline text-xs text-zinc-500 font-medium select-none">to</span>
              <TimeInput
                value={editState.endTime}
                onChange={(v) => setEditState({ ...editState, endTime: v })}
                placeholder="End"
              />
            </div>
          </div>
          <TextInput
            value={editState.description}
            onChange={(v) => setEditState({ ...editState, description: v })}
            placeholder="Description"
          />
          <div className={`grid grid-cols-1 gap-2 ${canManageAllTime ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'}`}>
            {/* Options include the entry's linked tasks even when done, or the
                picker would silently drop them on save. */}
            {(projectTaskOptions.length > 0 || editState.taskIds.length > 0) ? (
              <MultiSelect
                options={[
                  ...projectTaskOptions,
                  ...editState.taskIds
                    .filter((id) => !projectTaskOptions.some((o) => o.value === id))
                    .map((id) => ({ value: id, label: getTaskTitle(id) || 'Removed task' })),
                ]}
                value={editState.taskIds}
                onChange={(v) => setEditState({ ...editState, taskIds: v })}
                placeholder="Link tasks (optional)"
                searchable={projectTaskOptions.length > 4}
              />
            ) : <div className="hidden lg:block" />}
            {canManageAllTime && (
              <Select
                value={editState.memberId}
                onChange={(v) => setEditState({ ...editState, memberId: v })}
                options={memberSelectOptions}
                placeholder="Team member"
              />
            )}
            <Select
              value={editState.workType}
              onChange={(v) => setEditState({ ...editState, workType: v as 'client' | 'internal' })}
              options={workTypeOptions}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={saveEdit}>
              Save
            </Button>
          </div>
        </div>
      );
    }

    const breakdown = canSeeClientBilling ? paymentBreakdownMap.get(entry.id) : undefined;
    const payment = breakdown
      ? breakdown.status === 'paid'
        ? { color: 'text-emerald-400', label: 'Paid' }
        : breakdown.status === 'partial'
          ? { color: 'text-amber-400', label: 'Partly paid' }
          : { color: 'text-zinc-500', label: 'Unpaid' }
      : null;
    const paymentAmounts = breakdown
      ? [
          breakdown.paidAmount > 0 ? `$${formatRate(breakdown.paidAmount)} paid` : null,
          breakdown.unpaidAmount > 0 ? `$${formatRate(breakdown.unpaidAmount)} unpaid` : null,
        ].filter((part): part is string => Boolean(part)).join(' · ')
      : '';
    // Descriptions here run long (a day's work joined with +): two lines by
    // default, the rest one click away.
    const longDescription = (entry.description || '').length > 160;
    const descriptionOpen = openDescriptions.has(entry.id);
    const linkedTasks = (entry.task_ids || [])
      .map((linkedTaskId) => ({ id: linkedTaskId, title: getTaskTitle(linkedTaskId) }))
      .filter((linked): linked is { id: string; title: string } => !!linked.title);

    return (
      <div key={entry.id} className="group/entry px-5 py-3.5 flex gap-3 hover:bg-white/[0.02] transition-colors">
        <div className="flex-shrink-0 mt-0.5">
          <Avatar name={member?.name || '?'} src={member?.avatar} size="sm" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="@4xl:grid @4xl:grid-cols-[minmax(0,1fr)_190px_84px_120px_84px] @4xl:gap-4 @4xl:items-start">
            {/* Session: what was done, its badges and every linked task */}
            <div className="min-w-0">
              <p className={`text-sm text-zinc-200 break-words ${longDescription && !descriptionOpen ? 'line-clamp-2' : ''}`}>
                {entry.description || <span className="text-zinc-500 italic">No description</span>}
                {entry.work_type === 'internal' && (
                  <span className="ml-2 align-middle rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                    Internal
                  </span>
                )}
                {entry.approval_status && entry.approval_status !== 'approved' && (
                  <span
                    className={`ml-2 align-middle rounded px-1.5 py-0.5 text-[10px] font-medium ${entry.approval_status === 'rejected' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}
                  >
                    {entry.approval_status === 'pending' ? 'Awaiting approval' : entry.approval_status}
                  </span>
                )}
              </p>
              {longDescription && (
                <button
                  type="button"
                  onClick={() => toggleDescription(entry.id)}
                  aria-expanded={descriptionOpen}
                  className="mt-0.5 text-xs text-zinc-500 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {descriptionOpen ? 'Show less' : 'Show more'}
                </button>
              )}
              {linkedTasks.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {linkedTasks.map((linked) => (
                    <span
                      key={linked.id}
                      className="inline-flex max-w-[260px] items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[11px] font-medium text-zinc-400"
                    >
                      <span className="h-1 w-1 flex-shrink-0 rounded-full" style={{ backgroundColor: projectColor }} aria-hidden="true" />
                      <span className="truncate">{linked.title}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* The rest: one wrapping meta line on phones, columns on desktop */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 @4xl:contents">
              <p className="text-xs text-zinc-500 @4xl:mt-0.5 min-w-0 truncate">
                <span className="text-zinc-400">{member?.name}</span>
                <span className="mx-1">·</span>
                {formatTime(entry.start_time, tz)} – {entry.end_time ? formatTime(entry.end_time, tz) : '...'}
              </p>
              <div className="@4xl:text-right">
                <span
                  className="inline-block text-xs font-semibold tabular-nums px-1.5 py-0.5 rounded-md"
                  style={{ color: projectColor, backgroundColor: projectColor + '14' }}
                >
                  {formatHM(hours)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs @4xl:mt-0.5 min-w-0">
                {canSeeClientBilling && isHourly && (
                  <span className="tabular-nums text-zinc-500">${formatRate(entry.hourly_rate ?? hourlyRate)}/hr</span>
                )}
                {payment && (
                  <Tooltip content={paymentAmounts || payment.label}>
                    <span className={`inline-flex items-center gap-1 ${payment.color}`}>
                      <CircleDollarSign size={12} aria-hidden="true" />
                      {payment.label}
                    </span>
                  </Tooltip>
                )}
              </div>
              {canModifyEntry ? (
                <div className="flex items-center justify-end gap-0.5 ml-auto @4xl:ml-0 @4xl:opacity-0 @4xl:group-hover/entry:opacity-100 @4xl:focus-within:opacity-100 @4xl:group-has-[.seg-zone:hover]/entry:!opacity-0 transition-opacity">
                  {entry.id === resumableEntryId && (
                    <Tooltip content="Resume this session">
                      <button
                        aria-label="Resume this session"
                        onClick={() => handleResumeStopped(entry.id)}
                        className="p-1.5 rounded-md text-zinc-500 hover:text-emerald-400 hover:bg-white/[0.06] transition-colors"
                      >
                        <Play size={13} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip content="Edit">
                    <button
                      aria-label="Edit entry"
                      onClick={() => startEdit(entry)}
                      className="p-1.5 rounded-md text-zinc-500 hover:text-brand-300 hover:bg-white/[0.06] transition-colors"
                    >
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <button
                      aria-label="Delete entry"
                      onClick={() => setDeleteTarget(entry.id)}
                      className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-white/[0.06] transition-colors"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              ) : <span className="hidden @4xl:block" />}
            </div>
          </div>
          {hasMultipleSegments && renderSegmentList(entry, canModifyEntry, 'mt-2.5 w-fit min-w-[240px] max-w-full')}
        </div>
      </div>
    );
  };

  return (
    <>
      {completedEntries.length > 0 && (
        <TabToolbar
          search={{ value: sessionQuery, onChange: setSessionQuery, placeholder: 'Search sessions' }}
          filters={
            <SubNav
              label="Sessions from"
              active={sessionRange}
              onChange={setSessionRange}
              items={[
                { key: 'all', label: 'All time' },
                { key: 'week', label: 'This week' },
                { key: 'month', label: 'This month' },
              ]}
            />
          }
        />
      )}

      {completedEntries.length > 0 && (
        <KpiRow className={`mb-6 ${unpaidTimeTotal !== null ? '' : 'lg:grid-cols-3'}`}>
          <KpiTile
            label="This week"
            value={`${thisWeekHours.toFixed(1)}h`}
            icon={CalendarDays}
            context="Monday to today"
            spark={lastSevenDays}
          />
          <KpiTile
            label="All time"
            value={`${totalHours.toFixed(1)}h`}
            icon={Clock}
            context={`${completedEntries.length} ${completedEntries.length === 1 ? 'session' : 'sessions'}`}
          />
          <KpiTile
            label="Contributors"
            value={uniqueMembers.length}
            icon={Users}
            context={
              <AvatarGroup
                users={uniqueMembers.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar }))}
                max={6}
                size="xs"
              />
            }
          />
          {unpaidTimeTotal !== null && (
            <KpiTile
              label="Unpaid time"
              value={`$${formatRate(Math.round(unpaidTimeTotal))}`}
              icon={CircleDollarSign}
              tone={unpaidTimeTotal > 0 ? 'warning' : 'default'}
              context="Billable hours not yet paid"
            />
          )}
        </KpiRow>
      )}

      <RailLayout stickyRail railFirstOnMobile rail={<>{trackCard}{teammatesCard}</>}>

        {dateGroups.length > 0 && visibleDateGroups.length === 0 ? (
          <div className="glass-card rounded-xl"><NoMatches>No sessions match.</NoMatches></div>
        ) : dateGroups.length > 0 ? (
          <section className="@container glass-card rounded-xl overflow-hidden" aria-label="Sessions">
            <div className="hidden @4xl:grid grid-cols-[minmax(0,1fr)_190px_84px_120px_84px] gap-4 pl-[60px] pr-5 py-2.5 border-b border-white/[0.06] text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              <span>Session</span>
              <span>Who and when</span>
              <span className="text-right">Duration</span>
              <span>Billing</span>
              <span className="sr-only">Actions</span>
            </div>
            {visibleDateGroups.map(([date, dateEntries]) => {
              const dayTotal = dateEntries.reduce((sum, e) => sum + getWorkedHours(e), 0);
              return (
                <div key={date} className="border-b border-white/[0.06] last:border-0">
                  <div className="flex items-center justify-between px-5 py-2 bg-white/[0.025]">
                    <GroupLabel as="h3" className="">{formatDateHeader(date)}</GroupLabel>
                    <span className="text-xs font-mono tabular-nums text-zinc-400">{formatHM(dayTotal)}</span>
                  </div>
                  <div className="divide-y divide-white/[0.05]">{dateEntries.map(renderEntry)}</div>
                </div>
              );
            })}
          </section>
        ) : (
          <EmptyCard
            icon={<Clock />}
            title="No sessions yet"
            description={effectiveMode === 'timer'
              ? 'Start the timer and your sessions will list here, day by day.'
              : 'Log an entry and your sessions will list here, day by day.'}
          />
        )}
      </RailLayout>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Move time entry to Trash?"
        message="The time entry goes to Trash."
        variant="danger"
        trash
      />

      <ConfirmDialog
        isOpen={!!deleteSegmentTarget}
        onClose={() => setDeleteSegmentTarget(null)}
        onConfirm={executeDeleteSegment}
        title="Delete Segment"
        message="Remove this worked interval from the entry? The entry's total time will shrink by the segment's duration."
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
