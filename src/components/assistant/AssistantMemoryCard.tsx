'use client';

import { BookHeart } from 'lucide-react';
import { ContextBrief } from '@/components/projects/BriefTab';

/**
 * My Assistant > What it remembers: the person's own memory (context scope
 * member), which only they and their own assistant read, never an Owner.
 * The assistant adds to it only while "Remember things for me" is on; the
 * person sees everything in it and deletes what they want it to forget.
 */
export function AssistantMemoryCard({ personId, assistantName, remembering, isDemo }: {
  personId: string;
  assistantName: string;
  remembering: boolean;
  isDemo: boolean;
}) {
  return (
    <section className="glass-card rounded-xl overflow-hidden" aria-labelledby="assistant-memory-heading">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
        <BookHeart size={15} className="text-zinc-400" aria-hidden="true" />
        <h2 id="assistant-memory-heading" className="text-sm font-semibold text-white">What it remembers</h2>
      </div>
      <div className="p-4">
        <p className="mb-4 text-sm text-zinc-400">
          {remembering
            ? `Only you and ${assistantName} see this. Delete anything you want it to forget.`
            : `Remember things for me is off, so ${assistantName} keeps nothing new. Anything it kept before stays here until you delete it.`}
        </p>
        {isDemo ? (
          <p className="text-sm text-zinc-500">Nothing yet.</p>
        ) : (
          <ContextBrief
            scope={{ scope_type: 'member', scope_id: personId }}
            label="what it remembers"
            emptyText={remembering ? `Nothing yet. ${assistantName} adds what you ask it to remember.` : 'Nothing yet.'}
          />
        )}
      </div>
    </section>
  );
}
