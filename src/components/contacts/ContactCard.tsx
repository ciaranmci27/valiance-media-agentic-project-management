'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Edit, Trash2, Mail, Phone } from 'lucide-react';
import { Contact } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApp } from '@/lib/store';
import { formatPhone } from '@/lib/format-phone';

/**
 * "+N" after a contact's primary email when they have more addresses. The
 * tooltip lists the others; screen readers get the same list as text.
 */
export function ExtraEmails({ contactId, primaryEmail }: { contactId: string; primaryEmail: string }) {
  const { getContactEmails } = useApp();
  const primary = primaryEmail.trim().toLowerCase();
  const others = getContactEmails(contactId).filter(row => row.email !== primary);
  if (!primary || others.length === 0) return null;

  const describe = (row: { email: string; label: string | null }) =>
    row.label ? `${row.email} (${row.label})` : row.email;

  return (
    <Tooltip
      className="flex-shrink-0"
      content={
        <span className="flex flex-col gap-0.5">
          {others.map(row => <span key={row.id}>{describe(row)}</span>)}
        </span>
      }
    >
      <span
        tabIndex={0}
        className="text-xs text-zinc-500 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span aria-hidden="true">+{others.length}</span>
        <span className="sr-only">
          {`${others.length} more email ${others.length === 1 ? 'address' : 'addresses'}: ${others.map(describe).join(', ')}`}
        </span>
      </span>
    </Tooltip>
  );
}

interface ContactCardProps {
  contact: Contact;
  onEdit?: (contact: Contact) => void;
  onDelete?: (id: string) => void;
}

export function ContactCard({ contact, onEdit, onDelete }: ContactCardProps) {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="glass-card-interactive rounded-xl p-4 lg:p-5 group cursor-pointer"
      onClick={() => router.push(`/contacts/${contact.id}`)}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
          <Avatar name={contact.name} src={contact.avatar_url || undefined} size="sm" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-white group-hover:text-brand-300 transition-colors block truncate text-sm lg:text-base">
              {contact.name}
            </span>
            {contact.company && (
              <p className="text-xs lg:text-sm text-zinc-400 truncate">{contact.company}</p>
            )}
          </div>
        </div>

        {(onEdit || onDelete) && <div ref={menuRef} className="relative flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="lg:opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-all"
          >
            <MoreVertical size={16} />
          </button>

          <Popover
            anchorRef={menuRef}
            open={showMenu}
            onClose={() => setShowMenu(false)}
            align="end"
            width={140}
            className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
          >
            <button
              onClick={(e) => { e.stopPropagation(); onEdit?.(contact); setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06]"
            >
              <Edit size={14} />
              Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete?.(contact.id); setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/15"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </Popover>
        </div>}
      </div>

      <div className="flex items-center gap-4 text-xs lg:text-sm text-zinc-400">
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <Phone size={14} className="flex-shrink-0" />
          <span className={!contact.phone ? 'text-zinc-600 italic' : ''}>
            {contact.phone ? formatPhone(contact.phone) : 'No phone'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <Mail size={14} className="flex-shrink-0" />
          <span className={contact.email ? 'truncate' : 'text-zinc-600 italic'}>
            {contact.email || 'No email'}
          </span>
          <ExtraEmails contactId={contact.id} primaryEmail={contact.email} />
        </span>
      </div>

    </div>
  );
}
