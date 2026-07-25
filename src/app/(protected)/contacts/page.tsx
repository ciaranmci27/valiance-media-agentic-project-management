'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ContactForm } from '@/components/contacts/ContactForm';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Plus, UserCircle, Edit, Trash2, Phone, Mail } from 'lucide-react';
import { Contact } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { formatPhone } from '@/lib/format-phone';

export default function ContactsPage() {
  const router = useRouter();
  const { contacts, deleteContact, filters, setFilters } = useApp();
  const { access } = useAuth();
  const canManageContacts = hasPermission(access, 'contacts.manage');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setIsFormOpen(true);
  };

  const executeDelete = () => {
    if (!deletingContactId) return;
    deleteContact(deletingContactId);
    toast('success', 'Contact deleted');
  };

  const searchLower = filters.search.toLowerCase();
  const filtered = filters.search
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(searchLower) ||
        c.company.toLowerCase().includes(searchLower) ||
        c.email.toLowerCase().includes(searchLower))
    : contacts;

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingContact(null);
  };

  const buildActions = (c: Contact): RowAction[] => [
    { label: 'Edit', icon: <Edit size={14} />, onClick: () => handleEdit(c) },
    { label: 'Delete', icon: <Trash2 size={14} />, variant: 'danger', onClick: () => setDeletingContactId(c.id) },
  ];

  const mobileCard = (c: Contact) => (
    <div className="glass-card rounded-xl p-4 hover:border-white/[0.12] transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={c.name} src={c.avatar_url || undefined} size="md" />
          <div className="min-w-0">
            <Link
              href={`/contacts/${c.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-semibold text-white block truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
            >
              {c.name}
            </Link>
            <p className={`text-sm truncate ${c.company ? 'text-zinc-400' : 'text-zinc-600 italic'}`}>{c.company || 'No company'}</p>
          </div>
        </div>
        {canManageContacts && <RowActionsMenu actions={buildActions(c)} label={`Actions for ${c.name}`} />}
      </div>
      <div className="mt-3 flex flex-col gap-1.5 text-sm text-zinc-400">
        <span className="flex items-center gap-2">
          <Phone size={14} className="text-zinc-500 flex-shrink-0" />
          {c.phone ? formatPhone(c.phone) : <span className="text-zinc-600 italic">No phone</span>}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <Mail size={14} className="text-zinc-500 flex-shrink-0" />
          <span className={c.email ? 'truncate' : 'text-zinc-600 italic'}>{c.email || 'No email'}</span>
        </span>
      </div>
    </div>
  );

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={c.name} src={c.avatar_url || undefined} size="sm" />
          <Link
            href={`/contacts/${c.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-semibold text-white hover:text-brand-300 transition-colors truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
          >
            {c.name}
          </Link>
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      sortValue: (c) => c.company.toLowerCase(),
      className: 'hidden sm:table-cell',
      render: (c) => c.company
        ? <span className="text-zinc-300">{c.company}</span>
        : <span className="text-zinc-600 italic">No company</span>,
    },
    {
      key: 'phone',
      header: 'Phone',
      className: 'hidden lg:table-cell',
      render: (c) => (
        <span className="flex items-center gap-1.5 text-zinc-300">
          <Phone size={14} className="text-zinc-500 flex-shrink-0" />
          {c.phone ? formatPhone(c.phone) : <span className="text-zinc-600 italic">No phone</span>}
        </span>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (c) => (
        <span className="flex items-center gap-1.5 text-zinc-300 min-w-0">
          <Mail size={14} className="text-zinc-500 flex-shrink-0" />
          <span className={c.email ? 'truncate' : 'text-zinc-600 italic'}>{c.email || 'No email'}</span>
        </span>
      ),
    },
    ...(canManageContacts ? [{
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right' as const,
      width: 'w-12',
      render: (c: Contact) => <RowActionsMenu actions={buildActions(c)} label={`Actions for ${c.name}`} />,
    }] : []),
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="Contacts"
        subtitle={<span className="hidden sm:inline">{contacts.length} contacts</span>}
        searchPlaceholder="Search contacts by name, company, or email..."
        actions={canManageContacts ? (
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add Contact
          </Button>
        ) : undefined}
      />

      <div className="p-4 lg:p-6 space-y-4">
        {contacts.length === 0 ? (
          <div className="text-center py-16 glass-card rounded-xl">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/[0.06] flex items-center justify-center">
              <UserCircle className="text-zinc-500" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">No contacts yet</h3>
            <p className="text-zinc-400 mb-4">{canManageContacts ? 'Add a contact or convert a lead to get started' : 'No contacts are available to you'}</p>
            {canManageContacts && <Button onClick={() => setIsFormOpen(true)}>Add Contact</Button>}
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={filtered.slice(0, visibleCount)}
              keyExtractor={(c) => c.id}
              onRowClick={(c) => router.push(`/contacts/${c.id}`)}
              initialSort={{ key: 'name', dir: 'asc' }}
              emptyState="No contacts match your search"
              mobileCard={mobileCard}
            />
            {filtered.length > visibleCount && (
              <div className="text-center pt-2">
                <button
                  onClick={() => setVisibleCount(prev => prev + 20)}
                  className="text-sm text-brand-300 hover:text-brand-300 font-medium transition-colors"
                >
                  Show more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {canManageContacts && <ContactForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        contact={editingContact}
      />}

      <ConfirmDialog
        isOpen={!!deletingContactId}
        onClose={() => setDeletingContactId(null)}
        onConfirm={executeDelete}
        title="Delete Contact"
        message="This will permanently delete this contact and remove them from all projects. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
