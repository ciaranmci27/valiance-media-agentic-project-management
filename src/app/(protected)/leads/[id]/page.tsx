'use client';

import { useState } from 'react';

import { useParams, useRouter } from 'next/navigation';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { LeadForm } from '@/components/leads/LeadForm';
import { LeadInteractionForm } from '@/components/leads/LeadInteractionForm';
import { LeadProposalForm } from '@/components/leads/LeadProposalForm';
import { ConvertLeadModal } from '@/components/leads/ConvertLeadModal';
import { LeadFieldsSection } from '@/components/leads/LeadFieldsSection';
import { LeadContactsSection } from '@/components/leads/LeadContactsSection';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { LeadInteraction, LeadProposal } from '@/lib/types';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import {
  Edit, Trash2, ArrowRightCircle, Target,
  Mail, Phone, Building2, User, StickyNote, DollarSign, Plus, CalendarClock,
  PhoneCall, Users, Check,
} from 'lucide-react';
import { formatPhone } from '@/lib/format-phone';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
  new: { label: 'New', variant: 'info' },
  contacted: { label: 'Contacted', variant: 'purple' },
  qualified: { label: 'Qualified', variant: 'warning' },
  proposal: { label: 'Proposal', variant: 'default' },
  won: { label: 'Won', variant: 'success' },
  lost: { label: 'Lost', variant: 'danger' },
};

const SOURCE_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
  referral: { label: 'Referral', variant: 'success' },
  website: { label: 'Website', variant: 'info' },
  social: { label: 'Social', variant: 'purple' },
  cold_outreach: { label: 'Cold Outreach', variant: 'warning' },
  event: { label: 'Event', variant: 'default' },
  network: { label: 'Network', variant: 'info' },
  other: { label: 'Other', variant: 'default' },
};

const PROPOSAL_STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
  draft: { label: 'Draft', variant: 'default' },
  sent: { label: 'Sent', variant: 'info' },
  accepted: { label: 'Accepted', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'danger' },
};

const INTERACTION_ICONS: Record<string, React.ReactNode> = {
  call: <PhoneCall size={16} />,
  email: <Mail size={16} />,
  meeting: <Users size={16} />,
  note: <StickyNote size={16} />,
  follow_up: <CalendarClock size={16} />,
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);
}

