'use client';

import { useState, useEffect } from 'react';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { ContactCard } from '@/components/contacts/ContactCard';
import { ContactForm } from '@/components/contacts/ContactForm';
import { Button } from '@/components/ui/Button';
import { Plus, UserCircle } from 'lucide-react';
import { Contact } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

export default function ContactsPage() {
  const { contacts, deleteContact, filters, setFilters } = useApp();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deletingContactId, setDeletingContactId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);

  useEffect(() => { setFilters(defaultFilters); }, []);

  const handleEdit = (contact: Contact) => {
    setEditingContact(contact);
    setIsFormOpen(true);
  };

  const handleDelete = (id: string) => {
    setDeletingContactId(id);
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

  return (
    <div className="animate-fadeIn min-h-screen bg-zinc-50">
      <Header
        title="Contacts"
        subtitle={<span className="hidden sm:inline">{contacts.length} contacts</span>}
        searchPlaceholder="Search contacts by name, company, or email..."
        actions={
          <Button onClick={() => setIsFormOpen(true)} icon={<Plus size={16} />}>
            Add Contact
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-4">
        {contacts.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-xl border border-zinc-200">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
              <UserCircle className="text-zinc-400" size={32} />
            </div>
            <h3 className="text-lg font-semibold text-zinc-900 mb-2">No contacts yet</h3>
            <p className="text-zinc-500 mb-4">Add a contact or convert a lead to get started</p>
            <Button onClick={() => setIsFormOpen(true)}>
              Add Contact
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.slice(0, visibleCount).map((contact) => (
                <ContactCard
                  key={contact.id}
                  contact={contact}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              ))}
            </div>
            {filtered.length > visibleCount && (
              <div className="text-center pt-2">
                <button
                  onClick={() => setVisibleCount(prev => prev + 20)}
                  className="text-sm text-brand-600 hover:text-brand-700 font-medium transition-colors"
                >
                  Show more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <ContactForm
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        contact={editingContact}
      />

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
