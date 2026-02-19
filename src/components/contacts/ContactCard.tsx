'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MoreVertical, Edit, Trash2, Mail, Phone, FolderKanban } from 'lucide-react';
import { Contact } from '@/lib/types';
import { useApp } from '@/lib/store';

interface ContactCardProps {
  contact: Contact;
  onEdit?: (contact: Contact) => void;
  onDelete?: (id: string) => void;
}

export function ContactCard({ contact, onEdit, onDelete }: ContactCardProps) {
  const { getProjectsByContact } = useApp();
  const [showMenu, setShowMenu] = useState(false);

  const linkedProjects = getProjectsByContact(contact.id);

  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
          <div
            className="w-2.5 lg:w-3 h-2.5 lg:h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: contact.color }}
          />
          <div className="min-w-0 flex-1">
            <Link
              href={`/contacts/${contact.id}`}
              className="font-semibold text-zinc-900 hover:text-indigo-600 transition-colors block truncate text-sm lg:text-base"
            >
              {contact.name}
            </Link>
            {contact.company && (
              <p className="text-xs lg:text-sm text-zinc-500 truncate">{contact.company}</p>
            )}
          </div>
        </div>

        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
          >
            <MoreVertical size={16} />
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
              <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px] cursor-pointer">
                <button
                  onClick={() => { onEdit?.(contact); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={() => { onDelete?.(contact.id); setShowMenu(false); }}
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

      <div className="space-y-1.5 mb-3 text-xs lg:text-sm text-zinc-500">
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 hover:text-indigo-600 transition-colors">
            <Mail size={14} className="flex-shrink-0" />
            <span className="truncate">{contact.email}</span>
          </a>
        )}
        {contact.phone && (
          <a href={`tel:${contact.phone}`} className="flex items-center gap-1.5 hover:text-indigo-600 transition-colors">
            <Phone size={14} className="flex-shrink-0" />
            <span>{contact.phone}</span>
          </a>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-zinc-100 text-xs lg:text-sm text-zinc-500">
        <div className="flex items-center gap-1">
          <FolderKanban size={14} />
          <span>{linkedProjects.length} project{linkedProjects.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}
