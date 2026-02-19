'use client';

import { useState, useEffect } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { LeadCard } from '@/components/leads/LeadCard';
import { LeadForm } from '@/components/leads/LeadForm';
import { ConvertLeadModal } from '@/components/leads/ConvertLeadModal';
import { Button } from '@/components/ui/Button';
import { Plus, Target, DollarSign } from 'lucide-react';
import { Lead } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

const PIPELINE_STAGES: { status: Lead['status']; label: string }[] = [
  { status: 'new', label: 'New' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'qualified', label: 'Qualified' },
  { status: 'proposal', label: 'Proposal' },
];

export default function LeadsPage() {
  const { leads, deleteLead, filters, setFilters } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [convertingLead, setConvertingLead] = useState<Lead | null>(null);
  const [deletingLeadId, setDeletingLeadId] = useState<string | null>(null);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const handleEdit = (lead: Lead) => {
    setEditingLead(lead);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    setDeletingLeadId(id);
  };

  const executeDelete = () => {
    if (!deletingLeadId) return;
    deleteLead(deletingLeadId);
    toast('success', 'Lead deleted');
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

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);

  const totalPipelineValue = leads
    .filter(l => l.status !== 'won' && l.status !== 'lost')
    .reduce((sum, l) => sum + (l.value || 0), 0);

  const getStageValue = (status: Lead['status']) =>
    filtered.filter(l => l.status === status).reduce((sum, l) => sum + (l.value || 0), 0);

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Leads"
        subtitle={<span className="hidden sm:inline">{activeLeads.length} active leads</span>}
        searchPlaceholder="Search leads by name, company, or email..."
        actions={
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add Lead
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-6 lg:space-y-8">
        {leads.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <Target className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">No leads yet</h3>
            <p className="text-zinc-500 mb-4">Add your first lead to start building your pipeline</p>
            <Button onClick={() => setIsFormOpen(true)}>
              Add Lead
            </Button>
          </div>
        ) : (
          <>
            {/* Active pipeline stages */}
            {PIPELINE_STAGES.map((stage) => {
              const stageLeads = filtered.filter(l => l.status === stage.status);
              if (stageLeads.length === 0) return null;

              return (
                <section key={stage.status}>
                  <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                    {stage.label} ({stageLeads.length})
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                    {stageLeads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onConvert={setConvertingLead}
                      />
                    ))}
                  </div>
                </section>
              );
            })}

            {/* Won leads */}
            {wonLeads.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-emerald-600 uppercase tracking-wider mb-4">
                  Won ({wonLeads.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {wonLeads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Lost leads */}
            {lostLeads.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-red-600 uppercase tracking-wider mb-4">
                  Lost ({lostLeads.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                  {lostLeads.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Pipeline Value */}
            {totalPipelineValue > 0 && (
              <div className="bg-white rounded-xl border border-zinc-200 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <DollarSign size={16} className="text-emerald-600" />
                  <span className="text-sm font-medium text-zinc-700">Pipeline Value</span>
                  <span className="text-lg font-bold text-zinc-900 ml-auto">{formatCurrency(totalPipelineValue)}</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {PIPELINE_STAGES.map((stage) => {
                    const val = getStageValue(stage.status);
                    return (
                      <div key={stage.status} className="text-center p-2 bg-zinc-50 rounded-lg">
                        <p className="text-xs text-zinc-500">{stage.label}</p>
                        <p className="text-sm font-semibold text-zinc-800">{val > 0 ? formatCurrency(val) : '$0'}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <LeadForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        lead={editingLead}
      />

      <ConvertLeadModal
        isOpen={!!convertingLead}
        onClose={() => setConvertingLead(null)}
        lead={convertingLead}
      />

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
