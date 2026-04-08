'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Clock, Plus, Trash2, Pencil, X, Check, Play, Square, Timer } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { TimeInput } from '@/components/ui/inputs/TimeInput';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { TimeEntry } from '@/lib/types';
import { siteConfig } from '@/site-config';
import { toLocalTimeString, toLocalDateString } from '@/lib/date-utils';

/* ── Types ── */

type TrackingMode = 'timer' | 'manual';
type ManualEntryMode = 'range' | 'duration';

interface TimeTrackingPanelProps {
  projectId: string;
  projectColor?: string;
}

/* ── Helpers ── */

function computeHours(entry: TimeEntry): number {
  if (!entry.end_time) return 0;
  return (new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime()) / 3_600_000;
}

function formatHM(decimal: number): string {
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}h`;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
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
    getTimeEntriesByProject, team, getProject,
    addTimeEntry, updateTimeEntry, deleteTimeEntry,
    startTimer, stopTimer, getRunningTimer,
  } = useApp();
  const { teamMemberId } = useAuth();

  const tz = team.find(m => m.id === teamMemberId)?.timezone;
  const entries = getTimeEntriesByProject(projectId);
  const project = getProject(projectId);
  const projectMembers = team.filter(m => project?.member_ids?.includes(m.id));
  const memberOptions = projectMembers.length > 0 ? projectMembers : team;
  const runningTimer = getRunningTimer(projectId);

  // ── Mode selection (persisted per project, defaults to manual) ──
  const [mode, setMode] = useState<TrackingMode>(() => {
    if (typeof window === 'undefined') return 'manual';
    const stored = localStorage.getItem(getStorageKey(projectId));
    if (stored === 'timer' || stored === 'manual') return stored;
    return 'manual';
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

  // ── Live elapsed time for running timer ──
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (runningTimer) {
      const tick = () => {
        const diff = Math.floor((Date.now() - new Date(runningTimer.start_time).getTime()) / 1000);
        setElapsed(Math.max(0, diff));
      };
      tick();
      intervalRef.current = setInterval(tick, 1000);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    } else {
      setElapsed(0);
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }, [runningTimer?.id, runningTimer?.start_time]);

  // ── Timer form state ──
  const [timerMemberId, setTimerMemberId] = useState('');
  const [timerDescription, setTimerDescription] = useState('');
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

  // ── Edit state ──
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editState, setEditState] = useState<{
    date: string; startTime: string; endTime: string; description: string; memberId: string;
  } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── Computed ──
  const completedEntries = useMemo(() => entries.filter(e => e.end_time !== null), [entries]);

  const totalHours = useMemo(
    () => completedEntries.reduce((sum, e) => sum + computeHours(e), 0),
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
      .reduce((sum, e) => sum + computeHours(e), 0);
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

  // ── Handlers ──

  const handleStartTimer = () => {
    const memberId = timerMemberId || teamMemberId;
    if (!memberId) { toast('error', 'Please select a team member'); return; }
    startTimer(projectId, memberId, timerDescription);
    setTimerDescription('');
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
    updateTimeEntry(runningTimer.id, { start_time: adjusted.toISOString() });
    setAdjustingStart(false);
    setAdjustStartTime('');
    toast('success', 'Start time adjusted');
  };

  const handleStopTimer = () => {
    if (descDebounceRef.current) {
      clearTimeout(descDebounceRef.current);
      descDebounceRef.current = null;
    }
    if (runningTimer && timerDescription) {
      updateTimeEntry(runningTimer.id, { description: timerDescription });
    }
    stopTimer(projectId);
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
      description: manualDescription,
    });
    toast('success', 'Time entry added');
    setManualDescription('');
    setManualStartTime('');
    setManualEndTime('');
    setManualDurationHours('');
    setManualDurationMinutes('');
    setManualDate(toLocalDateString(tz));
  };

  const startEdit = (entry: TimeEntry) => {
    setEditingId(entry.id);
    setEditState({
      date: getDateKey(entry.start_time, tz),
      startTime: toLocalTimeString(entry.start_time, tz),
      endTime: toLocalTimeString(entry.end_time || new Date().toISOString(), tz),
      description: entry.description,
      memberId: entry.member_id,
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditState(null); };

  const saveEdit = () => {
    if (!editingId || !editState) return;
    const start = new Date(`${editState.date}T${editState.startTime}`);
    const end = new Date(`${editState.date}T${editState.endTime}`);
    if (end < start) {
      end.setDate(end.getDate() + 1);
    } else if (end.getTime() === start.getTime()) {
      toast('error', 'End time must be after start time'); return;
    }
    updateTimeEntry(editingId, {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      description: editState.description,
      member_id: editState.memberId,
    });
    toast('success', 'Time entry updated');
    cancelEdit();
  };

  const executeDelete = () => {
    if (deleteTarget) { deleteTimeEntry(deleteTarget); toast('success', 'Time entry removed'); }
  };

  const dateGroups = Object.entries(groupedByDate);

  /* ================================================================
     RENDER
  ================================================================ */
  return (
    <div className="bg-white rounded-xl border border-zinc-200 flex flex-col max-h-[600px]">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-zinc-200 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Clock size={18} className="text-zinc-500 flex-shrink-0" />
          <h2 className="font-semibold text-zinc-900 truncate">Time Tracking</h2>
        </div>
        <div className="flex items-center gap-0.5 bg-zinc-100 rounded-lg p-0.5">
          <button
            onClick={() => { if (mode !== 'manual') toggleMode(); }}
            className={`text-xs font-medium px-2.5 py-1 rounded-md transition-all duration-150 flex items-center gap-1.5 ${
              mode === 'manual'
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            <Clock size={12} />
            Manual
          </button>
          <button
            onClick={() => { if (mode !== 'timer') toggleMode(); }}
            className={`text-xs font-medium px-2.5 py-1 rounded-md transition-all duration-150 flex items-center gap-1.5 ${
              mode === 'timer'
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            <Timer size={12} />
            Timer
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
              <p className="text-xs text-zinc-500 font-medium mb-0.5">Total Hours</p>
              <p className="text-2xl font-bold tabular-nums leading-none" style={{ color: projectColor }}>
                {totalHours.toFixed(1)}
              </p>
            </div>
            <div>
              <p className="text-xs text-zinc-500 font-medium mb-0.5">This Week</p>
              <p className="text-2xl font-bold tabular-nums leading-none text-zinc-900">
                {thisWeekHours.toFixed(1)}
              </p>
            </div>
            {uniqueMembers.length > 0 && (
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-1.5">Contributors</p>
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
                style={{ borderColor: projectColor + '30', backgroundColor: projectColor + '06' }}
              >
                {/* Top row: avatar, info, elapsed badge */}
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 relative">
                    <Avatar name={getMember(runningTimer.member_id)?.name || '?'} src={getMember(runningTimer.member_id)?.avatar} size="md" />
                    <span
                      className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-white animate-pulse"
                      style={{ backgroundColor: projectColor }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-800 truncate">
                      {getMember(runningTimer.member_id)?.name}
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
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition-colors flex-shrink-0"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setAdjustingStart(false); setAdjustStartTime(''); }}
                          className="p-1 text-zinc-400 hover:bg-zinc-100 rounded transition-colors flex-shrink-0"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5">
                        Started {formatTime(runningTimer.start_time, tz)}
                        <button
                          type="button"
                          onClick={() => {
                            setAdjustingStart(true);
                            setAdjustStartTime(toLocalTimeString(runningTimer.start_time, tz));
                          }}
                          className="text-zinc-300 hover:text-zinc-500 transition-colors flex-shrink-0"
                        >
                          <Pencil size={11} />
                        </button>
                      </p>
                    )}
                  </div>
                  <span
                    className="text-lg font-bold tabular-nums tracking-tight flex-shrink-0"
                    style={{ color: projectColor }}
                  >
                    {formatElapsed(elapsed)}
                  </span>
                </div>

                {/* Description + stop */}
                <div className="flex gap-2">
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
                  <button
                    onClick={handleStopTimer}
                    className="px-4 py-2 rounded-lg text-white font-medium text-sm transition-all flex items-center gap-1.5 flex-shrink-0 bg-red-500 hover:bg-red-600 active:scale-[0.97]"
                  >
                    <Square size={12} />
                    Stop
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-zinc-50/80 border border-zinc-100 p-4 space-y-3">
                <div className="flex gap-2">
                  <div className="flex-1 min-w-[140px]">
                    <Select
                      value={timerMemberId || teamMemberId || ''}
                      onChange={setTimerMemberId}
                      options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                      placeholder="Select member"
                    />
                  </div>
                  <button
                    onClick={handleStartTimer}
                    className="px-5 h-[38px] rounded-lg text-white font-medium text-sm transition-all flex items-center gap-2 flex-shrink-0 bg-brand-600 hover:bg-brand-700 active:scale-[0.97]"
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
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
             MANUAL ENTRY MODE
           ═══════════════════════════════════════════════════════ */}
        {mode === 'manual' && (
          <form onSubmit={handleManualAdd} className="mx-4 mt-3 mb-2 rounded-xl bg-zinc-50/80 border border-zinc-100 p-4 space-y-3">
            {/* Grid: Date + Member */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <div className="md:col-span-2">
                <DateInput
                  value={manualDate}
                  onChange={setManualDate}
                  placeholder="Date"
                />
              </div>
              <div className="md:col-span-2">
                <Select
                  value={manualMemberId}
                  onChange={setManualMemberId}
                  options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                  placeholder="Team member"
                />
              </div>
            </div>

            {/* Time mode tabs + fields */}
            <div className="flex items-center gap-3 mb-3">
              <button
                type="button"
                onClick={() => setManualEntryMode('range')}
                className={`text-xs font-medium pb-0.5 border-b transition-colors ${
                  manualEntryMode === 'range'
                    ? 'text-brand-600 border-brand-500'
                    : 'text-zinc-400 border-transparent hover:text-zinc-600'
                }`}
              >
                Time Range
              </button>
              <button
                type="button"
                onClick={() => setManualEntryMode('duration')}
                className={`text-xs font-medium pb-0.5 border-b transition-colors ${
                  manualEntryMode === 'duration'
                    ? 'text-brand-600 border-brand-500'
                    : 'text-zinc-400 border-transparent hover:text-zinc-600'
                }`}
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
          </form>
        )}

        {/* ═══════════════════════════════════════════════════════
             ENTRY LIST (shared between modes)
           ═══════════════════════════════════════════════════════ */}
        {dateGroups.length > 0 ? (
          <div className="p-5 pt-3 space-y-4">
            {dateGroups.map(([date, dateEntries]) => (
              <div key={date}>
                <p className="text-xs uppercase tracking-wide font-medium text-zinc-400 mb-2">
                  {formatDateHeader(date)}
                </p>
                <div className="divide-y divide-zinc-100">
                  {dateEntries.map(entry => {
                    const member = getMember(entry.member_id);
                    const isEditing = editingId === entry.id;
                    const hours = computeHours(entry);

                    if (isEditing && editState) {
                      return (
                        <div key={entry.id} className="py-3 space-y-2 rounded-lg bg-zinc-50 -mx-1 px-3 border border-zinc-100">
                          <div className="grid grid-cols-[1fr_1fr_auto_1fr] gap-2 items-center pt-1">
                            <DateInput
                              size="sm"
                              value={editState.date}
                              onChange={v => setEditState({ ...editState, date: v })}
                            />
                            <TimeInput
                              size="sm"
                              value={editState.startTime}
                              onChange={v => setEditState({ ...editState, startTime: v })}
                              placeholder="Start"
                            />
                            <span className="text-xs text-zinc-300 font-medium select-none">to</span>
                            <TimeInput
                              size="sm"
                              value={editState.endTime}
                              onChange={v => setEditState({ ...editState, endTime: v })}
                              placeholder="End"
                            />
                          </div>
                          <div className="flex gap-2 items-center pb-1">
                            <div className="flex-1">
                              <TextInput
                                size="sm"
                                value={editState.description}
                                onChange={v => setEditState({ ...editState, description: v })}
                                placeholder="Description"
                              />
                            </div>
                            <div className="min-w-[130px]">
                              <Select
                                value={editState.memberId}
                                onChange={v => setEditState({ ...editState, memberId: v })}
                                options={memberOptions.map(m => ({ value: m.id, label: m.name, icon: <Avatar name={m.name} src={m.avatar} size="xs" /> }))}
                                placeholder="Member"
                                size="sm"
                              />
                            </div>
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={saveEdit}
                                className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="p-1.5 text-zinc-400 hover:bg-zinc-100 rounded-md transition-colors"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={entry.id} className="flex items-center gap-3 py-2 group">
                        <div className="flex-shrink-0">
                          <Avatar name={member?.name || '?'} src={member?.avatar} size="sm" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-700 truncate">
                            {entry.description || <span className="text-zinc-400 italic">No description</span>}
                          </p>
                          <p className="text-xs text-zinc-400">
                            {member?.name} &middot; {formatTime(entry.start_time, tz)} – {entry.end_time ? formatTime(entry.end_time, tz) : '...'}{' '}
                            <span
                              className="font-semibold tabular-nums px-1.5 py-0.5 rounded-md"
                              style={{ color: projectColor, backgroundColor: projectColor + '14' }}
                            >
                              {formatHM(hours)}
                            </span>
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Tooltip content="Edit">
                            <button
                              onClick={() => startEdit(entry)}
                              className="p-1.5 text-zinc-300 hover:text-brand-600 transition-colors"
                            >
                              <Pencil size={13} />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete">
                            <button
                              onClick={() => setDeleteTarget(entry.id)}
                              className="p-1.5 text-zinc-300 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : !runningTimer ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Clock size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No hours logged yet</p>
            <p className="text-xs text-zinc-400 mt-1">
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
    </div>
  );
}
