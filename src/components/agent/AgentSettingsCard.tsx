'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Input } from '@/components/ui/Input';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Toggle } from '@/components/ui/Toggle';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { Settings } from 'lucide-react';
import { Project } from '@/lib/types';
import { DEFAULT_SENSITIVE_PATHS } from '@/lib/autonomy';

/**
 * People paste whatever their clipboard has: the browser URL, the SSH remote,
 * a deep link into a file. All of them contain the slug, so all of them are
 * accepted and reduced to owner/repo rather than rejected.
 */
function normalizeRepoInput(raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  value = value.replace(/^git@github\.com:/i, '');
  value = value.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  value = value.replace(/\.git$/i, '');
  value = value.replace(/[?#].*$/, '');
  const parts = value.split('/').filter(Boolean);
  // A deep link (owner/repo/tree/main/src) still names the repo in its first
  // two segments; keep exactly those. Partial input stays as typed.
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return value;
}

interface AgentSettingsCardProps {
  project: Project;
  onUpdate: (updates: Partial<Project>) => void;
}

/**
 * The autonomy levers. Every control here is read by an agent; a field that
 * nothing reads does not belong on this card. The previous version rendered
 * two dead fields and a "Playground: commits to main" mode no agent honored,
 * and the visible-but-unwired Suggestions Per Cycle number caused a 12-hour
 * audit stall when the auditor inferred it was his queue cap.
 */
export function AgentSettingsCard({ project, onUpdate }: AgentSettingsCardProps) {
  const [repoPathDraft, setRepoPathDraft] = useState(project.repo_path ?? '');
  const [sensitiveDraft, setSensitiveDraft] = useState(project.sensitive_paths ?? DEFAULT_SENSITIVE_PATHS);
  const [integrationDraft, setIntegrationDraft] = useState(project.integration_branch ?? 'dev');
  const [productionDraft, setProductionDraft] = useState(project.production_branch ?? 'main');
  // The numbers are DRAFTS committed once, debounced, never a write per stepper
  // click. A write per click races the store's reconcile-with-server step:
  // response #1 lands after optimistic click #2 and snaps the field backwards,
  // which reads as lag or a bug.
  const [perCycleDraft, setPerCycleDraft] = useState<number>(project.suggestions_per_cycle ?? 3);
  const [queueCapDraft, setQueueCapDraft] = useState<number>(project.suggestion_queue_cap ?? 10);
  const [intervalDraft, setIntervalDraft] = useState<number>(project.audit_interval_hours ?? 4);
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setRepoPathDraft(project.repo_path ?? '');
    setSensitiveDraft(project.sensitive_paths ?? DEFAULT_SENSITIVE_PATHS);
    setIntegrationDraft(project.integration_branch ?? 'dev');
    setProductionDraft(project.production_branch ?? 'main');
    setPerCycleDraft(project.suggestions_per_cycle ?? 3);
    setQueueCapDraft(project.suggestion_queue_cap ?? 10);
    setIntervalDraft(project.audit_interval_hours ?? 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // One write carrying the whole coherent trio, 600ms after the last change.
  // Clamping happens here, at commit time, so mid-typing states are never
  // "corrected" under the user's cursor.
  const commitNumbers = useCallback((per: number, cap: number, interval: number) => {
    const safeCap = Math.max(1, Math.floor(cap) || 1);
    const safePer = Math.min(safeCap, Math.max(1, Math.floor(per) || 1));
    const safeInterval = Math.max(1, Math.floor(interval) || 1);
    if (safePer !== per) setPerCycleDraft(safePer);
    if (safeCap !== cap) setQueueCapDraft(safeCap);
    if (safeInterval !== interval) setIntervalDraft(safeInterval);
    const updates: Partial<Project> = {};
    if (safePer !== (project.suggestions_per_cycle ?? 3)) updates.suggestions_per_cycle = safePer;
    if (safeCap !== (project.suggestion_queue_cap ?? 10)) updates.suggestion_queue_cap = safeCap;
    if (safeInterval !== (project.audit_interval_hours ?? 4)) updates.audit_interval_hours = safeInterval;
    if (Object.keys(updates).length > 0) onUpdate(updates);
  }, [project.suggestions_per_cycle, project.suggestion_queue_cap, project.audit_interval_hours, onUpdate]);

  const scheduleCommit = useCallback((per: number, cap: number, interval: number) => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => commitNumbers(per, cap, interval), 600);
  }, [commitNumbers]);

  const flushCommit = useCallback(() => {
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
    commitNumbers(perCycleDraft, queueCapDraft, intervalDraft);
  }, [commitNumbers, perCycleDraft, queueCapDraft, intervalDraft]);

  useEffect(() => () => { if (commitTimer.current) clearTimeout(commitTimer.current); }, []);

  // A single-branch repo cannot auto-merge: the only merge target IS the
  // branch that ships to users. The toggle disables rather than pretending.
  const branchesCollide =
    (project.integration_branch ?? 'dev').trim() === (project.production_branch ?? 'main').trim();

  const commitSensitivePaths = () => {
    const value = sensitiveDraft.trim();
    const current = project.sensitive_paths ?? DEFAULT_SENSITIVE_PATHS;
    if (!value) {
      // Empty would make EVERYTHING match (grep of an empty pattern matches
      // every line), silently disabling auto-merge across the project.
      setSensitiveDraft(current);
      return;
    }
    if (value === current) return;
    try {
      new RegExp(value, 'i');
    } catch {
      toast('error', 'Invalid pattern, not saved');
      setSensitiveDraft(current);
      return;
    }
    onUpdate({ sensitive_paths: value });
    toast('success', 'Sensitive paths updated');
  };

  const commitBranch = (
    draft: string,
    field: 'integration_branch' | 'production_branch',
    fallback: string,
  ) => {
    const value = draft.trim() || fallback;
    if (value !== (project[field] ?? fallback)) {
      const updates: Partial<Project> = { [field]: value };
      // Colliding branches make auto-merge structurally impossible; reflect
      // that in the stored flag rather than leaving a toggle that lies.
      const other = field === 'integration_branch'
        ? (project.production_branch ?? 'main').trim()
        : (project.integration_branch ?? 'dev').trim();
      if (value === other && project.auto_merge_enabled) {
        updates.auto_merge_enabled = false;
        toast('info', 'Auto-merge disabled: integration and production are the same branch');
      }
      onUpdate(updates);
    }
  };

  const sectionLabel = 'text-[11px] font-semibold text-zinc-500 uppercase tracking-wider';

  return (
    <div className="glass-card rounded-xl overflow-hidden flex flex-col">
      <div className="px-5 py-4 flex items-center gap-2 flex-shrink-0 border-b border-white/[0.06]">
        <Settings size={18} className="text-zinc-400" aria-hidden="true" />
        <h2 className="font-semibold text-white">Autonomy</h2>
      </div>

      <div className="p-5 space-y-6">
        {/* ---- Gates: what the agents MAY do here ---------------------------- */}
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">Autonomous agents</p>
              <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                Agents audit this project, spec approved work, and build it unprompted.
                Off hides existing suggestions and stops everything new.
              </p>
            </div>
            <Toggle
              checked={project.autonomous_enabled}
              aria-label="Autonomous agents"
              onChange={() => {
                if (project.autonomous_enabled) setShowPauseConfirm(true);
                else {
                  onUpdate({ autonomous_enabled: true });
                  toast('success', 'Autonomous agents enabled');
                }
              }}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-white">Auto-merge</p>
              <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                {branchesCollide
                  ? 'Unavailable: integration and production are the same branch, so every merge would ship to users.'
                  : <>Green, contained PRs merge into <span className="font-mono text-zinc-400">{project.integration_branch ?? 'dev'}</span> without you. Sensitive paths, failing checks, and unverified criteria always hold for review. Nothing ever auto-merges into <span className="font-mono text-zinc-400">{project.production_branch ?? 'main'}</span>.</>}
              </p>
            </div>
            <Toggle
              checked={project.auto_merge_enabled && !branchesCollide}
              disabled={branchesCollide}
              aria-label="Auto-merge"
              onChange={() => {
                const next = !project.auto_merge_enabled;
                onUpdate({ auto_merge_enabled: next });
                toast('success', next ? 'Auto-merge enabled' : 'Auto-merge disabled');
              }}
            />
          </div>
        </div>

        {/* ---- Repository ---------------------------------------------------- */}
        <div className="space-y-3">
          <p className={sectionLabel}>Repository</p>
          <TextInput
            label="Repository"
            prefix={<span className="font-mono text-xs">github.com/</span>}
            value={repoPathDraft}
            onChange={(value) => setRepoPathDraft(normalizeRepoInput(value))}
            onBlur={() => {
              const value = normalizeRepoInput(repoPathDraft) || null;
              setRepoPathDraft(value ?? '');
              if (value !== (project.repo_path ?? null)) onUpdate({ repo_path: value });
            }}
            placeholder="owner/repo"
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Integration branch"
              value={integrationDraft}
              onChange={(e) => setIntegrationDraft(e.target.value)}
              onBlur={() => commitBranch(integrationDraft, 'integration_branch', 'dev')}
              placeholder="dev"
            />
            <Input
              label="Production branch"
              value={productionDraft}
              onChange={(e) => setProductionDraft(e.target.value)}
              onBlur={() => commitBranch(productionDraft, 'production_branch', 'main')}
              placeholder="main"
            />
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            The dev agent branches from and PRs into the integration branch. The production
            branch is a declaration that it ships to users: the merge gate refuses it, always.
          </p>
          <TextInput
            label="Sensitive paths"
            value={sensitiveDraft}
            onChange={setSensitiveDraft}
            onBlur={commitSensitivePaths}
            placeholder={DEFAULT_SENSITIVE_PATHS}
          />
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Case-insensitive pattern over changed file paths. A PR touching a match is never
            auto-merged; it holds for your click instead. The same pattern drives the autonomy
            forecasts on Radar and the boards, so what the badge predicts is what the gate does.
          </p>
        </div>

        {/* ---- Discovery pace ------------------------------------------------ */}
        <div className="space-y-3">
          <p className={sectionLabel}>Discovery pace</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <NumberInput
              label="Findings per cycle"
              min={1}
              max={queueCapDraft}
              value={perCycleDraft}
              onChange={(v) => {
                // Burst never exceeds the queue it lands in; clamp against the
                // DRAFT cap so the pair stays coherent while both are moving.
                const next = Math.min(queueCapDraft, Math.max(1, typeof v === 'number' ? v : 1));
                setPerCycleDraft(next);
                scheduleCommit(next, queueCapDraft, intervalDraft);
              }}
              onBlur={flushCommit}
            />
            <NumberInput
              label="Review queue cap"
              min={1}
              value={queueCapDraft}
              onChange={(v) => {
                const next = Math.max(1, typeof v === 'number' ? v : 1);
                setQueueCapDraft(next);
                // Lowering the cap below the burst drags the burst down with it:
                // settings move together rather than leaving an invalid pair.
                let per = perCycleDraft;
                if (per > next) {
                  per = next;
                  setPerCycleDraft(next);
                  toast('info', `Findings per cycle lowered to ${next} to fit the queue cap`);
                }
                scheduleCommit(per, next, intervalDraft);
              }}
              onBlur={flushCommit}
            />
            <NumberInput
              label="Audit interval (h)"
              min={1}
              value={intervalDraft}
              onChange={(v) => {
                const next = Math.max(1, typeof v === 'number' ? v : 1);
                setIntervalDraft(next);
                scheduleCommit(perCycleDraft, queueCapDraft, next);
              }}
              onBlur={flushCommit}
            />
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Per cycle limits one run&apos;s burst. The queue cap pauses discovery while that many
            suggestions await your review; a full queue is an instruction, not a fault. The
            interval is the minimum gap between audits of this project.
          </p>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showPauseConfirm}
        onClose={() => setShowPauseConfirm(false)}
        onConfirm={() => {
          onUpdate({ autonomous_enabled: false });
          toast('success', 'Autonomous agents paused');
          setShowPauseConfirm(false);
        }}
        title="Pause Autonomous Agents"
        message="If you pause, agents stop auditing, speccing, and building here. Existing suggestions stay in the database but disappear from the interface until you resume. Continue?"
        confirmLabel="Pause"
        variant="default"
      />
    </div>
  );
}
