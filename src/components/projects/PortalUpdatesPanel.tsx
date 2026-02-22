'use client';

import { useState } from 'react';
import { MessageSquarePlus, Plus, Pencil, Trash2, X } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { PortalUpdate, PortalUpdateType } from '@/lib/types';

interface PortalUpdatesPanelProps {
  projectId: string;
}

const TYPE_CONFIG: Record<PortalUpdateType, { label: string; bg: string; text: string; dot: string }> = {
  milestone: { label: 'Milestone', bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  deliverable: { label: 'Deliverable', bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  note: { label: 'Note', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  general: { label: 'General', bg: 'bg-zinc-100', text: 'text-zinc-600', dot: 'bg-zinc-400' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PortalUpdatesPanel({ projectId }: PortalUpdatesPanelProps) {
  const { getPortalUpdates, addPortalUpdate, updatePortalUpdate, deletePortalUpdate, getTeamMember, getPortalSettings } = useApp();
  const { teamMemberId } = useAuth();

  const portalSettings = getPortalSettings(projectId);
  const isPortalEnabled = portalSettings?.enabled ?? false;
  const updates = getPortalUpdates(projectId);

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [updateType, setUpdateType] = useState<PortalUpdateType>('general');

  const resetForm = () => {
    setTitle('');
    setContent('');
    setUpdateType('general');
  };

  const handleAdd = () => {
    if (!title.trim()) return;
    addPortalUpdate({
      project_id: projectId,
      title: title.trim(),
      content: content.trim(),
      update_type: updateType,
      author_id: teamMemberId,
      pinned: false,
    });
    resetForm();
    setIsAdding(false);
    toast('success', 'Update posted');
  };

  const handleStartEdit = (update: PortalUpdate) => {
    setEditingId(update.id);
    setTitle(update.title);
    setContent(update.content);
    setUpdateType(update.update_type);
  };

  const handleSaveEdit = () => {
    if (!editingId || !title.trim()) return;
    updatePortalUpdate(editingId, {
      title: title.trim(),
      content: content.trim(),
      update_type: updateType,
    });
    resetForm();
    setEditingId(null);
    toast('success', 'Update saved');
  };

  const handleCancelEdit = () => {
    resetForm();
    setEditingId(null);
    setIsAdding(false);
  };

  const executeDelete = () => {
    if (deleteTarget) {
      deletePortalUpdate(deleteTarget);
      toast('success', 'Update deleted');
    }
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header */}
      <div className={`px-5 py-4 flex items-center justify-between flex-shrink-0 ${isPortalEnabled ? 'border-b border-zinc-100' : ''}`}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-brand-50 rounded-md">
            <MessageSquarePlus size={16} className="text-brand-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">
              Portal Updates
              {updates.length > 0 && (
                <span className="ml-1.5 text-xs font-medium text-zinc-400">({updates.length})</span>
              )}
            </h3>
            <p className="text-xs text-zinc-500">Timeline updates visible to your client</p>
          </div>
        </div>
        {isPortalEnabled && (
          <button
            onClick={() => setIsAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            <Plus size={14} />
            Add Update
          </button>
        )}
      </div>

      {isPortalEnabled ? (
      <div className="flex-1 flex flex-col overflow-y-auto">
          {/* Add form */}
          {isAdding && !editingId && (
            <div className="mx-5 mt-5 border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3">
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Update title"
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
                />
                <div className="w-[140px] flex-shrink-0">
                  <Select
                    value={updateType}
                    onChange={v => setUpdateType(v as PortalUpdateType)}
                    options={[
                      { value: 'general', label: 'General' },
                      { value: 'milestone', label: 'Milestone' },
                      { value: 'deliverable', label: 'Deliverable' },
                      { value: 'note', label: 'Note' },
                    ]}
                  />
                </div>
              </div>
              <textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder="Add details (optional)"
                rows={3}
                className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
              />
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={handleCancelEdit}
                  className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!title.trim()}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Post
                </button>
              </div>
            </div>
          )}

          {/* Updates list */}
          {updates.length > 0 ? (
            <div className="p-5 space-y-2">
              {updates.map(update => {
                const config = TYPE_CONFIG[update.update_type];
                const author = update.author_id ? getTeamMember(update.author_id) : null;
                const isEditing = editingId === update.id;

                if (isEditing) {
                  return (
                    <div key={update.id} className="border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3">
                      <div className="flex gap-2">
                        <input
                          autoFocus
                          type="text"
                          value={title}
                          onChange={e => setTitle(e.target.value)}
                          className="flex-1 min-w-0 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all"
                        />
                        <div className="w-[140px] flex-shrink-0">
                          <Select
                            value={updateType}
                            onChange={v => setUpdateType(v as PortalUpdateType)}
                            options={[
                              { value: 'general', label: 'General' },
                              { value: 'milestone', label: 'Milestone' },
                              { value: 'deliverable', label: 'Deliverable' },
                              { value: 'note', label: 'Note' },
                            ]}
                          />
                        </div>
                      </div>
                      <textarea
                        value={content}
                        onChange={e => setContent(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-all resize-none"
                      />
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={handleCancelEdit}
                          className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveEdit}
                          disabled={!title.trim()}
                          className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={update.id}
                    className="flex items-start gap-3 px-4 py-3.5 bg-zinc-50 rounded-lg group"
                  >
                    <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${config.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <p className="text-sm font-semibold text-zinc-900">{update.title}</p>
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded ${config.bg} ${config.text}`}>
                          {config.label}
                        </span>
                      </div>
                      {update.content && (
                        <p className="text-sm text-zinc-500 leading-relaxed line-clamp-2">{update.content}</p>
                      )}
                      <p className="text-xs text-zinc-400 mt-1">
                        {author?.name || 'Team'} &middot; {timeAgo(update.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        onClick={() => handleStartEdit(update)}
                        className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(update.id)}
                        className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !isAdding ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                <MessageSquarePlus size={18} className="text-zinc-400" />
              </div>
              <p className="text-sm font-medium text-zinc-500">No updates yet</p>
              <p className="text-xs text-zinc-400 mt-1">Post one to keep your client informed</p>
            </div>
          ) : null}
      </div>
      ) : null}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={executeDelete}
        title="Delete Update"
        message="Are you sure you want to delete this update? This will remove it from the client portal."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