function formatRelativeDate(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const {
    getLead, getTeamMember, getInteractionsByLead, getProposalsByLead, getUpcomingFollowUps,
    updateLead, deleteLead, updateLeadInteraction, deleteLeadInteraction, deleteLeadProposal,
  } = useApp();
  const { access } = useAuth();
  const canManageLeads = hasPermission(access, 'leads.manage');
  const canReadFiles = hasPermission(access, 'files.read');

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isConvertOpen, setIsConvertOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isInteractionFormOpen, setIsInteractionFormOpen] = useState(false);
  const [editingInteraction, setEditingInteraction] = useState<LeadInteraction | null>(null);
  const [isProposalFormOpen, setIsProposalFormOpen] = useState(false);
  const [editingProposal, setEditingProposal] = useState<LeadProposal | null>(null);
  const [deletingInteractionId, setDeletingInteractionId] = useState<string | null>(null);
  const [deletingProposalId, setDeletingProposalId] = useState<string | null>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');

  const leadId = params.id as string;
  const lead = getLead(leadId);

  if (!lead) {
    return (
      <div className="animate-fadeIn min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Target className="mx-auto mb-3 text-zinc-500" size={40} />
          <h3 className="font-medium text-zinc-300 mb-1">Lead not found</h3>
          <button
            onClick={() => router.push('/leads')}
            className="text-sm text-brand-300 hover:text-brand-300"
          >
            Back to leads
          </button>
        </div>
      </div>
    );
  }

  const members = (lead.member_ids || []).map(id => getTeamMember(id)).filter(Boolean) as NonNullable<ReturnType<typeof getTeamMember>>[];
  const interactions = getInteractionsByLead(leadId);
  const proposals = getProposalsByLead(leadId);
  const upcomingFollowUps = getUpcomingFollowUps(leadId);
  const statusCfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.new;
  const sourceCfg = SOURCE_CONFIG[lead.source] || SOURCE_CONFIG.other;
  const canConvert = lead.status !== 'won' && lead.status !== 'lost';

  const handleDelete = async () => {
    router.push('/leads');
    const ok = await deleteLead(leadId);
    if (ok) toast('success', 'Lead deleted');
  };

  const handleMarkFollowUpComplete = async (interaction: LeadInteraction) => {
    const ok = await updateLeadInteraction(interaction.id, { completed: true });
    if (ok) toast('success', 'Follow-up marked complete');
  };

  const handleEditInteraction = (interaction: LeadInteraction) => {
    setEditingInteraction(interaction);
    setIsInteractionFormOpen(true);
  };

  const handleEditProposal = (proposal: LeadProposal) => {
    setEditingProposal(proposal);
    setIsProposalFormOpen(true);
  };

  const executeDeleteInteraction = async () => {
    if (!deletingInteractionId) return;
    const ok = await deleteLeadInteraction(deletingInteractionId);
    if (ok) toast('success', 'Interaction deleted');
  };

  const executeDeleteProposal = async () => {
    if (!deletingProposalId) return;
    const ok = await deleteLeadProposal(deletingProposalId);
    if (ok) toast('success', 'Proposal deleted');
  };

  const isOverdue = (scheduledAt: string) => new Date(scheduledAt) < new Date();

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Lead Details"
        actions={canManageLeads ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setIsEditOpen(true)} icon={<Edit size={16} />}>
              <span className="hidden [@media(min-width:400px)]:inline">Edit</span>
            </Button>
            {canConvert && (
              <Button variant="secondary" onClick={() => setIsConvertOpen(true)} icon={<ArrowRightCircle size={16} />}>
                <span className="hidden [@media(min-width:400px)]:inline">Convert</span>
              </Button>
            )}
          </div>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {/* Lead Info Card */}
        <div className="glass-card rounded-xl p-5 lg:p-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:gap-5 mb-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <User size={18} className="text-zinc-500" />
              {lead.name}
            </h2>
            {lead.company && (
              <span className="flex items-center gap-1.5 text-sm text-zinc-400">
                <Building2 size={14} className="text-zinc-500" />
                {lead.company}
              </span>
            )}
            <div className="flex items-center gap-4 text-sm mt-1 lg:mt-0">
              {lead.email ? (
                <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 text-zinc-300 hover:text-brand-300 transition-colors">
                  <Mail size={14} className="text-zinc-500" />
                  <span>{lead.email}</span>
                </a>
              ) : (
                <span className="flex items-center gap-1.5 text-zinc-600 italic">
                  <Mail size={14} />
                  <span>No email</span>
                </span>
              )}
              {lead.phone ? (
                <a href={`tel:${lead.phone}`} className="flex items-center gap-1.5 text-zinc-300 hover:text-brand-300 transition-colors">
                  <Phone size={14} className="text-zinc-500" />
                  <span>{formatPhone(lead.phone)}</span>
                </a>
              ) : (
                <span className="flex items-center gap-1.5 text-zinc-600 italic">
                  <Phone size={14} />
                  <span>No phone</span>
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_3fr] gap-4 mb-4">
            <div>
              <p className="text-xs text-zinc-400 mb-1">Status</p>
              <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
            </div>
            <div>
              <p className="text-xs text-zinc-400 mb-1">Source</p>
              <Badge variant={sourceCfg.variant}>{sourceCfg.label}</Badge>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-xs text-zinc-400 mb-1">Team Members</p>
              {members.length > 0 ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {members.map(m => (
                    <div key={m.id} className="flex items-center gap-1.5 bg-white/[0.03] rounded-full px-2 py-0.5">
                      <Avatar name={m.name} src={m.avatar || undefined} size="xs" />
                      <span className="text-sm text-zinc-300">{m.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-zinc-500">No members assigned</span>
              )}
            </div>
          </div>

          {/* Editable Notes */}
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <StickyNote size={14} />
                <span>Notes</span>
              </div>
              {canManageLeads && !isEditingNotes && (
                <button
                  onClick={() => { setNotesValue(lead.notes || ''); setIsEditingNotes(true); }}
                  className="text-xs text-brand-300 hover:text-brand-300 transition-colors"
                >
                  {lead.notes ? 'Edit' : 'Add notes'}
                </button>
              )}
            </div>
            {isEditingNotes ? (
              <div className="space-y-2">
                <RichTextEditor
                  value={notesValue}
                  onChange={setNotesValue}
                  placeholder="Add notes about this lead..."
                  rows={3}
                />
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setIsEditingNotes(false)}
                    className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[0.06] rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setIsEditingNotes(false);
                      const ok = await updateLead(lead.id, { notes: notesValue });
                      if (ok) toast('success', 'Notes updated');
                    }}
                    className="px-3 py-1.5 text-xs text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              lead.notes ? (
                <div
                  className="text-sm text-zinc-300 prose prose-sm prose-zinc max-w-none"
                  dangerouslySetInnerHTML={{ __html: lead.notes }}
                />
              ) : (
                <p className="text-sm text-zinc-500 italic">No notes yet</p>
              )
            )}
          </div>
        </div>

        {/* Lead Details (Dynamic Fields) */}
        <LeadFieldsSection leadId={leadId} readOnly={!canManageLeads} />

        {/* Upcoming Follow-ups */}
        {upcomingFollowUps.length > 0 && (
          <div className="bg-amber-500/15 rounded-xl border border-amber-500/30 p-5 lg:p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <CalendarClock size={18} className="text-amber-400" />
                <h2 className="font-semibold text-amber-900">
                  Upcoming Follow-ups ({upcomingFollowUps.length})
                </h2>
              </div>
              {canManageLeads && <Button
                size="sm"
                onClick={() => { setEditingInteraction(null); setIsInteractionFormOpen(true); }}
                icon={<Plus size={14} />}
              >
                Add Follow-up
              </Button>}
            </div>
            <div className="space-y-3">
              {upcomingFollowUps.map((fu) => {
                const overdue = fu.scheduled_at ? isOverdue(fu.scheduled_at) : false;
                return (
                  <div
                    key={fu.id}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      overdue ? 'bg-red-500/15 border border-red-500/30' : 'bg-surface-raised border border-amber-500/30'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <CalendarClock size={16} className={overdue ? 'text-red-500' : 'text-amber-500'} />
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${overdue ? 'text-red-300' : 'text-white'}`}>
                          {fu.title}
                        </p>
                        <p className={`text-xs ${overdue ? 'text-red-400' : 'text-zinc-400'}`}>
                          {fu.scheduled_at ? formatDate(fu.scheduled_at) : ''}
                          {overdue && ' (Overdue)'}
                        </p>
                      </div>
                    </div>
                    {canManageLeads && <button
                      onClick={() => handleMarkFollowUpComplete(fu)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/15 rounded-lg transition-colors flex-shrink-0"
                    >
                      <Check size={14} />
                      Mark Complete
                    </button>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Interactions + Proposals row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Interactions Timeline */}
          <div className="glass-card rounded-xl overflow-hidden flex flex-col max-h-[600px]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08] flex-shrink-0">
              <div className="flex items-center gap-2">
                <StickyNote size={18} className="text-zinc-400" />
                <h2 className="font-semibold text-white">
                  Interactions ({interactions.length})
                </h2>
              </div>
              {canManageLeads && <Button
                size="sm"
                onClick={() => { setEditingInteraction(null); setIsInteractionFormOpen(true); }}
                icon={<Plus size={14} />}
              >
                Add
              </Button>}
            </div>

            {interactions.length > 0 ? (
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {interactions.map((interaction) => {
                  const author = interaction.created_by ? getTeamMember(interaction.created_by) : null;
                  const isCompletedFollowUp = interaction.type === 'follow_up' && interaction.completed;

                  return (
                    <div
                      key={interaction.id}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors group ${isCompletedFollowUp ? 'opacity-60' : ''}`}
                    >
                      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                        isCompletedFollowUp ? 'bg-emerald-500/15 text-emerald-400' :
                        interaction.type === 'call' ? 'bg-blue-500/15 text-blue-400' :
                        interaction.type === 'email' ? 'bg-brand-500/15 text-brand-300' :
                        interaction.type === 'meeting' ? 'bg-violet-500/15 text-violet-400' :
                        interaction.type === 'follow_up' ? 'bg-amber-500/15 text-amber-400' :
                        'bg-white/[0.06] text-zinc-300'
                      }`}>
                        {isCompletedFollowUp ? <Check size={16} /> : INTERACTION_ICONS[interaction.type]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-white truncate">{interaction.title}</p>
                          <Badge variant={interaction.type === 'follow_up' ? 'warning' : 'default'}>
                            {interaction.type === 'follow_up' ? 'Follow-up' : interaction.type.charAt(0).toUpperCase() + interaction.type.slice(1)}
                          </Badge>
                          {isCompletedFollowUp && <Badge variant="success">Completed</Badge>}
                        </div>
                        {interaction.description && (
                          <p className="text-sm text-zinc-300 mt-1 line-clamp-2">{interaction.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-500">
                          <span>{formatRelativeDate(interaction.occurred_at)}</span>
                          {author && <span>by {author.name}</span>}
                        </div>
                      </div>
                      {canManageLeads && <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={() => handleEditInteraction(interaction)}
                          className="p-1.5 text-zinc-600 hover:text-brand-500 transition-all"
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          onClick={() => setDeletingInteractionId(interaction.id)}
                          className="p-1.5 text-zinc-600 hover:text-red-500 transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
                  <StickyNote size={18} className="text-zinc-500" />
                </div>
                <p className="text-sm font-medium text-zinc-400">No interactions yet</p>
                <p className="text-xs text-zinc-500 mt-1">Record calls, emails, and meetings</p>
              </div>
            )}
          </div>

          {/* Proposals */}
          <div className="glass-card rounded-xl overflow-hidden flex flex-col max-h-[600px]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08] flex-shrink-0">
              <div className="flex items-center gap-2">
                <DollarSign size={18} className="text-zinc-400" />
                <h2 className="font-semibold text-white">
                  Proposals ({proposals.length})
                </h2>
              </div>
              {canManageLeads && <Button
                size="sm"
                onClick={() => { setEditingProposal(null); setIsProposalFormOpen(true); }}
                icon={<Plus size={14} />}
              >
                Add
              </Button>}
            </div>

            {proposals.length > 0 ? (
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {proposals.map((proposal) => {
                  const pStatus = PROPOSAL_STATUS_CONFIG[proposal.status] || PROPOSAL_STATUS_CONFIG.draft;
                  return (
                    <div key={proposal.id} className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors group">
                      <div className="w-8 h-8 rounded-lg bg-surface-raised border border-white/[0.08] flex items-center justify-center flex-shrink-0">
                        <DollarSign size={14} className="text-zinc-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-white truncate">{proposal.title}</p>
                          <Badge variant={pStatus.variant}>{pStatus.label}</Badge>
                        </div>
                        {proposal.description && (
                          <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{proposal.description}</p>
                        )}
                        {proposal.estimated_value != null && (
                          <p className="text-xs text-zinc-500 mt-1">
                            {formatCurrency(proposal.estimated_value)}
                          </p>
                        )}
                      </div>
                      {canManageLeads && <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={() => handleEditProposal(proposal)}
                          className="p-1.5 text-zinc-600 hover:text-brand-500 transition-all"
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          onClick={() => setDeletingProposalId(proposal.id)}
                          className="p-1.5 text-zinc-600 hover:text-red-500 transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
                  <DollarSign size={18} className="text-zinc-500" />
                </div>
                <p className="text-sm font-medium text-zinc-400">No proposals yet</p>
                <p className="text-xs text-zinc-500 mt-1">Create proposals for this lead</p>
              </div>
            )}
          </div>
        </div>

        {/* Contacts + Files row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          <LeadContactsSection leadId={leadId} readOnly={!canManageLeads} />
          {canReadFiles && <FileAttachments entityType="lead" entityId={leadId} />}
        </div>

        {canManageLeads && <div className="flex justify-end">
          <Button variant="danger" onClick={() => setIsDeleteOpen(true)} icon={<Trash2 size={16} />}>
            Delete Lead
          </Button>
        </div>}
      </div>

      {/* Modals */}
      {canManageLeads && <LeadForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        lead={lead}
        onConvertRequested={() => setIsConvertOpen(true)}
      />}

      {canManageLeads && <ConvertLeadModal
        isOpen={isConvertOpen}
        onClose={() => setIsConvertOpen(false)}
        lead={lead}
      />}

      {canManageLeads && <LeadInteractionForm
        isOpen={isInteractionFormOpen}
        onClose={() => { setIsInteractionFormOpen(false); setEditingInteraction(null); }}
        leadId={leadId}
        interaction={editingInteraction}
      />}

      {canManageLeads && <LeadProposalForm
        isOpen={isProposalFormOpen}
        onClose={() => { setIsProposalFormOpen(false); setEditingProposal(null); }}
        leadId={leadId}
        proposal={editingProposal}
      />}

      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete Lead"
        message="This will permanently delete this lead and all its interactions and proposals. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={!!deletingInteractionId}
        onClose={() => setDeletingInteractionId(null)}
        onConfirm={executeDeleteInteraction}
        title="Delete Interaction"
        message="This will permanently delete this interaction. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={!!deletingProposalId}
        onClose={() => setDeletingProposalId(null)}
        onConfirm={executeDeleteProposal}
        title="Delete Proposal"
        message="This will permanently delete this proposal. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
