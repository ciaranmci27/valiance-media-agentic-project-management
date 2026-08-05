'use client';

import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
import { Clock, Plus, Trash2, Pencil, X, Check, Play, Pause, Square, Timer, CircleDollarSign } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { TimeEntry } from '@/lib/types';
import { siteConfig } from '@/site-config';
import { toLocalTimeString, toLocalDateString } from '@/lib/date-utils';
import { getWorkedHours, getWorkedMs, isPaused } from '@/lib/time-entry-utils';
import { paidHourlyLineItemTotal, fifoPaymentBreakdowns, type PaymentBreakdown } from '@/lib/invoice-utils';
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

function formatTime(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) });
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function getDateKey(iso: string, timezone?: string): string {
  return new Date(iso).toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : undefined);
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
    getTimeEntriesByProject, team, tasks, getProject, getInvoicesByProject,
    addTimeEntry, updateTimeEntry, deleteTimeEntry,
    startTimer, pauseTimer, resumeTimer, stopTimer, getRunningTimer,
  } = useApp();
  const { teamMemberId, access } = useAuth();

  const tz = team.find(m => m.id === teamMemberId)?.timezone;
  const entries = getTimeEntriesByProject(projectId);
  const project = getProject(projectId);
  const projectMembers = team.filter(m => project?.member_ids?.includes(m.id));
  const canManageAllTime = hasPermission(access, 'time.manage_all');
  const canManageOwnTime = hasPermission(access, 'time.manage_own');
  const canSeeClientBilling = hasPermission(access, 'billing.manage') || hasPermission(access, 'invoices.read');
  const currentMember = team.find((member) => member.id === teamMemberId);
  const availableMembers = projectMembers.length > 0
    ? [...projectMembers, ...(currentMember && !projectMembers.some((member) => member.id === currentMember.id) ? [currentMember] : [])]
    : team;
  const memberOptions = canManageAllTime ? availableMembers : availableMembers.filter((member) => member.id === teamMemberId);
  // Current user's own running timer (may be null even when teammates are tracking).
  const runningTimer = getRunningTimer(projectId, teamMemberId || undefined);
  // Other members' running timers on this same project — rendered as read-only cards.
  // Guard on teamMemberId so an unauthenticated render doesn't misclassify the
  // user's own entry as a "teammate" one.
  const teammateTimers = useMemo(
    () => (teamMemberId
      ? entries.filter(e => e.end_time === null && e.member_id !== teamMemberId)
      : []),
    [entries, teamMemberId],
  );

  // ── Per-entry payment status (FIFO waterfall against paid hourly invoices) ──
  const invoices = getInvoicesByProject(projectId);
  const hourlyRate = project?.hourly_rate ?? 0;
  const isHourly = project?.client_time_billing
    ? project.client_time_billing === 'hourly'
    : project?.hourly_tracking ?? false;

  const paymentBreakdownMap = useMemo<Map<string, PaymentBreakdown>>(() => {
    if (!isHourly) return new Map();
    const finalized = entries
      .filter(e => e.end_time !== null
        && e.work_type !== 'internal'
        && (e.approval_status === undefined || e.approval_status === 'approved'))
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
      .map(e => ({ id: e.id, hours: getWorkedHours(e), hourly_rate: e.hourly_rate }));
    return fifoPaymentBreakdowns(finalized, paidHourlyLineItemTotal(invoices), hourlyRate);
  }, [isHourly, hourlyRate, invoices, entries]);

  // ── Mode selection (persisted per project, defaults to timer) ──
  const [mode, setMode] = useState<TrackingMode>(() => {
    if (typeof window === 'undefined') return 'timer';
    const stored = localStorage.getItem(getStorageKey(projectId));
    if (stored === 'timer' || stored === 'manual') return stored;
    return 'timer';
  });

  // If there's a running timer, force into timer mode and sync description
  useEffect(() => {
    if (runningTimer) {
      if (mode !== 'timer') {
        setMode('timer');
        localStorage.setItem(getStorageKey(projectId), 'timer');
      }
      setTimerDescription(runningTimer.description || '');
    }
  }, [runningTimer?.id]);

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
    return all.some(e => {
      const last = e.segments[e.segments.length - 1];
      return last && last.end === null;
    });
  }, [runningTimer, teammateTimers]);

  useEffect(() => {
    if (!hasAnyActiveSegment) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
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
    date: string; startTime: string; endTime: string; description: string; memberId: string;
    workType: 'client' | 'internal';
  } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── Segment edit/delete state ──
  const [editingSegment, setEditingSegment] = useState<{
    entryId: string; index: number; startTime: string; endTime: string;
  } | null>(null);
  const [deleteSegmentTarget, setDeleteSegmentTarget] = useState<{
    entryId: string; index: number;
  } | null>(null);

  // ── Computed ──
  const completedEntries = useMemo(() => entries.filter(e => e.end_time !== null), [entries]);

  const totalHours = useMemo(
    () => completedEntries.reduce((sum, e) => sum + getWorkedHours(e), 0),
    [completedEntries],
  );

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
      .filter(e => { const d = new Date(e.start_time); return d >= monday && d <= sunday; })
      .reduce((sum, e) => sum + getWorkedHours(e), 0);
  }, [completedEntries]);

  const uniqueMembers = useMemo(() => {
    const ids = new Set(entries.map(e => e.member_id));
    return Array.from(ids).map(id => team.find(m => m.id === id)).filter(Boolean) as typeof team;
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
  }, [completedEntries]);

  const getMember = (id: string) => team.find(m => m.id === id);
  const getTaskTitle = (id: string | null | undefined) => (id ? tasks.find(t => t.id === id)?.title : undefined);
  const projectTaskOptions = useMemo(
    () => tasks
      .filter(t => t.project_id === projectId && t.status !== 'done')
      .map(t => ({ value: t.id, label: t.title })),
    [tasks, projectId],
  );

  // ── Handlers ──

  const handleStartTimer = () => {
    const memberId = timerMemberId || teamMemberId;
    if (!memberId) { toast('error', 'Please select a team member'); return; }
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
    const newSegments = runningTimer.segments.length > 0
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
    if (timerDescription) {
      updateTimeEntry(runningTimer.id, { description: timerDescription });
    }
    pauseTimer(runningTimer.id);
  };

  const handleResumeTimer = () => {
    if (!runningTimer) return;
    resumeTimer(runningTimer.id);
  };

  const handleStopTimer = () => {
    if (!runningTimer) return;
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }
    if (timerDescription) {
      updateTimeEntry(runningTimer.id, { description: timerDescription });
    }
    stopTimer(runningTimer.id);
    setTimerDescription('');
    toast('success', 'Timer stopped');
  };

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualMemberId) { toast('error', 'Please select a team member'); return; }
    if (!manualStartTime) { toast('error', 'Please select a start time'); return; }

    const start = new Date(`${manualDate}T${manualStartTime}`);
    let end: Date;

    if (manualEntryMode === 'duration') {
      const hrs = typeof manualDurationHours === 'number' ? manualDurationHours : 0;
      const mins = typeof manualDurationMinutes === 'number' ? manualDurationMinutes : 0;
      if (hrs === 0 && mins === 0) {
        toast('error', 'Please enter a duration'); return;
      }
      end = new Date(start.getTime() + (hrs * 3_600_000) + (mins * 60_000));
    } else {
      if (!manualEndTime) { toast('error', 'Please select an end time'); return; }
      end = new Date(`${manualDate}T${manualEndTime}`);
      if (end < start) {
        end.setDate(end.getDate() + 1);
      } else if (end.getTime() === start.getTime()) {
        toast('error', 'End time must be after start time'); return;
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
    setEditState({
      date: getDateKey(entry.start_time, tz),
      startTime: toLocalTimeString(entry.start_time, tz),
      endTime: toLocalTimeString(entry.end_time || new Date().toISOString(), tz),
      description: entry.description,
      memberId: entry.member_id,
      workType: entry.work_type || 'client',
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditState(null); };

  // ── Segment handlers ──
  const startEditSegment = (entry: TimeEntry, index: number) => {
    const seg = entry.segments[index];
    if (!seg || seg.end === null) return; // can't edit an open (running) segment
    setEditingId(null);
    setEditState(null);
    setEditingSegment({
      entryId: entry.id,
      index,
      startTime: toLocalTimeString(seg.start, tz),
      endTime: toLocalTimeString(seg.end, tz),
    });
  };

  const cancelEditSegment = () => setEditingSegment(null);

  const saveEditSegment = () => {
    if (!editingSegment) return;
    const entry = entries.find(e => e.id === editingSegment.entryId);
    if (!entry) return;
    const origSeg = entry.segments[editingSegment.index];
    if (!origSeg) return;

    // Reuse the segment's own calendar date — segments don't span days under
    // the auto-finalize rules, so editing only rewrites the HH:MM on the same day.
    const dateKey = getDateKey(origSeg.start, tz);
    const newStart = new Date(`${dateKey}T${editingSegment.startTime}`);
    const newEnd = new Date(`${dateKey}T${editingSegment.endTime}`);
    if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime())) {
      toast('error', 'Invalid time'); return;
    }
    if (newEnd <= newStart) {
      toast('error', 'End time must be after start time'); return;
    }

    // Build the updated segments array and validate ordering against neighbors.
    const newSeg = { start: newStart.toISOString(), end: newEnd.toISOString() };
    const newSegments = entry.segments.map((s, i) => (i === editingSegment.index ? newSeg : s));
    const before = newSegments[editingSegment.index - 1];
    const after = newSegments[editingSegment.index + 1];
    if (before && before.end && new Date(before.end).getTime() > newStart.getTime()) {
      toast('error', 'Segment cannot overlap the previous one'); return;
    }
    if (after && new Date(after.start).getTime() < newEnd.getTime()) {
      toast('error', 'Segment cannot overlap the next one'); return;
    }

    // Keep denormalized start_time / end_time mirrored on the first/last segment.
    const firstStart = newSegments[0].start;
    const lastEnd = newSegments[newSegments.length - 1].end;
    updateTimeEntry(entry.id, {
      segments: newSegments,
      start_time: firstStart,
      ...(lastEnd ? { end_time: lastEnd } : {}),
    });
    setEditingSegment(null);
    toast('success', 'Segment updated');
  };

  const executeDeleteSegment = () => {
    if (!deleteSegmentTarget) return;
    const entry = entries.find(e => e.id === deleteSegmentTarget.entryId);
    if (!entry) { setDeleteSegmentTarget(null); return; }
    if (entry.segments.length <= 1) {
      toast('error', 'Cannot delete the only segment — delete the entry instead');
      setDeleteSegmentTarget(null);
      return;
    }
    const newSegments = entry.segments.filter((_, i) => i !== deleteSegmentTarget.index);
    const firstStart = newSegments[0].start;
    const lastEnd = newSegments[newSegments.length - 1].end;
    updateTimeEntry(entry.id, {
      segments: newSegments,
      start_time: firstStart,
      ...(lastEnd ? { end_time: lastEnd } : {}),
    });
    setDeleteSegmentTarget(null);
    toast('success', 'Segment removed');
  };

  const saveEdit = () => {
    if (!editingId || !editState) return;
    const original = entries.find(e => e.id === editingId);
    if (!original) return;

    // Detect time-field changes by comparing the editState values against
    // what they were seeded with in startEdit. Comparing raw ISO strings
    // doesn't work: Supabase returns `+00:00` while `toISOString()` returns
    // `.000Z` for the same instant, so a string `!==` would always flag
    // "changed" and nuke the segments on every save.
    const originalDate = getDateKey(original.start_time, tz);
    const originalStartTime = toLocalTimeString(original.start_time, tz);
    const originalEndTime = toLocalTimeString(
      original.end_time || new Date().toISOString(),
      tz,
    );
    const timeFieldsChanged =
      editState.date !== originalDate ||
      editState.startTime !== originalStartTime ||
      editState.endTime !== originalEndTime;

    const patch: Partial<Pick<TimeEntry, 'member_id' | 'start_time' | 'end_time' | 'segments' | 'description' | 'work_type'>> = {
      description: editState.description,
      member_id: editState.memberId,
      work_type: editState.workType,
    };

    if (timeFieldsChanged) {
      const start = new Date(`${editState.date}T${editState.startTime}`);
      const end = new Date(`${editState.date}T${editState.endTime}`);
      if (end < start) {
        end.setDate(end.getDate() + 1);
      } else if (end.getTime() === start.getTime()) {
        toast('error', 'End time must be after start time'); return;
      }
      // Manual start/end overrides make the existing pause history unreliable,
      // so collapse to a single clean segment spanning the new bounds.
      patch.start_time = start.toISOString();
      patch.end_time = end.toISOString();
      patch.segments = [{ start: start.toISOString(), end: end.toISOString() }];
    }

    updateTimeEntry(editingId, patch);
    toast('success', 'Time entry updated');
    cancelEdit();
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    const entry = entries.find(item => item.id === deleteTarget);
    const canModifyEntry = Boolean(
      entry && (
        canManageAllTime
        || (canManageOwnTime && entry.member_id === teamMemberId && entry.approval_status !== 'approved')
      ),
    );
    if (!canModifyEntry) {
      setDeleteTarget(null);
      return;
    }
    const deleted = await deleteTimeEntry(deleteTarget);
    if (deleted) toast('success', 'Time entry removed');
  };

  const dateGroups = Object.entries(groupedByDate);

  /* ================================================================
     RENDER
  ================================================================ */
  return (
    <div className="glass-card rounded-xl flex flex-col max-h-[600px]">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-white/[0.08] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Clock size={18} className="text-zinc-400 flex-shrink-0" />
          <h2 className="font-semibold text-white truncate">Time Tracking</h2>
        </div>
        <div className="seg-track seg-sm">
          <button
            onClick={() => { if (mode !== 'timer') toggleMode(); }}
            className={`seg-item flex items-center gap-1.5 ${mode === 'timer' ? 'is-active' : ''}`}
          >
            <Timer size={12} />
            Timer
          </button>
          <button
            onClick={() => { if (mode !== 'manual') toggleMode(); }}
            className={`seg-item flex items-center gap-1.5 ${mode === 'manual' ? 'is-active' : ''}`}
          >
            <Clock size={12} />
            Manual
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ═══════════════════════════════════════════════════════
             STATS ROW
           ═══════════════════════════════════════════════════════ */}
        {completedEntries.length > 0 && (
          <div className="px-5 pt-4 pb-2 flex items-end gap-6">
            <div>
              <p className="text-xs text-zinc-400 font-medium mb-0.5">Total Hours</p>
              <p className="text-2xl font-bold tabular-nums leading-none text-white">
                {totalHours.toFixed(1)}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-400 font-medium mb-0.5">This Week</p>
              <p className="text-2xl font-bold tabular-nums leading-none text-white">
                {thisWeekHours.toFixed(1)}
              </p>
            </div>
            {uniqueMembers.length > 0 && (
              <div>
                <p className="text-xs text-zinc-400 font-medium mb-1.5">Contributors</p>
                <AvatarGroup
                  users={uniqueMembers.map(m => ({ id: m.id, name: m.name, avatar: m.avatar }))}
                  max={3}
                  size="xs"
                />
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
             LIVE TIMER MODE
           ═══════════════════════════════════════════════════════ */}
        {mode === 'timer' && (
          <div className="mx-4 mt-3 mb-2">
            {runningTimer ? (
              <div
                className="rounded-xl border p-4 space-y-3"
                style={{
                  borderColor: runningTimerIsPaused ? 'var(--color-surface-border)' : projectColor + '30',
                  backgroundColor: runningTimerIsPaused ? 'rgba(var(--ink), 0.04)' : projectColor + '06',
                }}
              >
                {/* Top row: avatar, info, elapsed badge */}
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 relative">
                    <Avatar name={getMember(runningTimer.member_id)?.name || '?'} src={getMember(runningTimer.member_id)?.avatar} size="md" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-surface-raised ${runningTimerIsPaused ? '' : 'animate-pulse'}`}
                      style={{ backgroundColor: runningTimerIsPaused ? 'var(--color-zinc-400)' : projectColor }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-100 truncate">
                      {getMember(runningTimer.member_id)?.name}
                      {runningTimerIsPaused && (
                        <span className="ml-1.5 text-xs font-normal text-zinc-500">· Paused</span>
                      )}
                    </p>
                    {adjustingStart ? (
                      <div className="flex items-center gap-1.5 mt-1">
                        <div className="w-[120px]">
                          <TimeInput
                            size="sm"
                            value={adjustStartTime}
                            onChange={setAdjustStartTime}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleAdjustStart}
                          className="p-1 text-emerald-400 hover:bg-emerald-500/15 rounded transition-colors flex-shrink-0"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setAdjustingStart(false); setAdjustStartTime(''); }}
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
                  <span
                    className="text-lg font-bold tabular-nums tracking-tight flex-shrink-0"
                    style={{ color: runningTimerIsPaused ? 'var(--color-zinc-400)' : projectColor }}
                  >
                    {formatElapsed(Math.floor(getWorkedMs(runningTimer) / 1000))}
                  </span>
                </div>

                {/* Description + pause/resume + stop */}
                <div className="space-y-2 sm:space-y-0 sm:flex sm:gap-2">
                  <div className="flex-1">
                    <TextInput
                      value={timerDescription}
                      onChange={val => {
                        setTimerDescription(val);
                        if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
                        descDebounceRef.current = setTimeout(() => {
                          updateTimeEntry(runningTimer.id, { description: val });
                        }, 500);
                      }}
                      placeholder="What are you working on?"
                    />
                  </div>
                  <div className="flex gap-2">
                    {runningTimerIsPaused ? (
                      <button
                        onClick={handleResumeTimer}
                        className="flex-1 sm:flex-none px-3 py-2 rounded-lg text-white font-medium text-sm transition-all flex items-center justify-center gap-1.5 flex-shrink-0 bg-brand-600 hover:bg-brand-700 active:scale-[0.97]"
                      >
                        <Play size={12} />
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={handlePauseTimer}
                        className="flex-1 sm:flex-none px-3 py-2 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-1.5 flex-shrink-0 bg-white/[0.06] text-zinc-300 hover:bg-white/[0.08] active:scale-[0.97]"
                      >
                        <Pause size={12} />
                        Pause
                      </button>
                    )}
                    <button
                      onClick={handleStopTimer}
                      className="flex-1 sm:flex-none px-3 py-2 rounded-lg text-white font-medium text-sm transition-all flex items-center justify-center gap-1.5 flex-shrink-0 bg-red-500 hover:bg-red-600 active:scale-[0.97]"
                    >
                      <Square size={12} />
                      Stop
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
                <div className={`grid grid-cols-1 gap-2 ${canManageAllTime ? 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' : 'sm:grid-cols-[minmax(0,1fr)_auto]'}`}>
                  {canManageAllTime && (
                    <div className="min-w-0">
                      <Select
                        value={timerMemberId || teamMemberId || ''}
                        onChange={setTimerMemberId}
                        options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                        placeholder="Select member"
                      />
                    </div>
                  )}
                  <Select
                    value={timerWorkType}
                    onChange={(value) => setTimerWorkType(value as 'client' | 'internal')}
                    options={[{ value: 'client', label: 'Client work' }, { value: 'internal', label: 'Internal work' }]}
                  />
                  <button
                    onClick={handleStartTimer}
                    className="h-[38px] justify-center rounded-lg bg-brand-600 px-5 text-sm font-medium text-white transition-all flex items-center gap-2 hover:bg-brand-700 active:scale-[0.97]"
                  >
                    <Play size={14} />
                    Start
                  </button>
                </div>
                <TextInput
                  value={timerDescription}
                  onChange={setTimerDescription}
                  placeholder="What are you working on?"
                />
                {projectTaskOptions.length > 0 && (
                  <MultiSelect
                    options={projectTaskOptions}
                    value={timerTaskIds}
                    onChange={setTimerTaskIds}
                    placeholder="Link tasks (optional)"
                    searchable={projectTaskOptions.length > 4}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
             TEAMMATE LIVE TIMERS (display-only, both modes)
           ═══════════════════════════════════════════════════════ */}
        {teammateTimers.length > 0 && (
          <div className="mx-4 mt-1 mb-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide font-medium text-zinc-500 px-1">
              Also tracking
            </p>
            {teammateTimers.map(entry => {
              const member = getMember(entry.member_id);
              const paused = isPaused(entry);
              const elapsedSec = Math.floor(getWorkedMs(entry) / 1000);
              return (
                <div
                  key={entry.id}
                  className="rounded-lg border border-white/[0.06] bg-surface-raised px-3 py-2 flex items-center gap-2.5"
                >
                  <div className="flex-shrink-0 relative">
                    <Avatar name={member?.name || '?'} src={member?.avatar} size="sm" />
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-surface-raised ${paused ? '' : 'animate-pulse'}`}
                      style={{ backgroundColor: paused ? 'var(--color-zinc-400)' : projectColor }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-300 truncate">
                      {member?.name || 'Unknown'}
                      {paused && (
                        <span className="ml-1 text-[10px] font-normal text-zinc-500">· Paused</span>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {entry.description || <span className="italic text-zinc-600">No description</span>}
                    </p>
                  </div>
                  <span
                    className="text-xs font-semibold tabular-nums tracking-tight flex-shrink-0"
                    style={{ color: paused ? 'var(--color-zinc-400)' : projectColor }}
                  >
                    {formatElapsed(elapsedSec)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
             MANUAL ENTRY MODE
           ═══════════════════════════════════════════════════════ */}
        {mode === 'manual' && (
          <form onSubmit={handleManualAdd} className="mx-4 mt-3 mb-2 rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 space-y-3">
            {/* Date and, for time managers only, the team member */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <div className={canManageAllTime ? 'md:col-span-2' : 'md:col-span-4'}>
                <DateInput
                  value={manualDate}
                  onChange={setManualDate}
                  placeholder="Date"
                />
              </div>
              {canManageAllTime && (
                <div className="md:col-span-2">
                  <Select
                    value={manualMemberId}
                    onChange={setManualMemberId}
                    options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                    placeholder="Team member"
                  />
                </div>
              )}
            </div>

            {/* Time mode tabs + fields */}
            <div className="seg-track seg-sm mb-3">
              <button
                type="button"
                onClick={() => setManualEntryMode('range')}
                className={`seg-item ${manualEntryMode === 'range' ? 'is-active' : ''}`}
              >
                Time Range
              </button>
              <button
                type="button"
                onClick={() => setManualEntryMode('duration')}
                className={`seg-item ${manualEntryMode === 'duration' ? 'is-active' : ''}`}
              >
                Duration
              </button>
            </div>
            {manualEntryMode === 'duration' ? (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <div className="md:col-span-2">
                  <TimeInput
                    value={manualStartTime}
                    onChange={setManualStartTime}
                    placeholder="Start time"
                  />
                </div>
                <div className="grid grid-cols-2 md:contents gap-2">
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
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                <div className="md:col-span-2">
                  <TimeInput
                    value={manualStartTime}
                    onChange={setManualStartTime}
                    placeholder="Start time"
                  />
                </div>
                <div className="md:col-span-2">
                  <TimeInput
                    value={manualEndTime}
                    onChange={setManualEndTime}
                    placeholder="End time"
                  />
                </div>
              </div>
            )}

            {/* Description + submit */}
            <div className="flex gap-2">
              <div className="flex-1">
                <TextInput
                  value={manualDescription}
                  onChange={setManualDescription}
                  placeholder="What did you work on?"
                />
              </div>
              <button
                type="submit"
                className="w-[38px] h-[38px] rounded-lg text-white transition-all flex-shrink-0 flex items-center justify-center bg-brand-600 hover:bg-brand-700 active:scale-95"
              >
                <Plus size={18} strokeWidth={2.5} />
              </button>
            </div>
            <Select value={manualWorkType} onChange={(value) => setManualWorkType(value as 'client' | 'internal')} options={[{ value: 'client', label: 'Client work' }, { value: 'internal', label: 'Internal work' }]} />
            {projectTaskOptions.length > 0 && (
              <MultiSelect
                options={projectTaskOptions}
                value={manualTaskIds}
                onChange={setManualTaskIds}
                placeholder="Link tasks (optional)"
                searchable={projectTaskOptions.length > 4}
              />
            )}
          </form>
        )}

        {/* ═══════════════════════════════════════════════════════
             ENTRY LIST (shared between modes)
           ═══════════════════════════════════════════════════════ */}
        {dateGroups.length > 0 ? (
          <div className="p-5 pt-3 space-y-4">
            {dateGroups.map(([date, dateEntries]) => (
              <div key={date}>
                <p className="text-xs uppercase tracking-wide font-medium text-zinc-500 mb-2">
                  {formatDateHeader(date)}
                </p>
                <div className="divide-y divide-white/[0.06]">
                  {dateEntries.map(entry => {
                    const member = getMember(entry.member_id);
                    const canModifyEntry = canManageAllTime
                      || (canManageOwnTime && entry.member_id === teamMemberId && entry.approval_status !== 'approved');
                    const isEditing = canModifyEntry && editingId === entry.id;
                    const hours = getWorkedHours(entry);
                    const hasMultipleSegments = entry.segments && entry.segments.length > 1;

                    if (isEditing && editState) {
                      return (
                        <div key={entry.id} className="py-3 space-y-2 rounded-lg bg-white/[0.03] -mx-1 px-3 border border-white/[0.06]">
                          {/* Date + time range. On mobile: date full width, then start/end
                              inputs share a row (no "to" label since they're adjacent).
                              On sm+: everything on one row via sm:contents trick. */}
                          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_1fr] gap-2 sm:items-center pt-1">
                            <DateInput
                              value={editState.date}
                              onChange={v => setEditState({ ...editState, date: v })}
                            />
                            <div className="grid grid-cols-2 gap-2 items-center sm:contents">
                              <TimeInput
                                value={editState.startTime}
                                onChange={v => setEditState({ ...editState, startTime: v })}
                                placeholder="Start"
                              />
                              <span className="hidden sm:inline text-xs text-zinc-600 font-medium select-none">to</span>
                              <TimeInput
                                value={editState.endTime}
                                onChange={v => setEditState({ ...editState, endTime: v })}
                                placeholder="End"
                              />
                            </div>
                          </div>
                          <TextInput
                            value={editState.description}
                            onChange={v => setEditState({ ...editState, description: v })}
                            placeholder="Description"
                          />
                          <div className="flex flex-col gap-2 pb-1 sm:flex-row sm:items-center">
                            <div className={`grid min-w-0 flex-1 gap-2 ${canManageAllTime ? 'grid-cols-2' : 'grid-cols-1'}`}>
                              {canManageAllTime && (
                                <Select
                                  value={editState.memberId}
                                  onChange={v => setEditState({ ...editState, memberId: v })}
                                  options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                                  placeholder="Team member"
                                />
                              )}
                              <Select
                                value={editState.workType}
                                onChange={v => setEditState({ ...editState, workType: v as 'client' | 'internal' })}
                                options={[{ value: 'client', label: 'Client work' }, { value: 'internal', label: 'Internal work' }]}
                              />
                            </div>
                            <div className="flex items-center justify-end gap-0.5">
                              <button
                                aria-label="Save time entry changes"
                                onClick={saveEdit}
                                className="p-1.5 text-emerald-400 hover:bg-emerald-500/15 rounded-md transition-colors"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                aria-label="Cancel time entry changes"
                                onClick={cancelEdit}
                                className="p-1.5 text-zinc-500 hover:bg-white/[0.06] rounded-md transition-colors"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={entry.id} className="flex items-start gap-3 py-2 group/entry">
                        <div className="flex-shrink-0 mt-0.5">
                          <Avatar name={member?.name || '?'} src={member?.avatar} size="sm" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-300 truncate">
                            {entry.description || <span className="text-zinc-500 italic">No description</span>}
                          </p>
                          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                            <span className="truncate">
                              {member?.name} &middot; {formatTime(entry.start_time, tz)} – {entry.end_time ? formatTime(entry.end_time, tz) : '...'}
                            </span>
                            <span
                              className="font-semibold tabular-nums px-1.5 py-0.5 rounded-md flex-shrink-0"
                              style={{ color: projectColor, backgroundColor: projectColor + '14' }}
                            >
                              {formatHM(hours)}
                            </span>
                            {canSeeClientBilling && isHourly ? (
                              <span className="flex-shrink-0 tabular-nums text-zinc-500">
                                ${formatRate(entry.hourly_rate ?? hourlyRate)}/hr
                              </span>
                            ) : null}
                            {canSeeClientBilling && (() => {
                              const breakdown = paymentBreakdownMap.get(entry.id);
                              if (!breakdown) return null;
                              const cfg = breakdown.status === 'paid'
                                ? { color: 'text-emerald-500', label: 'Paid' }
                                : breakdown.status === 'partial'
                                ? { color: 'text-amber-500', label: 'Partially paid' }
                                : { color: 'text-zinc-600', label: 'Unpaid' };
                              const amountParts = [
                                breakdown.paidAmount > 0 ? `$${formatRate(breakdown.paidAmount)} paid` : null,
                                breakdown.unpaidAmount > 0 ? `$${formatRate(breakdown.unpaidAmount)} unpaid` : null,
                              ].filter((part): part is string => Boolean(part));
                              const amountLabel = amountParts.join(' · ');
                              return (
                                <Tooltip content={(
                                  <div className="space-y-0.5">
                                    <p>{cfg.label}</p>
                                    <p className="font-normal text-zinc-400 tabular-nums">
                                      {amountLabel}
                                    </p>
                                  </div>
                                )}>
                                  <CircleDollarSign
                                    size={11}
                                    className={`flex-shrink-0 ${cfg.color}`}
                                    aria-label={`${cfg.label}: ${amountParts.join(', ')}`}
                                  />
                                </Tooltip>
                              );
                            })()}
                            {(() => {
                              // Linked tasks live inline after the paid marker so
                              // every entry stays a two-line row; one truncating
                              // chip plus a +N tooltip carries any overflow.
                              const linkedTasks = (entry.task_ids || [])
                                .map(linkedTaskId => ({ id: linkedTaskId, title: getTaskTitle(linkedTaskId) }))
                                .filter((linked): linked is { id: string; title: string } => !!linked.title);
                              if (linkedTasks.length === 0) return null;
                              const [firstTask, ...restTasks] = linkedTasks;
                              return (
                                <span className="flex min-w-0 items-center gap-1">
                                  <Tooltip content={firstTask.title} className="min-w-0">
                                    <span className="inline-flex min-w-0 max-w-[200px] items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.04] px-1 py-0 text-[10px] font-medium text-zinc-400">
                                      <span className="h-1 w-1 flex-shrink-0 rounded-full" style={{ backgroundColor: projectColor }} aria-hidden="true" />
                                      <span className="truncate">{firstTask.title}</span>
                                    </span>
                                  </Tooltip>
                                  {restTasks.length > 0 && (
                                    <Tooltip
                                      content={(
                                        <div className="space-y-1 py-0.5">
                                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Also on</p>
                                          {restTasks.map(linked => (
                                            <p key={linked.id} className="flex items-center gap-1.5">
                                              <span className="h-1 w-1 flex-shrink-0 rounded-full" style={{ backgroundColor: projectColor }} aria-hidden="true" />
                                              <span className="max-w-[240px] truncate font-normal text-zinc-200">{linked.title}</span>
                                            </p>
                                          ))}
                                        </div>
                                      )}
                                    >
                                      <span className="inline-flex flex-shrink-0 items-center rounded-full border border-white/[0.06] bg-white/[0.04] px-1 py-0 text-[10px] font-medium text-zinc-400">
                                        +{restTasks.length}
                                      </span>
                                    </Tooltip>
                                  )}
                                </span>
                              );
                            })()}
                            {entry.work_type === 'internal' && <span className="flex-shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">Internal</span>}
                            {entry.approval_status && entry.approval_status !== 'approved' && <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${entry.approval_status === 'rejected' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>{entry.approval_status === 'pending' ? 'Awaiting approval' : entry.approval_status}</span>}
                            {canModifyEntry ? (
                              <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/entry:opacity-100 sm:group-has-[.seg-zone:hover]/entry:!opacity-0 transition-opacity flex-shrink-0">
                                <Tooltip content="Edit">
                                  <button
                                    onClick={() => startEdit(entry)}
                                    className="p-1 text-zinc-600 hover:text-brand-300 transition-colors"
                                  >
                                    <Pencil size={12} />
                                  </button>
                                </Tooltip>
                                <Tooltip content="Delete">
                                  <button
                                    onClick={() => setDeleteTarget(entry.id)}
                                    className="p-1 text-zinc-600 hover:text-red-500 transition-colors"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </Tooltip>
                              </div>
                            ) : null}
                          </div>
                          {hasMultipleSegments && (
                            <ul className="seg-zone mt-2 mb-1 rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-1.5 space-y-1">
                              {entry.segments.map((seg, i) => {
                                const isEditingThisSegment =
                                  editingSegment?.entryId === entry.id && editingSegment.index === i;
                                const segDurationHours = seg.end
                                  ? (new Date(seg.end).getTime() - new Date(seg.start).getTime()) / 3_600_000
                                  : 0;
                                // Gap to the next segment = pause duration. Only shown when
                                // this segment has an end (otherwise it's still running and
                                // there's no "pause" yet) and a next segment exists.
                                const nextSeg = entry.segments[i + 1];
                                const gapMs = seg.end && nextSeg
                                  ? new Date(nextSeg.start).getTime() - new Date(seg.end).getTime()
                                  : 0;
                                const showGap = gapMs > 0;
                                const gapLabel = showGap ? (
                                  <li
                                    key={`gap-${i}`}
                                    className="flex items-center gap-1.5 pl-[3px] select-none"
                                  >
                                    <span className="w-px h-2.5 bg-white/[0.08] ml-[2px]" />
                                    <span className="text-[10px] italic text-zinc-500">
                                      Paused for {formatGap(gapMs)}
                                    </span>
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
                                            onChange={v => setEditingSegment({ ...editingSegment, startTime: v })}
                                          />
                                        </div>
                                        <span className="text-[10px] text-zinc-600 select-none">–</span>
                                        <div className="w-[88px]">
                                          <TimeInput
                                            size="sm"
                                            value={editingSegment.endTime}
                                            onChange={v => setEditingSegment({ ...editingSegment, endTime: v })}
                                          />
                                        </div>
                                        <button
                                          onClick={saveEditSegment}
                                          className="p-1 text-emerald-400 hover:bg-emerald-500/15 rounded transition-colors flex-shrink-0"
                                        >
                                          <Check size={12} />
                                        </button>
                                        <button
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
                                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                        style={{ backgroundColor: projectColor }}
                                      />
                                      <span className="text-[11px] font-medium text-zinc-300 tabular-nums">
                                        {formatTime(seg.start, tz)} – {seg.end ? formatTime(seg.end, tz) : '...'}
                                      </span>
                                      {seg.end && (
                                        <span className="text-[10px] text-zinc-500 tabular-nums">
                                          {formatHM(segDurationHours)}
                                        </span>
                                      )}
                                      {canModifyEntry ? (
                                        <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/seg:opacity-100 transition-opacity">
                                          <Tooltip content="Edit segment">
                                            <button
                                              onClick={() => startEditSegment(entry, i)}
                                              className="p-1 text-zinc-500 hover:text-brand-300 hover:bg-surface-raised rounded transition-colors"
                                            >
                                              <Pencil size={11} />
                                            </button>
                                          </Tooltip>
                                          <Tooltip content="Delete segment">
                                            <button
                                              onClick={() => setDeleteSegmentTarget({ entryId: entry.id, index: i })}
                                              className="p-1 text-zinc-500 hover:text-red-500 hover:bg-surface-raised rounded transition-colors"
                                            >
                                              <Trash2 size={11} />
                                            </button>
                                          </Tooltip>
                                        </div>
                                      ) : null}
                                    </li>
                                    {gapLabel}
                                  </Fragment>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : !runningTimer && teammateTimers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <Clock size={18} className="text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-400">No hours logged yet</p>
            <p className="text-xs text-zinc-500 mt-1">
              {mode === 'timer' ? 'Start a timer to begin tracking' : 'Use the form above to log your first entry'}
            </p>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Time Entry"
        message="Are you sure you want to remove this time entry?"
        confirmLabel="Delete"
        variant="danger"
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
    </div>
  );
}
