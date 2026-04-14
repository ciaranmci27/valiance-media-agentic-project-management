'use client';

import { useState } from 'react';

const TEMPLATES = [
  { key: 'team-task-assigned', label: 'Task Assigned', group: 'Team' },
  { key: 'team-task-status', label: 'Task Status Change', group: 'Team' },
  { key: 'team-task-comment', label: 'Task Comment', group: 'Team' },
  { key: 'team-project-created', label: 'Project Created', group: 'Team' },
  { key: 'team-lead-converted', label: 'Lead Converted', group: 'Team' },
  { key: 'team-lead-status', label: 'Lead Status (No Details)', group: 'Team' },
  { key: 'team-minimal', label: 'Minimal (No Link/Details)', group: 'Team' },
  { key: 'portal-welcome', label: 'Portal Welcome', group: 'Client' },
  { key: 'budget-threshold-hours', label: 'Budget Alert (Hours)', group: 'Client' },
  { key: 'budget-threshold-amount', label: 'Budget Alert (Amount)', group: 'Client' },
  { key: 'project-summary', label: 'Project Summary', group: 'Client' },
  { key: 'project-summary-caught-up', label: 'Summary (All Caught Up)', group: 'Client' },
  { key: 'project-summary-no-budget', label: 'Summary (No Budget)', group: 'Client' },
] as const;

type TemplateKey = typeof TEMPLATES[number]['key'];

export default function EmailPreviewPage() {
  const [active, setActive] = useState<TemplateKey>('team-task-assigned');

  const groups = ['Team', 'Client'] as const;

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="max-w-[750px] mx-auto">
        <h1 className="text-lg font-semibold text-zinc-900 mb-1">Email Template Preview</h1>
        <p className="text-sm text-zinc-400 mb-5">Preview all email templates with sample data.</p>

        {groups.map(group => (
          <div key={group} className="mb-3">
            <p className="text-[10px] uppercase tracking-wider font-medium text-zinc-400 mb-1.5">{group}</p>
            <div className="flex flex-wrap gap-1.5 mb-1">
              {TEMPLATES.filter(t => t.group === group).map(t => (
                <button
                  key={t.key}
                  onClick={() => setActive(t.key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    active === t.key
                      ? 'bg-brand-600 text-white'
                      : 'bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden mt-4">
          <iframe
            key={active}
            src={`/api/email-preview?template=${active}`}
            className="w-full border-0"
            style={{ height: '800px' }}
            title={`Preview: ${active}`}
          />
        </div>
      </div>
    </div>
  );
}
