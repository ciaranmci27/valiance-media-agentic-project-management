'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreVertical, Edit, Trash2, ArrowRightCircle, DollarSign, Percent, Phone, Mail, Clock } from 'lucide-react';
import { Lead } from '@/lib/types';
import { useApp } from '@/lib/store';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';

const SOURCE_CONFIG: Record<Lead['source'], { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
  referral: { label: 'Referral', variant: 'success' },
  website: { label: 'Website', variant: 'info' },
  social: { label: 'Social', variant: 'purple' },
  cold_outreach: { label: 'Cold Outreach', variant: 'warning' },
  event: { label: 'Event', variant: 'default' },
  network: { label: 'Network', variant: 'info' },
  other: { label: 'Other', variant: 'default' },
};

const STATUS_CONFIG: Record<Lead['status'], { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' }> = {
  new: { label: 'New', variant: 'info' },
  contacted: { label: 'Contacted', variant: 'purple' },
  qualified: { label: 'Qualified', variant: 'warning' },
  proposal: { label: 'Proposal', variant: 'default' },
  won: { label: 'Won', variant: 'success' },
  lost: { label: 'Lost', variant: 'danger' },
};

interface LeadCardProps {
  lead: Lead;
  onEdit?: (lead: Lead) => void;
  onDelete?: (id: string) => void;
  onConvert?: (lead: Lead) => void;
}

export function LeadCard({ lead, onEdit, onDelete, onConvert }: LeadCardProps) {
  const { getTeamMember } = useApp();
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);

  const members = (lead.member_ids || []).map(id => getTeamMember(id)).filter(Boolean);
  const sourceConfig = SOURCE_CONFIG[lead.source];
  const statusConfig = STATUS_CONFIG[lead.status];
  const canConvert = lead.status !== 'won' && lead.status !== 'lost';

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(value);
  };

  const formatTimeAgo = (dateStr: string) => {
    const now = Date.now();
    const diff = now - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-5 hover:shadow-lg hover:border-zinc-300 transition-all duration-200 group cursor-pointer"
      onClick={() => router.push(`/leads/${lead.id}`)}
    >
      {/* Name + Company */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-zinc-900 truncate text-sm lg:text-base">{lead.name}</h3>
          <p className={`text-xs lg:text-sm truncate ${lead.company ? 'text-zinc-500' : 'text-zinc-300 italic'}`}>
            {lead.company || 'No company'}
          </p>
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
              <div className="absolute right-0 top-10 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[160px] cursor-pointer">
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit?.(lead); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                {canConvert && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onConvert?.(lead); setShowMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50"
                  >
                    <ArrowRightCircle size={14} />
                    Convert
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete?.(lead.id); setShowMenu(false); }}
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

      {/* Source + Status badges */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge variant={sourceConfig.variant}>{sourceConfig.label}</Badge>
        <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
      </div>

      {/* Phone + Email */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4 mb-3 text-xs lg:text-sm text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Phone size={14} className="flex-shrink-0" />
          <span className={!lead.phone ? 'text-zinc-300 italic' : ''}>
            {lead.phone || 'No phone'}
          </span>
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <Mail size={14} className="flex-shrink-0" />
          <span className={lead.email ? 'truncate' : 'text-zinc-300 italic'}>
            {lead.email || 'No email'}
          </span>
        </span>
      </div>

      {/* Value + Equity */}
      <div className="flex items-center gap-3 text-sm font-medium mb-3">
        <span className={`flex items-center gap-1 ${lead.value != null ? 'text-zinc-700' : 'text-zinc-300 italic font-normal'}`}>
          <DollarSign size={14} className={lead.value != null ? 'text-emerald-500' : 'text-zinc-300'} />
          {lead.value != null ? formatCurrency(lead.value) : 'No value'}
        </span>
        <span className={`flex items-center gap-1 ${lead.equity != null ? 'text-zinc-700' : 'text-zinc-300 italic font-normal'}`}>
          <Percent size={14} className={lead.equity != null ? 'text-indigo-500' : 'text-zinc-300'} />
          {lead.equity != null ? `${lead.equity}%` : 'No equity'}
        </span>
      </div>

      {/* Footer: Avatars + Updated time */}
      <div className="flex items-center justify-between pt-3 border-t border-zinc-100">
        {members.length > 0 ? (
          <div className="flex -space-x-1.5">
            {members.map(m => m && (
              <Avatar key={m.id} name={m.name} size="xs" />
            ))}
          </div>
        ) : (
          <span className="text-xs text-zinc-300 italic">No team</span>
        )}
        <span className="flex items-center gap-1 text-xs text-zinc-400">
          <Clock size={12} />
          Updated {formatTimeAgo(lead.updated_at)}
        </span>
      </div>
    </div>
  );
}
