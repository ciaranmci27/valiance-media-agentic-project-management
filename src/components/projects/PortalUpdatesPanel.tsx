'use client';

import { useState, useRef } from 'react';
import { MessageSquarePlus, Plus, Pencil, Trash2, X, Paperclip, Image, FileText, File, Loader2, Eye, Download, Globe } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import type { PortalUpdate, PortalUpdateType, PortalUpdateAttachment } from '@/lib/types';

interface PortalUpdatesPanelProps {
  projectId: string;
}

interface PendingFile {
  id: string;
  file: globalThis.File;
  name: string;
  mime_type: string;
  file_size: number;
}

const TYPE_CONFIG: Record<PortalUpdateType, { label: string; bg: string; text: string; dot: string }> = {
  milestone: { label: 'Milestone', bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  deliverable: { label: 'Deliverable', bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  note: { label: 'Note', bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  general: { label: 'General', bg: 'bg-zinc-100', text: 'text-zinc-600', dot: 'bg-zinc-400' },
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAttachmentIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType === 'text/html') return Globe;
  if (mimeType === 'application/pdf') return FileText;
  return File;
}

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

function AttachmentChips({ attachments, onRemove }: { attachments: PortalUpdateAttachment[]; onRemove?: (id: string) => void }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter(a => a.mime_type.startsWith('image/'));
  const files = attachments.filter(a => !a.mime_type.startsWith('image/'));

  const downloadFile = async (url: string, name: string) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = blobUrl;
      el.download = name;
      document.body.appendChild(el);
      el.click();
      el.remove();
      URL.revokeObjectURL(blobUrl);
    } catch { /* silent */ }
  };

  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map(a => (
            <div key={a.id} className="relative group/att">
              {a.file_url !== '#' ? (
                <img src={a.file_url} alt={a.name} className="h-16 w-auto rounded-md border border-zinc-200 object-cover" />
              ) : (
                <div className="h-16 w-20 rounded-md border border-zinc-200 bg-zinc-100 flex items-center justify-center">
                  <Image size={16} className="text-zinc-400" />
                </div>
              )}
              {onRemove ? (
                <button
                  onClick={() => onRemove(a.id)}
                  className="absolute -top-1.5 -right-1.5 p-0.5 bg-white border border-zinc-200 rounded-full text-zinc-400 hover:text-red-500 shadow-sm opacity-0 group-hover/att:opacity-100 transition-opacity"
                >
                  <X size={10} />
                </button>
              ) : a.file_url !== '#' && (
                <div className="absolute inset-0 rounded-md bg-black/0 group-hover/att:bg-black/40 transition-colors flex items-center justify-center gap-1 opacity-0 group-hover/att:opacity-100">
                  <Tooltip content="Preview">
                    <button
                      onClick={() => window.open(a.file_url, '_blank', 'noopener,noreferrer')}
                      className="p-1 bg-white/90 rounded text-zinc-700 hover:bg-white transition-colors"
                    >
                      <Eye size={11} />
                    </button>
                  </Tooltip>
                  <Tooltip content="Download">
                    <button
                      onClick={() => downloadFile(a.file_url, a.name)}
                      className="p-1 bg-white/90 rounded text-zinc-700 hover:bg-white transition-colors"
                    >
                      <Download size={11} />
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map(a => {
            const isHtml = a.mime_type === 'text/html';
            const Icon = getAttachmentIcon(a.mime_type);
            return (
              <span key={a.id} className="inline-flex items-center gap-1.5 px-2 py-1 text-xs bg-zinc-100 text-zinc-600 rounded-md group/att">
                <Icon size={12} className="text-zinc-400" />
                <span className="max-w-[120px] truncate">{a.name}</span>
                <span className="text-zinc-400">{formatFileSize(a.file_size)}</span>
                {onRemove ? (
                  <button
                    onClick={() => onRemove(a.id)}
                    className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
                  >
                    <X size={10} />
                  </button>
                ) : (
                  <>
                    {a.file_url !== '#' && (
                      <Tooltip content="Preview">
                        <button
                          onClick={() => window.open(a.file_url, '_blank', 'noopener,noreferrer')}
                          className="p-0.5 text-zinc-400 hover:text-brand-600 transition-colors"
                        >
                          <Eye size={11} />
                        </button>
                      </Tooltip>
                    )}
                    {!isHtml && a.file_url !== '#' && (
                      <Tooltip content="Download">
                        <button
                          onClick={() => downloadFile(a.file_url, a.name)}
                          className="p-0.5 text-zinc-400 hover:text-brand-600 transition-colors"
                        >
                          <Download size={11} />
                        </button>
                      </Tooltip>
                    )}
                  </>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PendingFileChips({ files, onRemove }: { files: PendingFile[]; onRemove: (id: string) => void }) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map(f => {
        const isImage = f.mime_type.startsWith('image/');
        const Icon = getAttachmentIcon(f.mime_type);
        return (
          <span key={f.id} className="inline-flex items-center gap-1.5 px-2 py-1 text-xs bg-zinc-100 text-zinc-600 rounded-md">
            {isImage ? <Image size={12} className="text-violet-400" /> : <Icon size={12} className="text-zinc-400" />}
            <span className="max-w-[120px] truncate">{f.name}</span>
            <span className="text-zinc-400">{formatFileSize(f.file_size)}</span>
            <button
              onClick={() => onRemove(f.id)}
              className="p-0.5 text-zinc-400 hover:text-red-500 transition-colors"
            >
              <X size={10} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function PortalUpdatesPanel({ projectId }: PortalUpdatesPanelProps) {
  const { getPortalUpdates, addPortalUpdate, updatePortalUpdate, deletePortalUpdate, getTeamMember, getPortalSettings, getPortalUpdateAttachments } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();

  const portalSettings = getPortalSettings(projectId);
  const isPortalEnabled = portalSettings?.enabled ?? false;
  const updates = getPortalUpdates(projectId);

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [updateType, setUpdateType] = useState<PortalUpdateType>('general');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  // Edit-mode attachment state
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState<string[]>([]);
  const [editPendingFiles, setEditPendingFiles] = useState<PendingFile[]>([]);

  const addFileRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setTitle('');
    setContent('');
    setUpdateType('general');
    setPendingFiles([]);
    setRemovedAttachmentIds([]);
    setEditPendingFiles([]);
  };

  const handleFilePick = (files: FileList | null, target: 'add' | 'edit') => {
    if (!files) return;
    const newPending: PendingFile[] = Array.from(files).map(f => ({
      id: crypto.randomUUID(),
      file: f,
      name: f.name,
      mime_type: f.type || 'application/octet-stream',
      file_size: f.size,
    }));
    if (target === 'add') {
      setPendingFiles(prev => [...prev, ...newPending]);
    } else {
      setEditPendingFiles(prev => [...prev, ...newPending]);
    }
  };

  const uploadFiles = async (files: PendingFile[]): Promise<{ name: string; file_url: string; file_size: number; mime_type: string }[]> => {
    if (files.length === 0) return [];

    if (isDemoMode) {
      return files.map(f => ({
        name: f.name,
        file_url: '#',
        file_size: f.file_size,
        mime_type: f.mime_type,
      }));
    }

    const supabase = createClient();
    const results: { name: string; file_url: string; file_size: number; mime_type: string }[] = [];

    for (const f of files) {
      const path = `updates/${projectId}/${Date.now()}-${f.name}`;
      const { error: uploadError } = await supabase.storage
        .from('portal-files')
        .upload(path, f.file);

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('portal-files')
        .getPublicUrl(path);

      results.push({
        name: f.name,
        file_url: urlData.publicUrl,
        file_size: f.file_size,
        mime_type: f.mime_type,
      });
    }

    return results;
  };

  const handleAdd = async () => {
    if (!title.trim()) return;
    setUploading(true);

    try {
      const uploaded = await uploadFiles(pendingFiles);

      addPortalUpdate(
        {
          project_id: projectId,
          title: title.trim(),
          content: content.trim(),
          update_type: updateType,
          author_id: teamMemberId,
          pinned: false,
        },
        uploaded.length > 0 ? uploaded : undefined,
      );
      resetForm();
      setIsAdding(false);
      toast('success', 'Update posted');
    } catch {
      toast('error', 'Failed to upload files');
    } finally {
      setUploading(false);
    }
  };

  const handleStartEdit = (update: PortalUpdate) => {
    setEditingId(update.id);
    setTitle(update.title);
    setContent(update.content);
    setUpdateType(update.update_type);
    setRemovedAttachmentIds([]);
    setEditPendingFiles([]);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !title.trim()) return;
    setUploading(true);

    try {
      const uploaded = await uploadFiles(editPendingFiles);

      updatePortalUpdate(
        editingId,
        {
          title: title.trim(),
          content: content.trim(),
          update_type: updateType,
        },
        uploaded.length > 0 ? uploaded : undefined,
        removedAttachmentIds.length > 0 ? removedAttachmentIds : undefined,
      );
      resetForm();
      setEditingId(null);
      toast('success', 'Update saved');
    } catch {
      toast('error', 'Failed to upload files');
    } finally {
      setUploading(false);
    }
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

  const renderAttachFileButton = (inputRef: React.RefObject<HTMLInputElement | null>, target: 'add' | 'edit') => (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => { handleFilePick(e.target.files, target); if (inputRef.current) inputRef.current.value = ''; }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg transition-colors"
      >
        <Paperclip size={12} />
        Attach
      </button>
    </>
  );

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header */}
      <div className={`px-5 py-4 flex items-center justify-between flex-shrink-0 ${isPortalEnabled ? 'border-b border-zinc-100' : ''}`}>
        <div className="flex items-center gap-2">
          <MessageSquarePlus size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">
            Portal Updates
            {updates.length > 0 && (
              <span className="ml-1.5 text-xs font-medium text-zinc-400">({updates.length})</span>
            )}
          </h2>
        </div>
        {isPortalEnabled && (
          <button
            onClick={() => setIsAdding(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
          >
            <Plus size={14} />
            Add
          </button>
        )}
      </div>

      {isPortalEnabled ? (
      <div className="flex-1 flex flex-col overflow-y-auto">
          {/* Add form */}
          {isAdding && !editingId && (
            <div className="mx-5 mt-5 border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3">
              <div className="flex gap-2">
                <TextInput
                  autoFocus
                  value={title}
                  onChange={setTitle}
                  placeholder="Update title"
                  size="sm"
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
                    size="sm"
                  />
                </div>
              </div>
              <Textarea
                value={content}
                onChange={setContent}
                placeholder="Add details (optional)"
                rows={3}
                size="sm"
              />
              {/* Pending files */}
              <PendingFileChips files={pendingFiles} onRemove={id => setPendingFiles(f => f.filter(p => p.id !== id))} />
              <div className="flex items-center gap-2 justify-between">
                {renderAttachFileButton(addFileRef, 'add')}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCancelEdit}
                    className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAdd}
                    disabled={!title.trim() || uploading}
                    className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  >
                    {uploading && <Loader2 size={14} className="animate-spin" />}
                    Post
                  </button>
                </div>
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
                const attachments = getPortalUpdateAttachments(update.id);

                if (isEditing) {
                  const visibleExisting = attachments.filter(a => !removedAttachmentIds.includes(a.id));

                  return (
                    <div key={update.id} className="border border-brand-200 bg-brand-50/30 rounded-lg p-4 space-y-3">
                      <div className="flex gap-2">
                        <TextInput
                          autoFocus
                          value={title}
                          onChange={setTitle}
                          size="sm"
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
                            size="sm"
                          />
                        </div>
                      </div>
                      <Textarea
                        value={content}
                        onChange={setContent}
                        rows={3}
                        size="sm"
                      />
                      {/* Existing attachments (removable) */}
                      <AttachmentChips attachments={visibleExisting} onRemove={id => setRemovedAttachmentIds(prev => [...prev, id])} />
                      {/* Newly picked files */}
                      <PendingFileChips files={editPendingFiles} onRemove={id => setEditPendingFiles(f => f.filter(p => p.id !== id))} />
                      <div className="flex items-center gap-2 justify-between">
                        {renderAttachFileButton(editFileRef, 'edit')}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleCancelEdit}
                            className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveEdit}
                            disabled={!title.trim() || uploading}
                            className="px-4 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                          >
                            {uploading && <Loader2 size={14} className="animate-spin" />}
                            Save
                          </button>
                        </div>
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
                      {/* Read-only attachments */}
                      <AttachmentChips attachments={attachments} />
                      <p className="text-xs text-zinc-400 mt-1">
                        {author?.name || 'Team'} &middot; {timeAgo(update.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <Tooltip content="Edit">
                        <button
                          onClick={() => handleStartEdit(update)}
                          className="p-1.5 text-zinc-400 hover:text-brand-600 transition-colors"
                        >
                          <Pencil size={14} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete">
                        <button
                          onClick={() => setDeleteTarget(update.id)}
                          className="p-1.5 text-zinc-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </Tooltip>
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
