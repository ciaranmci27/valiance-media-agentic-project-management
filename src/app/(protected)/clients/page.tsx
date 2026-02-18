'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ClientCard } from '@/components/clients/ClientCard';
import { ClientForm } from '@/components/clients/ClientForm';
import { Button } from '@/components/ui/Button';
import { Plus, Building2 } from 'lucide-react';
import { Client } from '@/lib/types';
import { toast } from '@/components/ui/Toast';

export default function ClientsPage() {
  const { clients, deleteClient } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<Client | null>(null);

  const handleEdit = (client: Client) => {
    setEditingClient(client);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    if (confirm('Are you sure you want to delete this client?')) {
      deleteClient(id);
      toast('success', 'Client deleted');
    }
  };

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingClient(null);
  };

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Clients"
        subtitle={`${clients.length} clients`}
        actions={
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add Client
          </Button>
        }
      />

      <div className="p-4 lg:p-6">
        {clients.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <Building2 className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">No clients yet</h3>
            <p className="text-zinc-500 mb-4">Add a client or convert a lead to get started</p>
            <Button onClick={() => setIsFormOpen(true)}>
              Add Client
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {clients.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      <ClientForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        client={editingClient}
      />
    </div>
  );
}
