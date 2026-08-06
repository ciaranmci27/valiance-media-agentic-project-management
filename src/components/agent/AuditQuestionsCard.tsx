'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useApp } from '@/lib/store';
import { Tooltip } from '@/components/ui/Tooltip';
import { SearchCode } from 'lucide-react';

/**
 * The auditor's question selection, rendered as structured UI instead of the
 * prose blob it is stored as. The selection steers everything the auditor
 * looks at, and it used to be invisible: a GREG_QUESTIONS context entry
 * buried mid-page inside Technical Decisions.
 *
 * Read-only on purpose. Selection belongs to the spec agent, whose tool validates
 * it (5 to 10 questions, 3+ themes, at least one opportunity question); an
 * edit path here would bypass those rules.
 */

const SELECTION_PREFIX = 'GREG_QUESTIONS:';

interface AuditQuestionsCardProps {
  projectId: string;
}

export function AuditQuestionsCard({ projectId }: AuditQuestionsCardProps) {
  const { taskSuggestions } = useApp();
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await createClient()
        .from('project_context')
        .select('content')
        .eq('project_id', projectId)
        .eq('is_active', true)
        .like('content', `${SELECTION_PREFIX}%`)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!cancelled) {
        setSelectionText(data?.[0]?.content ?? null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const questions = useMemo(() => {
    if (!selectionText) return [];
    // Format written by Ashley's tool: "GREG_QUESTIONS: a, b, c. <prose...>".
    // The list ends at the first sentence break after the ids.
    const body = selectionText.slice(selectionText.indexOf(SELECTION_PREFIX) + SELECTION_PREFIX.length);
    const listPart = body.split(/[.\n]/)[0] ?? '';
    return listPart
      .split(',')
      .map(q => q.trim())
      .filter(q => /^[a-z0-9-]+$/.test(q));
  }, [selectionText]);

  const usage = useMemo(() => {
    const byQuestion = new Map<string, { count: number; last: string }>();
    for (const s of taskSuggestions) {
      if (s.project_id !== projectId) continue;
      const q = s.metadata?.question_id;
      if (typeof q !== 'string') continue;
      const prev = byQuestion.get(q);
      byQuestion.set(q, {
        count: (prev?.count ?? 0) + 1,
        last: prev && prev.last > s.created_at ? prev.last : s.created_at,
      });
    }
    return byQuestion;
  }, [taskSuggestions, projectId]);

  const words = (slug: string) =>
    slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return (
    <div className="glass-card rounded-xl overflow-hidden flex flex-col">
      <div className="px-5 py-4 flex items-center gap-2 border-b border-white/[0.06]">
        <SearchCode size={18} className="text-zinc-400" aria-hidden="true" />
        <h2 className="font-semibold text-white">Audit Questions</h2>
        {questions.length > 0 && (
          <span className="ml-auto text-[10px] text-zinc-500 uppercase tracking-wider">
            {usage.size ? `${[...usage.keys()].filter(q => questions.includes(q)).length} of ${questions.length} used` : `${questions.length} selected`}
          </span>
        )}
      </div>

      <div className="p-5">
        {loading ? (
          <div className="space-y-2 animate-pulse">
            <div className="h-6 w-3/4 bg-white/[0.06] rounded-full" />
            <div className="h-6 w-2/3 bg-white/[0.06] rounded-full" />
          </div>
        ) : questions.length === 0 ? (
          <p className="text-sm text-zinc-500 leading-relaxed">
            No question selection yet, so the auditor has nothing to aim at.
            Ask your spec agent to select audit questions for this project.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {questions.map(q => {
                const used = usage.get(q);
                return (
                  <Tooltip
                    key={q}
                    content={used
                      ? `${used.count} finding${used.count === 1 ? '' : 's'} proposed from this question`
                      : 'Not audited yet'}
                  >
                    <span
                      tabIndex={0}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium cursor-default ${
                        used
                          ? 'bg-brand-500/15 text-brand-300'
                          : 'bg-white/[0.06] text-zinc-400'
                      }`}
                    >
                      {words(q)}
                      {used && <span className="text-[10px] opacity-80">{used.count}</span>}
                    </span>
                  </Tooltip>
                );
              })}
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed mt-3">
              These steer every audit cycle. The selection is the spec agent&apos;s job (its tool
              enforces breadth rules), so to change it, ask her to reselect.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
