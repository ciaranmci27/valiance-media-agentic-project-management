'use client';

import { BookOpen } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ContextBrief } from '@/components/projects/BriefTab';

const WORKSPACE_SCOPE = { scope_type: 'workspace' as const, scope_id: null };

/**
 * Settings > Workspace > Company knowledge: what every member and agent here
 * should know, in the project brief's sections. Pinned entries go into every
 * agent's context; the rest are found by search. Owners and settings
 * managers write it; every member but a guest reads it.
 */
export function CompanyKnowledgeSection() {
  return (
    <section className="glass-card rounded-xl p-4 lg:p-6">
      <SettingsSectionHeader
        icon={BookOpen}
        title="Company knowledge"
        description="What everyone here, people and agents, should know: who you are, how you work, the words you use. Pin what every agent should always read."
      />
      <ContextBrief scope={WORKSPACE_SCOPE} label="company knowledge" emptyText="Nothing here yet. Add what someone new to the company should know." />
    </section>
  );
}
