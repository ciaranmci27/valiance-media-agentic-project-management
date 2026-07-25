'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { LeadForm } from '@/components/leads/LeadForm';
import { ConvertLeadModal } from '@/components/leads/ConvertLeadModal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Plus, Target, Edit, Trash2, ArrowRightCircle } from 'lucide-react';
import { Lead, LEAD_FIELD_DEFINITIONS } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

const PIPELINE_STAGES: { status: Lead['status']; label: string }[] = [
  { status: 'new', label: 'New' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'qualified', label: 'Qualified' },
  { status: 'proposal', label: 'Proposal' },
];

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple';

const SOURCE_CONFIG: Record<Lead['source'], { label: string; variant: BadgeVariant }> = {
  referral: { label: 'Referral', variant: 'default' },
  website: { label: 'Website', variant: 'default' },
  social: { label: 'Social', variant: 'default' },
  cold_outreach: { label: 'Cold Outreach', variant: 'default' },
  event: { label: 'Event', variant: 'default' },
  network: { label: 'Network', variant: 'default' },
  other: { label: 'Other', variant: 'default' },
};

// Ordered budget buckets (source of truth is the budget_range lead field), used to
// sort the Budget column sensibly instead of alphabetically.
const BUDGET_OPTIONS = LEAD_FIELD_DEFINITIONS.find(f => f.key === 'budget_range')?.options ?? [];

