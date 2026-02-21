'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Edit, Trash2, Mail, Phone, FolderKanban, Target } from 'lucide-react';
import { Contact } from '@/lib/types';
import { useApp } from '@/lib/store';
import { Avatar } from '@/components/ui/Avatar';

interface ContactCardProps {
  contact: Contact;
  onEdit?: (contact: Contact) => void;
  onDelete?: (id: string) => void;
}

export function ContactCard({ contact, onEdit, onDelete }: ContactCardProps) {
  const { getProjectsByContact, leads } = useApp();
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);

  const linkedProjects = getProjectsByContact(contact.id);
  const linkedLeads = leads.filter(l => l.contact_id === contact.id);

  return (
    <div
      className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group cursor-pointer"
      onClick={() => router.push(`/contacts/${contact.id}`)}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
          <Avatar name={contact.name} src={contact.avatar_url || undefined} size="sm" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-zinc-900 group-hover:text-brand-600 transition-colors block truncate text-sm lg:text-base">
              {contact.name}
            </span>
            {contact.company && (
              <p className="text-xs lg:text-sm text-zinc-500 truncate">{contact.company}</p>
            )}
          </div>
        </div>

        <div className="relative flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
          >
            <MoreVertical size={16} />
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
              <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px] cursor-pointer">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit?.(contact); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete?.(contact.id); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 mb-3 text-xs lg:text-sm text-zinc-500">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <Phone size={14} className="flex-shrink-0" />
          <span className={!contact.phone ? 'text-zinc-300 italic' : ''}>
            {contact.phone || 'No phone'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <Mail size={14} className="flex-shrink-0" />
          <span className={contact.email ? 'truncate' : 'text-zinc-300 italic'}>
            {contact.email || 'No email'}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-3 pt-3 border-t border-zinc-100 text-xs lg:text-sm text-zinc-500">
        <div className="flex items-center gap-1">
          <FolderKanban size={14} />
          <span>{linkedProjects.length} project{linkedProjects.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-1">
          <Target size={14} />
          <span>{linkedLeads.length} lead{linkedLeads.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}
