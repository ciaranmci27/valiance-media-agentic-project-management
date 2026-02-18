'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { LeadCard } from '@/components/leads/LeadCard';
import { LeadForm } from '@/components/leads/LeadForm';
import { ConvertLeadModal } from '@/components/leads/ConvertLeadModal';
import { Button } from '@/components/ui/Button';
import { Plus, Target } from 'lucide-react';
import { Lead } from '@/lib/types';
import { toast } from '@/components/ui/Toast';

const PIPELINE_STAGES: { status: Lead['status']; label: string }[] = [
  { status: 'new', label: 'New' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'qualified', label: 'Qualified' },
  { status: 'proposal', label: 'Proposal' },
];

export default function LeadsPage() {
  const { leads, deleteLead } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [convertingLead, setConvertingLead] = useState<Lead | null>(null);

  const handleEdit = (lead: Lead) => {
    setEditingLead(lead);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this lead?')) {
      deleteLead(id);
      toast('success', 'Lead deleted');
    }
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingLead(null);
  };

  const wonLeads = leads.filter(l => l.status === 'won');
  const lostLeads = leads.filter(l => l.status === 'lost');
  const activeLeads = leads.filter(l => l.status !== 'won' && l.status !== 'lost');

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Leads"
        subtitle={`${activeLeads.length} active leads`}
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
              const stageLeads = leads.filter(l => l.status === stage.status);
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
    </div>
  );
}
