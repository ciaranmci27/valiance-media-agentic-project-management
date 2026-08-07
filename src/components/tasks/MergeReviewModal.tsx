'use client';

import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { PriorityBadge } from '@/components/ui/Badge';
import { ExternalLink, PanelRight, Check, Minus, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { Task } from '@/lib/types';
import type { ReviewProfile } from '@/lib/autonomy';

/**
 * The action briefing for a merge waiting on the owner. The side panel is a
 * task OVERVIEW; this modal answers the three questions a reviewer actually
 * has before clicking merge: what kind of review is this, why is it held,
 * and what exactly must be true. Then it sends them straight to the diff.
 */
export function MergeReviewModal({
  task,
  profile,
  projectName,
  open,
  onClose,
  onOpenTask,
}: {
  task: Task | null;
  profile: ReviewProfile | null;
  projectName: string | null;
  open: boolean;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}) {
  if (!task || !profile) return null;

  const chips: string[] = [
    profile.tier ? profile.tier.replace(/_/g, ' ') : null,
    profile.effort ? `${profile.effort} change` : null,
    profile.valueCategory ? profile.valueCategory.replace(/_/g, ' ') : null,
  ].filter((c): c is string => Boolean(c));

  const heldLine = profile.matchedCategories.length > 0
    ? `Held because it touches ${profile.matchedCategories.join(', ')}.`
    : 'Held for your review; no file forecast was available, so the gate errs toward you.';

  const depthGuidance = {
    'Quick skim': 'A small, tightly-specced change: skim the sensitive surface below and the diff summary.',
    'Standard review': 'A moderate change: read the diff with the criteria beside it.',
    'Deep review': 'A feature-sized change: block out real time and review it like a colleague’s PR.',
  }[profile.reviewDepth];

  return (
    <Modal isOpen={open} onClose={onClose} title="Merge review" size="lg">
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-white leading-snug">{task.title}</h3>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <PriorityBadge priority={task.priority} />
            {chips.map(chip => (
              <span key={chip} className="text-[10px] font-medium uppercase tracking-wider text-zinc-300 bg-white/[0.06] rounded-full px-2 py-0.5">
                {chip}
              </span>
            ))}
            {projectName && <span className="text-xs text-zinc-500 ml-1">{projectName}</span>}
          </div>
        </div>

        {/* The review ask, in one breath */}
        <div className="bg-amber-500/[0.07] border border-amber-500/20 rounded-lg p-3">
          <p className="text-sm text-amber-200 font-medium">{profile.reviewDepth}</p>
          <p className="text-xs text-zinc-300 mt-1 leading-relaxed">{heldLine} {depthGuidance}</p>
        </div>

        {/* The independent reviewer's word, when there is one. Absence is
            stated outright: an unreviewed PR should feel unreviewed. */}
        {profile.reviewerVerdict ? (
          profile.reviewerVerdict.verdict === 'approved' ? (
            <div className="bg-emerald-500/[0.07] border border-emerald-500/20 rounded-lg p-3 flex items-start gap-2">
              <ShieldCheck size={15} className="text-emerald-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm text-emerald-200 font-medium">
                  Approved by John · round {profile.reviewerVerdict.round}
                </p>
                {profile.reviewerVerdict.summary && (
                  <p className="text-xs text-zinc-300 mt-1 leading-relaxed">{profile.reviewerVerdict.summary}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-red-500/[0.07] border border-red-500/20 rounded-lg p-3 flex items-start gap-2">
              <ShieldAlert size={15} className="text-red-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm text-red-200 font-medium">
                  John requested changes · round {profile.reviewerVerdict.round}
                </p>
                {profile.reviewerVerdict.summary && (
                  <p className="text-xs text-zinc-300 mt-1 leading-relaxed">{profile.reviewerVerdict.summary}</p>
                )}
              </div>
            </div>
          )
        ) : (
          <p className="text-xs text-zinc-500 leading-relaxed">
            Not independently reviewed yet. John reviews agent PRs on his next pass; merging now means you are the only reviewer.
          </p>
        )}

        {/* What must be true: the criteria the agent was gated on */}
        {profile.criteriaTotal > 0 && (
          <div className="bg-surface-raised rounded-lg border border-white/[0.08] p-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Acceptance criteria · {profile.criteriaDone}/{profile.criteriaTotal} verified
            </p>
            <ul className="space-y-1.5">
              {(task.acceptance_criteria ?? []).map(criterion => (
                <li key={criterion.id} className="flex items-start gap-2 text-sm text-zinc-300">
                  {criterion.satisfied
                    ? <Check size={14} className="text-emerald-400 mt-0.5 flex-shrink-0" aria-label="Verified" />
                    : <Minus size={14} className="text-zinc-500 mt-0.5 flex-shrink-0" aria-label="Not verified" />}
                  <span className="leading-snug">{criterion.criterion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Why the client is paying for this */}
        {profile.billingCase && (
          <p className="text-xs text-zinc-400 leading-relaxed border-l-2 border-brand-500/40 pl-3">
            {profile.billingCase}
          </p>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-zinc-500 tabular-nums">
            {profile.hoursSpent > 0.05 ? `~${profile.hoursSpent.toFixed(1)}h of agent time` : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" icon={<PanelRight size={14} />} onClick={() => { onClose(); onOpenTask(task); }}>
              Open task
            </Button>
            {profile.prUrl && (
              <a href={profile.prUrl} target="_blank" rel="noopener noreferrer">
                <Button icon={<ExternalLink size={14} />}>Review the PR</Button>
              </a>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
