'use client';

import { useEffect, useState } from 'react';
import {
  Mail, Send, Bell, BellOff, DollarSign,
  ShieldCheck, ShieldAlert, X as XIcon, Plus, AlertCircle,
  FileText, Sparkles, RotateCcw,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { toast } from '@/components/ui/Toast';
import { Select } from '@/components/ui/Select';
import ClientEmailPreviewModal from './ClientEmailPreviewModal';
import type { ClientCommType, AlertMode } from '@/lib/types';

interface ClientCommunicationsPanelProps {
  projectId: string;
  onSent?: () => void;
}

const MANUAL_ACTIONS: { type: ClientCommType; label: string; description: string; icon: typeof Mail }[] = [
  {
    type: 'portal_welcome',
    label: 'Portal Welcome',
    description: 'Introduce the portal to the primary client',
    icon: Sparkles,
  },
  {
    type: 'project_summary',
    label: 'Project Summary',
    description: 'Share a status update and current balance',
    icon: FileText,
  },
];

const TYPE_LABELS: Record<ClientCommType, string> = {
  portal_welcome: 'Portal Welcome',
  project_summary: 'Project Summary',
  invoice: 'Invoice',
  budget_threshold: 'Budget Threshold',
  dollar_interval: 'Dollar Interval',
  budget_extended: 'Budget Updated',
};

const ALERT_MODE_OPTIONS: { value: AlertMode; label: string }[] = [
  { value: 'percentage', label: 'Percentage of budget' },
  { value: 'dollar_interval', label: 'Every N dollars tracked' },
  { value: 'none', label: 'No automated alerts' },
];

export function ClientCommunicationsPanel({ projectId, onSent }: ClientCommunicationsPanelProps) {
  const { getPortalSettings, getProject, getPrimaryClient, upsertPortalSettings } = useApp();
  const { isDemoMode } = useDemo();

  const project = getProject(projectId);
  const settings = getPortalSettings(projectId);
  const primaryClient = getPrimaryClient(projectId);
  const hasPrimaryEmail = !!primaryClient?.contact?.email;

  const [manualModal, setManualModal] = useState<{ type: ClientCommType } | null>(null);
  const [newThreshold, setNewThreshold] = useState('');
  const [dollarIntervalInput, setDollarIntervalInput] = useState(
    settings?.dollar_interval != null ? String(settings.dollar_interval) : '',
  );

  useEffect(() => {
    setDollarIntervalInput(settings?.dollar_interval != null ? String(settings.dollar_interval) : '');
  }, [settings?.dollar_interval]);

  const alertMode: AlertMode = settings?.alert_mode ?? 'percentage';
  const requireApproval = settings?.require_alert_approval ?? true;
  const rearmOnBudgetChange = settings?.rearm_thresholds_on_budget_change ?? false;
  const thresholds = settings?.notification_thresholds ?? [50, 75, 90, 100];
  const hasBudget = !!(project?.budget_type && project?.budget_value);

  const handleOpenManual = (type: ClientCommType) => {
    if (!hasPrimaryEmail) {
      toast('error', 'Set a primary client contact with an email first');
      return;
    }
    if (isDemoMode) {
      toast('success', `${TYPE_LABELS[type]} email sent (demo)`);
      return;
    }
    setManualModal({ type });
  };

  const handleAlertModeChange = (mode: string) => {
    upsertPortalSettings(projectId, { alert_mode: mode as AlertMode });
  };

  const handleToggleApproval = () => {
    upsertPortalSettings(projectId, { require_alert_approval: !requireApproval });
  };

  const handleToggleRearm = () => {
    upsertPortalSettings(projectId, {
      rearm_thresholds_on_budget_change: !rearmOnBudgetChange,
    });
  };

  const handleAddThreshold = () => {
    const val = parseInt(newThreshold, 10);
    if (isNaN(val) || val < 1 || val > 100) {
      toast('error', 'Enter a number between 1 and 100');
      return;
    }
    if (thresholds.includes(val)) {
      toast('error', 'Threshold already exists');
      setNewThreshold('');
      return;
    }
    const updated = [...thresholds, val].sort((a, b) => a - b);
    upsertPortalSettings(projectId, { notification_thresholds: updated });
    setNewThreshold('');
  };

  const handleRemoveThreshold = (val: number) => {
    upsertPortalSettings(projectId, {
      notification_thresholds: thresholds.filter(t => t !== val),
    });
  };

  const handleDollarIntervalBlur = () => {
    const raw = dollarIntervalInput.trim();
    if (!raw) {
      if (settings?.dollar_interval != null) {
        upsertPortalSettings(projectId, { dollar_interval: null });
      }
      return;
    }
    const val = parseFloat(raw);
    if (isNaN(val) || val <= 0) {
      setDollarIntervalInput(settings?.dollar_interval != null ? String(settings.dollar_interval) : '');
      toast('error', 'Enter a positive dollar amount');
      return;
    }
    if (val !== settings?.dollar_interval) {
      upsertPortalSettings(projectId, { dollar_interval: val });
    }
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col">
      <div className="px-5 py-4 flex items-center gap-2 border-b border-zinc-100">
        <Mail size={18} className="text-zinc-500" />
        <h2 className="font-semibold text-zinc-900">Client Communications</h2>
      </div>

      <div className="p-5 space-y-6">
        {/* Quick actions */}
        <section>
          <div className="flex items-center gap-1.5 mb-3">
            <Send size={13} className="text-zinc-400" />
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Send Now</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {MANUAL_ACTIONS.map(({ type, label, description, icon: Icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => handleOpenManual(type)}
                disabled={!hasPrimaryEmail}
                className="group flex items-start gap-3 p-3 rounded-lg border border-zinc-200 bg-white hover:border-brand-300 hover:bg-brand-50/40 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-zinc-200"
              >
                <div className="p-1.5 rounded-md bg-zinc-100 group-hover:bg-brand-100 transition-colors flex-shrink-0">
                  <Icon size={14} className="text-zinc-600 group-hover:text-brand-700" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-800">{label}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">{description}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Automation config */}
        {settings?.enabled ? (
          <section className="space-y-4">
            <div className="flex items-center gap-1.5">
              <Bell size={13} className="text-zinc-400" />
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Automation</h3>
            </div>

            <div className="space-y-2">
              <label className="block text-xs text-zinc-600">Budget alerts</label>
              <Select
                options={ALERT_MODE_OPTIONS}
                value={alertMode}
                onChange={handleAlertModeChange}
                size="sm"
              />
            </div>

            {alertMode === 'percentage' && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">
                  Send an alert when tracked work reaches these percentages of the project budget.
                </p>
                {hasBudget ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {thresholds.map(t => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-brand-50 border border-brand-200 text-brand-700 text-xs font-medium"
                      >
                        {t}%
                        <button
                          type="button"
                          onClick={() => handleRemoveThreshold(t)}
                          className="text-brand-400 hover:text-red-500 transition-colors"
                          aria-label={`Remove ${t}% threshold`}
                        >
                          <XIcon size={10} />
                        </button>
                      </span>
                    ))}
                    <div className="inline-flex items-stretch h-6">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={newThreshold}
                        onChange={e => setNewThreshold(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAddThreshold()}
                        placeholder="%"
                        className="w-14 px-1.5 text-xs leading-none border border-zinc-200 rounded-l-md focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <button
                        type="button"
                        onClick={handleAddThreshold}
                        className="inline-flex items-center justify-center px-1.5 text-xs border border-l-0 border-zinc-200 rounded-r-md bg-zinc-50 text-zinc-500 hover:bg-zinc-100 transition-colors"
                        aria-label="Add threshold"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                    Set a project budget to enable threshold alerts.
                  </div>
                )}

                <div className="flex items-start justify-between gap-3 pt-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <RotateCcw
                      size={14}
                      className={`mt-0.5 flex-shrink-0 ${
                        rearmOnBudgetChange ? 'text-brand-600' : 'text-zinc-400'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-zinc-800">Rearm thresholds after budget changes</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {rearmOnBudgetChange
                          ? 'Each budget change starts a new tracking period. Thresholds can fire again as usage crosses them in the new period.'
                          : 'Each threshold fires at most once per project. Budget changes do not reset them.'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleRearm}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                      rearmOnBudgetChange ? 'bg-brand-600' : 'bg-zinc-300'
                    }`}
                    aria-label="Toggle rearm thresholds on budget change"
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
                        rearmOnBudgetChange ? 'translate-x-[18px]' : 'translate-x-[3px]'
                      }`}
                    />
                  </button>
                </div>
              </div>
            )}

            {alertMode === 'dollar_interval' && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">
                  Send an alert every time tracked work crosses another milestone of this dollar amount.
                </p>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <DollarSign
                      size={12}
                      className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400"
                    />
                    <input
                      type="number"
                      min={1}
                      step="any"
                      value={dollarIntervalInput}
                      onChange={e => setDollarIntervalInput(e.target.value)}
                      onBlur={handleDollarIntervalBlur}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      placeholder="500"
                      className="w-28 pl-6 pr-2 py-1.5 text-sm border border-zinc-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
                    />
                  </div>
                  <span className="text-xs text-zinc-500">per milestone</span>
                </div>
              </div>
            )}

            {alertMode === 'none' && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-zinc-50 border border-zinc-200 text-xs text-zinc-600">
                <BellOff size={12} className="mt-0.5 flex-shrink-0" />
                Automated budget alerts are off. Use the Send Now actions above when you want to reach out.
              </div>
            )}

            <div className="flex items-start justify-between gap-3 pt-1">
              <div className="flex items-start gap-2 min-w-0">
                {requireApproval ? (
                  <ShieldCheck size={14} className="text-brand-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <ShieldAlert size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-sm text-zinc-800">Require approval before sending</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {requireApproval
                      ? 'Automated alerts queue for review. You approve or dismiss each one.'
                      : 'Automated alerts send immediately with no manual review.'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggleApproval}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                  requireApproval ? 'bg-brand-600' : 'bg-zinc-300'
                }`}
                aria-label="Toggle approval requirement"
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow-sm ${
                    requireApproval ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`}
                />
              </button>
            </div>
          </section>
        ) : (
          <section className="border-t border-zinc-100 pt-5">
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-zinc-50 border border-zinc-200 text-xs text-zinc-600">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              Enable the client portal to configure automated notifications.
            </div>
          </section>
        )}
      </div>

      {manualModal && (
        <ClientEmailPreviewModal
          open={!!manualModal}
          onClose={() => setManualModal(null)}
          projectId={projectId}
          manual={{ type: manualModal.type }}
          onCompleted={onSent}
        />
      )}
    </div>
  );
}
