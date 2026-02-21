'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Clock, Plus, Trash2, Pencil, X, Check, Play, Square, Timer } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Select } from '@/components/ui/Select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TimeEntry } from '@/lib/types';
import { siteConfig } from '@/site-config';

/* ── Types ── */

type TrackingMode = 'timer' | 'manual';

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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function getDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}

function formatDateHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getStorageKey(projectId: string) {
  return `time-tracking-mode-${projectId}`;
}

/* ── Component ── */

export function TimeTrackingPanel({ projectId, projectColor = siteConfig.colors.brand[500] }: TimeTrackingPanelProps) {
  const {
    getTimeEntriesByProject, team, getProject,
    addTimeEntry, updateTimeEntry, deleteTimeEntry,
    startTimer, stopTimer, getRunningTimer,
  } = useApp();
  const { teamMemberId } = useAuth();

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
  const descDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Manual entry form state ──
  const [manualDate, setManualDate] = useState(new Date().toISOString().slice(0, 10));
  const [manualStartTime, setManualStartTime] = useState('');
  const [manualEndTime, setManualEndTime] = useState('');
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
      const dateKey = getDateKey(entry.start_time);
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

  const handleStopTimer = () => {
    // Flush any pending debounced description save
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
    const startISO = new Date(`${manualDate}T${manualStartTime}`).toISOString();
    const endISO = new Date(`${manualDate}T${manualEndTime}`).toISOString();
    if (new Date(endISO) <= new Date(startISO)) { toast('error', 'End time must be after start time'); return; }
    addTimeEntry({
      project_id: projectId,
      member_id: manualMemberId,
      start_time: startISO,
      end_time: endISO,
      description: manualDescription,
    });
    toast('success', 'Time entry added');
    setManualDescription('');
    setManualStartTime('');
    setManualEndTime('');
    setManualDate(new Date().toISOString().slice(0, 10));
  };

  const startEdit = (entry: TimeEntry) => {
    const start = new Date(entry.start_time);
    const end = entry.end_time ? new Date(entry.end_time) : new Date();
    setEditingId(entry.id);
    setEditState({
      date: getDateKey(entry.start_time),
      startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
      endTime: `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`,
      description: entry.description,
      memberId: entry.member_id,
    });
  };

  const cancelEdit = () => { setEditingId(null); setEditState(null); };

  const saveEdit = () => {
    if (!editingId || !editState) return;
    const startISO = new Date(`${editState.date}T${editState.startTime}`).toISOString();
    const endISO = new Date(`${editState.date}T${editState.endTime}`).toISOString();
    if (new Date(endISO) <= new Date(startISO)) { toast('error', 'End time must be after start time'); return; }
    updateTimeEntry(editingId, {
      start_time: startISO,
      end_time: endISO,
      description: editState.description,
      member_id: editState.memberId,
    });
    toast('success', 'Time entry updated');
    cancelEdit();
  };

  const executeDelete = () => {
    if (deleteTarget) { deleteTimeEntry(deleteTarget); toast('success', 'Time entry removed'); }
  };

  const inputClass = 'px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all';
  const dateGroups = Object.entries(groupedByDate);

  /* ================================================================
     RENDER
  ================================================================ */
  return (
    <div className="bg-white rounded-xl border border-zinc-200">
      {/* ── Header ── */}
      <div className="px-5 py-3 border-b border-zinc-200 flex items-center gap-2.5">
        <div className="p-1.5 rounded-md" style={{ backgroundColor: projectColor + '1A' }}>
          <Clock size={16} style={{ color: projectColor }} />
        </div>
        <h3 className="text-sm font-semibold text-zinc-900">Time Tracking</h3>
        <button
          onClick={toggleMode}
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-700 transition-colors flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-zinc-100"
        >
          {mode === 'manual' ? (
            <>
              <Timer size={13} />
              Switch to Live Timer
            </>
          ) : (
            <>
              <Clock size={13} />
              Switch to Manual Entry
            </>
          )}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════
           STATS ROW
         ═══════════════════════════════════════════════════════ */}
          {completedEntries.length > 0 && (
            <div className="px-5 pt-4 pb-2 flex items-center gap-6">
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Total Hours</p>
                <p className="text-2xl font-bold tabular-nums" style={{ color: projectColor }}>
                  {totalHours.toFixed(1)}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">This Week</p>
                <p className="text-2xl font-bold tabular-nums text-zinc-900">
                  {thisWeekHours.toFixed(1)}
                </p>
              </div>
              {uniqueMembers.length > 0 && (
                <div>
                  <p className="text-xs text-zinc-500 font-medium mb-1">Contributors</p>
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
            <div className="px-5 py-4 border-b border-zinc-100">
              {runningTimer ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="relative flex items-center justify-center">
                      <span
                        className="absolute w-3 h-3 rounded-full animate-ping opacity-50"
                        style={{ backgroundColor: projectColor }}
                      />
                      <span
                        className="relative w-3 h-3 rounded-full"
                        style={{ backgroundColor: projectColor }}
                      />
                    </div>
                    <span
                      className="text-3xl font-bold tabular-nums tracking-tight"
                      style={{ color: projectColor }}
                    >
                      {formatElapsed(elapsed)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-zinc-400 truncate">
                        {getMember(runningTimer.member_id)?.name} &middot; Started {formatTime(runningTimer.start_time)}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={timerDescription}
                      onChange={e => {
                        const val = e.target.value;
                        setTimerDescription(val);
                        if (descDebounceRef.current) clearTimeout(descDebounceRef.current);
                        descDebounceRef.current = setTimeout(() => {
                          updateTimeEntry(runningTimer.id, { description: val });
                        }, 500);
                      }}
                      placeholder="What are you working on?"
                      className={`${inputClass} flex-1`}
                    />
                    <button
                      onClick={handleStopTimer}
                      className="px-4 h-[38px] rounded-lg text-white font-medium text-sm transition-colors flex items-center gap-2 flex-shrink-0 bg-red-500 hover:bg-red-600"
                    >
                      <Square size={14} />
                      Stop
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <div className="flex-1 min-w-[140px]">
                      <Select
                        value={timerMemberId || teamMemberId || ''}
                        onChange={setTimerMemberId}
                        options={memberOptions.map(m => ({ value: m.id, label: m.name }))}
                        placeholder="Select member"
                      />
                    </div>
                    <button
                      onClick={handleStartTimer}
                      className="px-4 h-[38px] rounded-lg text-white font-medium text-sm transition-colors flex items-center gap-2 flex-shrink-0"
                      style={{ backgroundColor: projectColor }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                    >
                      <Play size={14} />
                      Start Timer
                    </button>
                  </div>
                  <input
                    type="text"
                    value={timerDescription}
                    onChange={e => setTimerDescription(e.target.value)}
                    placeholder="What are you working on?"
                    className={`${inputClass} w-full`}
                  />
                </div>
              )}
            </div>
          )}

          {/* Running entry (pinned card, timer mode only) */}
          {mode === 'timer' && runningTimer && (
            <div className="px-5 py-3">
              <div
                className="flex items-center gap-3 py-2.5 px-3 rounded-lg border"
                style={{ borderColor: projectColor + '40', backgroundColor: projectColor + '08' }}
              >
                <div className="flex-shrink-0">
                  <Avatar name={getMember(runningTimer.member_id)?.name || '?'} src={getMember(runningTimer.member_id)?.avatar} size="sm" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 truncate">
                    {runningTimer.description || <span className="text-zinc-400 italic">No description</span>}
                  </p>
                  <p className="text-xs text-zinc-400">
                    {getMember(runningTimer.member_id)?.name} &middot; Started {formatTime(runningTimer.start_time)}
                  </p>
                </div>
                <span
                  className="text-sm font-semibold tabular-nums flex-shrink-0 px-2 py-0.5 rounded-md animate-pulse"
                  style={{ color: projectColor, backgroundColor: projectColor + '14' }}
                >
                  {formatElapsed(elapsed)}
                </span>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════
               MANUAL ENTRY MODE
             ═══════════════════════════════════════════════════════ */}
          {mode === 'manual' && (
            <form onSubmit={handleManualAdd} className="px-5 py-4 border-b border-zinc-100 space-y-2">
              {/* Row 1: Date + Member (mobile), Date + Start + End + Member (desktop) */}
              <div className="flex gap-2 items-center">
                <input
                  type="date"
                  value={manualDate}
                  onChange={e => setManualDate(e.target.value)}
                  className={`${inputClass} w-1/2 sm:w-1/4`}
                  required
                />
                <div className="w-1/2 sm:hidden">
                  <Select
                    value={manualMemberId}
                    onChange={setManualMemberId}
                    options={memberOptions.map(m => ({ value: m.id, label: m.name }))}
                    placeholder="Select member"
                  />
                </div>
                <div className="hidden sm:flex items-center gap-1.5 w-1/4">
                  <input
                    type="time"
                    value={manualStartTime}
                    onChange={e => setManualStartTime(e.target.value)}
                    className={`${inputClass} w-full`}
                    required
                  />
                </div>
                <div className="hidden sm:flex items-center gap-1.5 w-1/4">
                  <input
                    type="time"
                    value={manualEndTime}
                    onChange={e => setManualEndTime(e.target.value)}
                    className={`${inputClass} w-full`}
                    required
                  />
                </div>
                <div className="hidden sm:block w-1/4">
                  <Select
                    value={manualMemberId}
                    onChange={setManualMemberId}
                    options={memberOptions.map(m => ({ value: m.id, label: m.name }))}
                    placeholder="Select member"
                  />
                </div>
              </div>
              {/* Row 2 (mobile only): Start + End */}
              <div className="flex gap-2 items-center sm:hidden">
                <input
                  type="time"
                  value={manualStartTime}
                  onChange={e => setManualStartTime(e.target.value)}
                  className={`${inputClass} w-1/2`}
                  placeholder="Start"
                  required
                />
                <input
                  type="time"
                  value={manualEndTime}
                  onChange={e => setManualEndTime(e.target.value)}
                  className={`${inputClass} w-1/2`}
                  placeholder="End"
                  required
                />
              </div>
              {/* Row 3 (mobile) / Row 2 (desktop): Description + Add */}
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={manualDescription}
                  onChange={e => setManualDescription(e.target.value)}
                  placeholder="What did you work on?"
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="submit"
                  className="px-2.5 h-[38px] rounded-lg text-white transition-colors flex-shrink-0 flex items-center justify-center"
                  style={{ backgroundColor: projectColor }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  <Plus size={18} />
                </button>
              </div>
            </form>
          )}

          {/* ═══════════════════════════════════════════════════════
               ENTRY LIST (shared between modes)
             ═══════════════════════════════════════════════════════ */}
          {dateGroups.length > 0 ? (
            <div className="p-5 pt-3 space-y-4 max-h-[300px] overflow-y-auto">
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
                          <div key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                            <input
                              type="date"
                              value={editState.date}
                              onChange={e => setEditState({ ...editState, date: e.target.value })}
                              className={`${inputClass} w-full sm:w-auto text-xs`}
                            />
                            <div className="flex items-center gap-1">
                              <input
                                type="time"
                                value={editState.startTime}
                                onChange={e => setEditState({ ...editState, startTime: e.target.value })}
                                className={`${inputClass} w-[100px] text-xs`}
                              />
                              <span className="text-xs text-zinc-400">to</span>
                              <input
                                type="time"
                                value={editState.endTime}
                                onChange={e => setEditState({ ...editState, endTime: e.target.value })}
                                className={`${inputClass} w-[100px] text-xs`}
                              />
                            </div>
                            <input
                              type="text"
                              value={editState.description}
                              onChange={e => setEditState({ ...editState, description: e.target.value })}
                              className={`${inputClass} flex-1 min-w-[100px] text-xs`}
                            />
                            <div className="w-full sm:w-auto sm:min-w-[140px]">
                              <Select
                                value={editState.memberId}
                                onChange={v => setEditState({ ...editState, memberId: v })}
                                options={memberOptions.map(m => ({ value: m.id, label: m.name }))}
                                placeholder="Select member"
                              />
                            </div>
                            <div className="flex items-center gap-1">
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
                              {member?.name} &middot; {formatTime(entry.start_time)} – {entry.end_time ? formatTime(entry.end_time) : '...'}{' '}
                              <span
                                className="font-semibold tabular-nums px-1.5 py-0.5 rounded-md"
                                style={{ color: projectColor, backgroundColor: projectColor + '14' }}
                              >
                                {formatHM(hours)}
                              </span>
                            </p>
                          </div>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => startEdit(entry)}
                              className="p-1.5 text-zinc-300 hover:text-brand-600 transition-colors"
                              title="Edit"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(entry.id)}
                              className="p-1.5 text-zinc-300 hover:text-red-500 transition-colors"
                              title="Delete"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : !runningTimer ? (
            <div className="py-10 text-center">
              <Clock size={32} className="mx-auto mb-2 text-zinc-300" />
              <p className="text-sm font-medium text-zinc-500">No hours logged yet</p>
              <p className="text-xs text-zinc-400 mt-1">
                {mode === 'timer' ? 'Start a timer to begin tracking' : 'Use the form above to log your first entry'}
              </p>
            </div>
          ) : null}

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
