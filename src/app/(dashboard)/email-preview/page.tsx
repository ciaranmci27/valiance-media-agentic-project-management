'use client';

import { useState } from 'react';

const TEMPLATES = [
  { key: 'team-task-assigned', label: 'Task assigned', group: 'Team' },
  { key: 'team-task-status', label: 'Task status change', group: 'Team' },
  { key: 'team-task-comment', label: 'Task comment', group: 'Team' },
  { key: 'team-project-created', label: 'Project created', group: 'Team' },
  { key: 'team-lead-converted', label: 'Lead converted', group: 'Team' },
  { key: 'team-lead-status', label: 'Lead status (no details)', group: 'Team' },
  { key: 'team-minimal', label: 'Minimal (no link or details)', group: 'Team' },
  { key: 'smtp-test', label: 'SMTP test', group: 'Team' },
  { key: 'portal-welcome', label: 'Portal welcome', group: 'Client' },
  { key: 'portal-welcome-plain', label: 'Portal welcome (logo, no message)', group: 'Client' },
  { key: 'project-summary', label: 'Project summary', group: 'Client' },
  { key: 'project-summary-caught-up', label: 'Summary (all caught up)', group: 'Client' },
  { key: 'project-summary-no-budget', label: 'Summary (no budget)', group: 'Client' },
  { key: 'budget-threshold-hours', label: 'Budget alert (hours)', group: 'Client' },
  { key: 'budget-threshold-amount', label: 'Budget alert (amount, 90%)', group: 'Client' },
  { key: 'dollar-interval', label: 'Dollar interval', group: 'Client' },
  { key: 'budget-extended', label: 'Budget extended', group: 'Client' },
  { key: 'budget-updated', label: 'Budget updated (unit change)', group: 'Client' },
  { key: 'invoice-sent', label: 'Invoice (sent)', group: 'Invoice' },
  { key: 'invoice-paid', label: 'Invoice (paid)', group: 'Invoice' },
  { key: 'invoice-overdue', label: 'Invoice (overdue)', group: 'Invoice' },
  { key: 'invoice-cancelled', label: 'Invoice (cancelled)', group: 'Invoice' },
  { key: 'invoice-draft', label: 'Invoice (draft)', group: 'Invoice' },
  { key: 'invoice-no-portal', label: 'Invoice (no portal)', group: 'Invoice' },
] as const;

type TemplateKey = typeof TEMPLATES[number]['key'];

export default function EmailPreviewPage() {
  const [active, setActive] = useState<TemplateKey>('team-task-assigned');

  const groups = ['Team', 'Client', 'Invoice'] as const;

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
            style={{ height: '900px' }}
            title={`Preview: ${active}`}
          />
        </div>
      </div>
    </div>
  );
}
