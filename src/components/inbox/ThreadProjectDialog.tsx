'use client';

import { useEffect, useMemo, useState } from 'react';
import { Globe, Info, UserPlus } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { MultiSelect } from '@/components/ui/inputs/MultiSelect';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { inboxClient } from '@/lib/inbound-email/inbox-client';
import type { InboxThreadDetail } from '@/lib/inbound-email/inbox-types';

interface ThreadProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  detail: InboxThreadDetail;
  onSaved: () => void | Promise<void>;
}

/**
 * Set or confirm a thread's project. Optionally remember the sender (they
 * become a contact on the chosen projects) or their domain (a client domain
 * on the chosen projects), so future mail maps on arrival. Only people do
 * this: agents can suggest a project but never create a mapping.
 */
export function ThreadProjectDialog({ isOpen, onClose, detail, onSaved }: ThreadProjectDialogProps) {
  const { projects } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const client = useMemo(() => inboxClient(isDemoMode), [isDemoMode]);
  const canRememberSender = hasPermission(access, 'contacts.manage');
  const canRememberDomain = hasPermission(access, 'contacts.manage') || hasPermission(access, 'inbound_email.manage');

  const [projectId, setProjectId] = useState('');
  const [senderAddress, setSenderAddress] = useState('');
  const [rememberSender, setRememberSender] = useState(false);
  const [senderProjects, setSenderProjects] = useState<string[]>([]);
  const [rememberDomain, setRememberDomain] = useState(false);
  const [domainProjects, setDomainProjects] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const initial = detail.project?.id ?? detail.candidates[0]?.project_id ?? '';
    setProjectId(initial);
    setSenderAddress(detail.senders[0]?.address ?? '');
    setRememberSender(false);
    setRememberDomain(false);
    setSenderProjects(initial ? [initial] : []);
    setDomainProjects(initial ? [initial] : []);
  }, [isOpen, detail]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? detail.candidates.find((c) => c.project_id === id)?.name ?? 'Project';
  const projectOptions = projects
    .filter((p) => p.status !== 'archived' || p.id === projectId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name }));
  const sender = detail.senders.find((s) => s.address === senderAddress) ?? null;

  // The chosen project follows into the remember lists until they are edited.
  const chooseProject = (id: string) => {
    setProjectId(id);
    setSenderProjects((current) => (current.length <= 1 ? [id] : current));
    setDomainProjects((current) => (current.length <= 1 ? [id] : current));
  };

  const save = async () => {
    if (!projectId) {
      toast('error', 'Choose a project');
      return;
    }
    if (rememberSender && senderProjects.length === 0) {
      toast('error', 'Choose at least one project to remember the sender for');
      return;
    }
    if (rememberDomain && domainProjects.length === 0) {
      toast('error', 'Choose at least one project to remember the domain for');
      return;
    }
    setSaving(true);
    try {
      const result = await client.setProject(detail.id, {
        project_id: projectId,
        remember_sender: rememberSender && sender ? { address: sender.address, project_ids: senderProjects } : null,
        remember_domain: rememberDomain && sender && !sender.domain_is_public ? { domain: sender.domain, project_ids: domainProjects } : null,
      });
      const parts = [`Project set to ${result.project.name}`];
      if (result.remembered_sender) parts.push(result.remembered_sender.created_contact ? 'sender added as a contact' : 'sender remembered');
      if (result.remembered_domain) parts.push(`${result.remembered_domain.domain} remembered`);
      toast('success', parts.join(', '));
      await onSaved();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not set the project');
    } finally {
      setSaving(false);
    }
  };

  const inferred = detail.project?.source === 'inferred';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={inferred ? 'Confirm project' : 'Set project'} size="lg">
      <div className="space-y-5">
        <div className="space-y-2">
          <Select
            label="Project"
            visibleLabel="Project"
            value={projectId}
            onChange={chooseProject}
            options={projectOptions}
            searchable
            placeholder="Choose a project"
          />
          {detail.candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-400">Mapping matched:</span>
              {detail.candidates.map((candidate) => (
                <button
                  key={candidate.project_id}
                  type="button"
                  onClick={() => chooseProject(candidate.project_id)}
                  aria-pressed={projectId === candidate.project_id}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    projectId === candidate.project_id ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.08]'
                  }`}
                >
                  {candidate.name ?? projectName(candidate.project_id)}
                  <span className="sr-only"> (matched by {candidate.reasons.join(' and ')})</span>
                </button>
              ))}
            </div>
          )}
          {inferred && (
            <p className="flex items-start gap-1.5 text-xs text-zinc-400">
              <Info size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              {detail.inbox.handler?.name ?? 'The agent'} chose {detail.project?.name}. Saving marks it as set by you.
            </p>
          )}
        </div>

        {detail.senders.length === 0 ? (
          <p className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-zinc-400">
            Every sender in this thread is a teammate or an inbox, so there is no client address to remember.
          </p>
        ) : (
          <div className="space-y-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
            <div>
              <h3 className="text-sm font-medium text-white">Remember for future mail</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Mail from this sender then maps to a project on arrival.</p>
            </div>
            {detail.senders.length > 1 && (
              <Select
                label="Sender"
                value={senderAddress}
                onChange={setSenderAddress}
                options={detail.senders.map((s) => ({ value: s.address, label: s.name ? `${s.name} <${s.address}>` : s.address }))}
              />
            )}

            {sender && (
              <>
                <div className="space-y-2">
                  <Checkbox
                    checked={rememberSender}
                    onChange={setRememberSender}
                    disabled={!canRememberSender}
                    label={<span className="inline-flex items-center gap-1.5 text-sm text-zinc-200"><UserPlus size={13} aria-hidden="true" />Remember {sender.address}</span>}
                    description={
                      !canRememberSender
                        ? 'You need permission to manage contacts.'
                        : sender.contact_ids.length
                          ? 'They are already a contact; they are added to the projects below.'
                          : `${sender.name || 'They'} will be added as a contact on the projects below.`
                    }
                  />
                  {sender.mapped_project_ids.length > 0 && (
                    <p className="pl-7 text-xs text-zinc-400">Already maps to {sender.mapped_project_ids.map(projectName).join(', ')}.</p>
                  )}
                  {rememberSender && (
                    <div className="pl-7">
                      <MultiSelect label="Projects for this sender" options={projectOptions} value={senderProjects} onChange={setSenderProjects} searchable size="sm" />
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Checkbox
                    checked={rememberDomain && !sender.domain_is_public}
                    onChange={setRememberDomain}
                    disabled={!canRememberDomain || sender.domain_is_public}
                    label={<span className="inline-flex items-center gap-1.5 text-sm text-zinc-200"><Globe size={13} aria-hidden="true" />Remember everyone at @{sender.domain}</span>}
                    description={
                      sender.domain_is_public
                        ? `${sender.domain} is a public email service, so only the exact address can be remembered.`
                        : !canRememberDomain
                          ? 'You need permission to manage contacts or inboxes.'
                          : 'Any address at this domain maps to the projects below.'
                    }
                  />
                  {sender.domain_project_ids.length > 0 && (
                    <p className="pl-7 text-xs text-zinc-400">@{sender.domain} already maps to {sender.domain_project_ids.map(projectName).join(', ')}.</p>
                  )}
                  {rememberDomain && !sender.domain_is_public && (
                    <div className="pl-7">
                      <MultiSelect label="Projects for this domain" options={projectOptions} value={domainProjects} onChange={setDomainProjects} searchable size="sm" />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-white/[0.08] pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={saving || !projectId}>
            {saving ? 'Saving...' : inferred && projectId === detail.project?.id ? 'Confirm project' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
