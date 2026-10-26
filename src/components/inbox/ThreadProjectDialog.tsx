'use client';

import { useMemo, useState } from 'react';
import { Globe, UserPlus } from 'lucide-react';
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
import { inboxClient } from '@/lib/communications/inbox-client';
import { CANDIDATE_REASON_LABELS, type InboxThreadDetail } from '@/lib/communications/inbox-types';
import { OTHER_PROJECT } from './inbox-badges';

interface ThreadProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  detail: InboxThreadDetail;
  onSaved: () => void | Promise<void>;
}

/**
 * Add a project to a thread, beside any it is already filed on (a meeting or
 * a teammate's email can touch several). Optionally remember the sender (they
 * become a contact on the chosen projects) or their domain (a client domain
 * on the chosen projects), so future mail maps on arrival. Only people do
 * this: agents can suggest a project but never create a mapping. Confirming
 * the agent's choice and removing a project happen on the chips themselves.
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
  // Candidates without a name are in projects this member cannot open: shown, never chosen.
  const reachable = (id: string) => projects.some((p) => p.id === id);
  const filed = new Set(detail.projects.map((p) => p.id));

  // Start fresh when the dialog opens or the thread changes, never when the
  // thread merely refreshes: a realtime ping must not wipe a choice mid-edit.
  // Only people are remembered: a note taker, a notification or a newsletter
  // writes for every client, so mapping it would file all of its mail on one project.
  const machineSenders = new Set(detail.messages
    .filter((message) => message.sorting && message.sorting.kind !== 'person' && message.sorting.kind !== 'team')
    .map((message) => (message.original_sender ?? message.from)?.address?.toLowerCase())
    .filter((address): address is string => !!address));
  const rememberable = detail.senders.filter((s) => !machineSenders.has(s.address.toLowerCase()));
  const formKey = isOpen ? detail.id : null;
  const [preparedFor, setPreparedFor] = useState<string | null>(null);
  if (formKey !== preparedFor) {
    setPreparedFor(formKey);
    if (formKey) {
      const initial = detail.candidates.find((c) => c.name !== null && reachable(c.project_id) && !filed.has(c.project_id))?.project_id || '';
      setProjectId(initial);
      setSenderAddress(rememberable[0]?.address ?? '');
      setRememberSender(false);
      setRememberDomain(false);
      setSenderProjects(initial ? [initial] : []);
      setDomainProjects(initial ? [initial] : []);
    }
  }

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? detail.candidates.find((c) => c.project_id === id)?.name ?? OTHER_PROJECT;
  const projectOptions = projects
    .filter((p) => p.status !== 'archived' || p.id === projectId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name }));
  // The project picker leaves out what the thread is already filed on; the remember lists keep every project.
  const addOptions = projectOptions.filter((option) => !filed.has(option.value));
  const sender = rememberable.find((s) => s.address === senderAddress) ?? null;

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
      const result = await client.addProject(detail.id, {
        project_id: projectId,
        remember_sender: rememberSender && sender ? { address: sender.address, project_ids: senderProjects } : null,
        remember_domain: rememberDomain && sender && !sender.domain_is_public ? { domain: sender.domain, project_ids: domainProjects } : null,
      });
      const parts = [filed.size ? `Added ${result.project.name}` : `Project set to ${result.project.name}`];
      if (result.remembered_sender) parts.push(result.remembered_sender.created_contact ? 'sender added as a contact' : 'sender remembered');
      if (result.remembered_domain) parts.push(`${result.remembered_domain.domain} remembered`);
      toast('success', parts.join(', '));
      await onSaved();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not add the project');
    } finally {
      setSaving(false);
    }
  };

  const adding = filed.size > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={adding ? 'Add a project' : 'Set project'} size="lg">
      <div className="space-y-5">
        <div className="space-y-2">
          <Select
            label="Project"
            visibleLabel="Project"
            value={projectId}
            onChange={chooseProject}
            options={addOptions}
            searchable
            placeholder="Choose a project"
          />
          {adding && (
            <p className="text-xs text-zinc-400">
              Filed on {detail.projects.map((p) => p.name).join(', ')}. The new project is added beside {detail.projects.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          {detail.candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-400">Mapping matched:</span>
              {detail.candidates.filter((candidate) => !filed.has(candidate.project_id)).map((candidate) => (
                candidate.name !== null && reachable(candidate.project_id) ? (
                  <button
                    key={candidate.project_id}
                    type="button"
                    onClick={() => chooseProject(candidate.project_id)}
                    aria-pressed={projectId === candidate.project_id}
                    className={`rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      projectId === candidate.project_id ? 'bg-brand-500/15 text-brand-300' : 'bg-white/[0.05] text-zinc-300 hover:bg-white/[0.08]'
                    }`}
                  >
                    {candidate.name}
                    <span className="sr-only"> (matched by {candidate.reasons.map((reason) => CANDIDATE_REASON_LABELS[reason] ?? reason).join(' and ')})</span>
                  </button>
                ) : (
                  <span key={candidate.project_id} className="rounded-full border border-dashed border-white/[0.16] px-2.5 py-1 text-xs text-zinc-400">
                    {OTHER_PROJECT}
                    <span className="sr-only"> (matched, but you cannot open that project)</span>
                  </span>
                )
              ))}
            </div>
          )}
        </div>

        {detail.senders.length === 0 ? (
          <p className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-zinc-400">
            Every sender in this thread is a teammate or an inbox, so there is no client address to remember.
          </p>
        ) : rememberable.length === 0 ? (
          <p className="rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-zinc-400">
            {detail.senders[0].name || detail.senders[0].address} sends automatic mail for every client, so it is never remembered for one project.
            {detail.projects.some((p) => p.source === 'address') ? ' This thread is filed by the address it was sent to.' : ' The project is added for this thread only.'}
          </p>
        ) : (
          <div className="space-y-4 rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
            <div>
              <h3 className="text-sm font-medium text-white">Remember for future mail</h3>
              <p className="mt-0.5 text-xs text-zinc-400">Mail from this sender then maps to a project on arrival.</p>
            </div>
            {rememberable.length > 1 && (
              <Select
                label="Sender"
                value={senderAddress}
                onChange={setSenderAddress}
                options={rememberable.map((s) => ({ value: s.address, label: s.name ? `${s.name} <${s.address}>` : s.address }))}
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
            {saving ? 'Saving...' : adding ? 'Add project' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