const formatTimeAgo = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export default function LeadsPage() {
  const router = useRouter();
  const { leads, leadFields, deleteLead, getTeamMember, filters, setFilters } = useApp();
  const { access } = useAuth();
  const canManageLeads = hasPermission(access, 'leads.manage');

  // Budget range lives in the lead_fields table (a qualitative bucket), not on the
  // lead itself — this replaces the removed numeric value/equity columns.
  const budgetForLead = (leadId: string) =>
    leadFields.find(f => f.lead_id === leadId && f.field_key === 'budget_range')?.value || null;
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
  const [deletingLeadId, setDeletingLeadId] = useState<string | null>(null);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const handleEdit = (lead: Lead) => {
    setEditingLead(lead);
    setIsFormOpen(true);
  };

  const executeDelete = async () => {
    if (!deletingLeadId) return;
    const ok = await deleteLead(deletingLeadId);
    if (ok) toast('success', 'Lead deleted');
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingLead(null);
  };

  const searchLower = filters.search.toLowerCase();
  const filtered = filters.search
    ? leads.filter(l =>
        l.name.toLowerCase().includes(searchLower) ||
        l.company.toLowerCase().includes(searchLower) ||
        l.email.toLowerCase().includes(searchLower))
    : leads;

  const wonLeads = filtered.filter(l => l.status === 'won');
  const lostLeads = filtered.filter(l => l.status === 'lost');
  const activeLeads = filtered.filter(l => l.status !== 'won' && l.status !== 'lost');

  const buildActions = (l: Lead): RowAction[] => {
    const canConvert = l.status !== 'won' && l.status !== 'lost';
    return [
      { label: 'Edit', icon: <Edit size={14} />, onClick: () => handleEdit(l) },
      ...(canConvert ? [{ label: 'Convert', icon: <ArrowRightCircle size={14} />, variant: 'success' as const, onClick: () => setConvertingLead(l) }] : []),
      { label: 'Delete', icon: <Trash2 size={14} />, variant: 'danger' as const, onClick: () => setDeletingLeadId(l.id) },
    ];
  };

  const mobileCard = (l: Lead) => {
    const members = (l.member_ids || []).map(id => getTeamMember(id)).filter(Boolean) as { id: string; name: string; avatar?: string }[];
    return (
      <div className="glass-card rounded-xl p-4 hover:border-white/[0.12] transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/leads/${l.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-semibold text-white block truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
            >
              {l.name}
            </Link>
            <p className={`text-sm truncate ${l.company ? 'text-zinc-400' : 'text-zinc-600 italic'}`}>{l.company || 'No company'}</p>
          </div>
          {canManageLeads && <RowActionsMenu actions={buildActions(l)} label={`Actions for ${l.name}`} />}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant={SOURCE_CONFIG[l.source].variant}>{SOURCE_CONFIG[l.source].label}</Badge>
        </div>

        {l.email && (
          <p className="mt-3 text-sm text-zinc-400 truncate">{l.email}</p>
        )}

        <div className="mt-3 flex items-center gap-2 text-sm">
          {budgetForLead(l.id)
            ? <span className="text-zinc-200 font-medium">{budgetForLead(l.id)}</span>
            : <span className="text-zinc-600 italic">No budget range</span>}
        </div>

        <div className="mt-3 flex items-center justify-between pt-3 border-t border-white/[0.06]">
          {members.length > 0
            ? <AvatarGroup users={members} max={3} size="xs" />
            : <span className="text-xs text-zinc-600 italic">No team</span>}
          <span className="text-xs text-zinc-500 whitespace-nowrap">Updated {formatTimeAgo(l.updated_at)}</span>
        </div>
      </div>
    );
  };

  const columns: Column<Lead>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 'w-[16%]',
      sortValue: (l) => l.name.toLowerCase(),
      render: (l) => (
        <Link
          href={`/leads/${l.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-semibold text-white hover:text-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
        >
          {l.name}
        </Link>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      width: 'w-[15%]',
      className: 'hidden sm:table-cell',
      sortValue: (l) => l.company.toLowerCase(),
      render: (l) => l.company
        ? <span className="text-zinc-300">{l.company}</span>
        : <span className="text-zinc-600 italic">No company</span>,
    },
    {
      key: 'source',
      header: 'Source',
      width: 'w-[11%]',
      className: 'hidden md:table-cell',
      render: (l) => <Badge variant={SOURCE_CONFIG[l.source].variant}>{SOURCE_CONFIG[l.source].label}</Badge>,
    },
    {
      key: 'email',
      header: 'Email',
      width: 'w-[18%]',
      className: 'hidden lg:table-cell',
      render: (l) => l.email
        ? <span className="text-zinc-300 truncate block">{l.email}</span>
        : <span className="text-zinc-600 italic">No email</span>,
    },
    {
      key: 'budget',
      header: 'Budget',
      width: 'w-[12%]',
      className: 'hidden sm:table-cell',
      sortValue: (l) => {
        const b = budgetForLead(l.id);
        return b ? BUDGET_OPTIONS.indexOf(b) : -1;
      },
      render: (l) => {
        const b = budgetForLead(l.id);
        return b
          ? <span className="text-zinc-200">{b}</span>
          : <span className="text-zinc-600 italic">—</span>;
      },
    },
    {
      key: 'team',
      header: 'Team',
      width: 'w-[8%]',
      className: 'hidden xl:table-cell',
      render: (l) => {
        const members = (l.member_ids || []).map(id => getTeamMember(id)).filter(Boolean) as { id: string; name: string; avatar?: string }[];
        return members.length > 0
          ? <AvatarGroup users={members} max={3} size="xs" />
          : <span className="text-zinc-600 italic text-xs">—</span>;
      },
    },
    {
      key: 'updated',
      header: 'Updated',
      align: 'right',
      width: 'w-[10%]',
      className: 'hidden lg:table-cell',
      sortValue: (l) => new Date(l.updated_at).getTime(),
      render: (l) => <span className="text-xs text-zinc-500 whitespace-nowrap">{formatTimeAgo(l.updated_at)}</span>,
    },
    ...(canManageLeads ? [{
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right' as const,
      width: 'w-12',
      render: (l: Lead) => <RowActionsMenu actions={buildActions(l)} label={`Actions for ${l.name}`} />,
    }] : []),
  ];

  const renderSection = (key: string, label: string, dotColor: string | undefined, rows: Lead[]) => (
    <section key={key}>
      <SectionHeader label={label} count={rows.length} dotColor={dotColor} />
      <DataTable
        columns={columns}
        data={rows}
        keyExtractor={(l) => l.id}
        onRowClick={(l) => router.push(`/leads/${l.id}`)}
        stickyHeader={false}
        fixedLayout
        mobileCard={mobileCard}
      />
    </section>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Leads"
        subtitle={<span className="hidden sm:inline">{activeLeads.length} active leads</span>}
        searchPlaceholder="Search leads by name, company, or email..."
        actions={canManageLeads ? (
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add Lead
          </Button>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-6">
        {leads.length === 0 ? (
          <div className="text-center py-16 glass-card rounded-xl">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/[0.06] flex items-center justify-center">
              <Target className="text-zinc-500" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">No leads yet</h3>
            <p className="text-zinc-400 mb-4">{canManageLeads ? 'Add your first lead to start building your pipeline' : 'No leads are available to you'}</p>
            {canManageLeads && <Button onClick={() => setIsFormOpen(true)}>Add Lead</Button>}
          </div>
        ) : (
          <>
            {PIPELINE_STAGES.map((stage) => {
              const rows = filtered.filter(l => l.status === stage.status);
              if (rows.length === 0) return null;
              return renderSection(stage.status, stage.label, undefined, rows);
            })}

            {wonLeads.length > 0 && renderSection('won', 'Won', '#34d399', wonLeads)}
            {lostLeads.length > 0 && renderSection('lost', 'Lost', '#f87171', lostLeads)}
          </>
        )}
      </div>

      {canManageLeads && <LeadForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        lead={editingLead}
        onConvertRequested={(lead) => setConvertingLead(lead)}
      />}

      {canManageLeads && <ConvertLeadModal
        isOpen={!!convertingLead}
        onClose={() => setConvertingLead(null)}
        lead={convertingLead}
      />}

      <ConfirmDialog
        isOpen={!!deletingLeadId}
        onClose={() => setDeletingLeadId(null)}
        onConfirm={executeDelete}
        title="Delete Lead"
        message="This will permanently delete this lead. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
