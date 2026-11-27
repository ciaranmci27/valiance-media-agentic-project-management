'use client';

import { useUndoTrash } from '@/components/projects/useUndoTrash';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ContactForm } from '@/components/contacts/ContactForm';
import { ExtraEmails } from '@/components/contacts/ContactCard';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ShowMore, SHOW_MORE_STEP } from '@/components/ui/ShowMore';
import { Avatar } from '@/components/ui/Avatar';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { Plus, UserCircle, Edit, Trash2, Phone, Mail } from 'lucide-react';
import { Contact } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { formatPhone } from '@/lib/format-phone';

export default function ContactsPage() {
  const router = useRouter();
  const { contacts, contactEmails, deleteContact, filters, setFilters } = useApp();
  const { access } = useAuth();
  const canManageContacts = hasPermission(access, 'contacts.manage');
  // Converting a lead makes a contact too, so the empty state offers it while Leads is on.
  const canConvertLeads = hasPermission(access, 'leads.manage');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const undoTrash = useUndoTrash();
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setIsFormOpen(true);
  };

  // Moving to Trash acts at once, with Undo (DESIGN.md Rule 6).
  const trashContact = async (id: string) => {
    if (await deleteContact(id)) undoTrash('contacts', id, { message: 'Contact moved to Trash' });
  };

  const searchLower = filters.search.toLowerCase();
  // Contacts with any address (primary or not) that matches the search.
  const emailMatches = filters.search
    ? new Set(contactEmails.filter(row => row.email.includes(searchLower)).map(row => row.contact_id))
    : null;
  const filtered = filters.search
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(searchLower) ||
        c.company.toLowerCase().includes(searchLower) ||
        c.email.toLowerCase().includes(searchLower) ||
        emailMatches?.has(c.id))
    : contacts;

  const handleCloseForm = () => {
    setIsFormOpen(false);
    setEditingContact(null);
  };

  const buildActions = (c: Contact): RowAction[] => [
    { label: 'Edit', icon: <Edit size={14} />, onClick: () => handleEdit(c) },
    { label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger', onClick: () => void trashContact(c.id) },
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
          {c.phone ? formatPhone(c.phone) : <span className="text-zinc-600">-</span>}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <Mail size={14} className="text-zinc-500 flex-shrink-0" />
          <span className={c.email ? 'truncate' : 'text-zinc-600'}>{c.email || '-'}</span>
          <ExtraEmails contactId={c.id} primaryEmail={c.email} />
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
        : <span className="text-zinc-600">-</span>,
    },
    {
      key: 'phone',
      header: 'Phone',
      className: 'hidden lg:table-cell',
      render: (c) => (
        <span className="flex items-center gap-1.5 text-zinc-300">
          <Phone size={14} className="text-zinc-500 flex-shrink-0" />
          {c.phone ? formatPhone(c.phone) : <span className="text-zinc-600">-</span>}
        </span>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (c) => (
        <span className="flex items-center gap-1.5 text-zinc-300 min-w-0">
          <Mail size={14} className="text-zinc-500 flex-shrink-0" />
          <span className={c.email ? 'truncate' : 'text-zinc-600'}>{c.email || '-'}</span>
          <ExtraEmails contactId={c.id} primaryEmail={c.email} />
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
        subtitle={<span className="hidden sm:inline">{contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}</span>}
        searchPlaceholder="Search contacts"
        actions={canManageContacts ? (
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add contact
          </Button>
        ) : undefined}
      />

      <div className="p-4 lg:p-6">
        {contacts.length === 0 ? (
          <EmptyState
            framed
            icon={<UserCircle />}
            title="No contacts yet"
            description={!canManageContacts ? 'No contacts are shared with you yet.' : canConvertLeads ? 'Add a contact, or convert a lead when it is won.' : 'Add the people you work with.'}
            action={canManageContacts ? <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setIsFormOpen(true)}>Add contact</Button> : undefined}
          />
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
            <ShowMore
              shown={Math.min(visibleCount, filtered.length)}
              total={filtered.length}
              step={SHOW_MORE_STEP}
              onMore={() => setVisibleCount(prev => prev + SHOW_MORE_STEP)}
              noun="contacts"
            />
          </>
        )}
      </div>

      {canManageContacts && <ContactForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        contact={editingContact}
      />}
    </div>
  );
}
