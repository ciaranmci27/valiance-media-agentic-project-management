'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MoreVertical, Edit, Trash2, Mail, Phone, FolderKanban } from 'lucide-react';
import { Client } from '@/lib/types';
import { useApp } from '@/lib/store';

interface ClientCardProps {
  client: Client;
  onEdit?: (client: Client) => void;
  onDelete?: (id: string) => void;
}

export function ClientCard({ client, onEdit, onDelete }: ClientCardProps) {
  const { getProjectsByClient } = useApp();
  const [showMenu, setShowMenu] = useState(false);

  const linkedProjects = getProjectsByClient(client.id);

  return (
    <div className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 lg:gap-3 min-w-0 flex-1">
          <div
            className="w-2.5 lg:w-3 h-2.5 lg:h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: client.color }}
          />
          <div className="min-w-0 flex-1">
            <Link
              href={`/clients/${client.id}`}
              className="font-semibold text-zinc-900 hover:text-indigo-600 transition-colors block truncate text-sm lg:text-base"
            >
              {client.name}
            </Link>
            {client.company && (
              <p className="text-xs lg:text-sm text-zinc-500 truncate">{client.company}</p>
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
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[140px]">
                <button
                  onClick={() => { onEdit?.(client); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={() => { onDelete?.(client.id); setShowMenu(false); }}
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
        {client.email && (
          <div className="flex items-center gap-1.5">
            <Mail size={14} className="flex-shrink-0" />
            <span className="truncate">{client.email}</span>
          </div>
        )}
        {client.phone && (
          <div className="flex items-center gap-1.5">
            <Phone size={14} className="flex-shrink-0" />
            <span>{client.phone}</span>
          </div>
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
