'use client';

import React, { useState, useRef } from 'react';
import { Upload, Trash2, Pencil, File, FileText, Image, Archive, Globe, Paperclip } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { EntityFileType } from '@/lib/types';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType === 'text/html') return Globe;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('zip') || mimeType.includes('archive')) return Archive;
  return File;
}

interface FileAttachmentsProps {
  entityType: EntityFileType;
  entityId: string;
}

export function FileAttachments({ entityType, entityId }: FileAttachmentsProps) {
  const { getEntityFiles, addEntityFile, renameEntityFile, deleteEntityFile } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();

  const [uploading, setUploading] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState('');
  const [deleteFileTarget, setDeleteFileTarget] = useState<string | null>(null);
  const renameCancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const files = getEntityFiles(entityType, entityId);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const file = fileList[0];
    if (file.size > 50 * 1024 * 1024) {
      toast('error', 'File must be under 50MB');
      return;
    }

    setUploading(true);

    if (isDemoMode) {
      addEntityFile({
        entity_type: entityType,
        entity_id: entityId,
        name: file.name,
        file_url: '#',
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        uploaded_by: teamMemberId,
      });
      setUploading(false);
      toast('success', 'File added');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    try {
      const supabase = createClient();
      const fileName = `${entityType}/${entityId}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from('entity-files')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('entity-files')
        .getPublicUrl(fileName);

      addEntityFile({
        entity_type: entityType,
        entity_id: entityId,
        name: file.name,
        file_url: urlData.publicUrl,
        file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        uploaded_by: teamMemberId,
      });

      toast('success', 'File uploaded');
    } catch (err) {
      toast('error', 'Failed to upload file');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteFile = (fileId: string) => {
    setDeleteFileTarget(fileId);
  };

  const executeDeleteFile = () => {
    if (deleteFileTarget) {
      deleteEntityFile(deleteFileTarget);
      toast('success', 'File removed');
    }
  };

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Paperclip size={18} className="text-zinc-500" />
            <h2 className="font-semibold text-zinc-900">
              Files ({files.length})
            </h2>
          </div>
          <label className="cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
              disabled={uploading}
            />
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors cursor-pointer">
              <Upload size={14} />
              {uploading ? 'Uploading...' : 'Upload'}
            </span>
          </label>
        </div>

        {files.length > 0 ? (
          <div className="bg-white rounded-xl border border-zinc-200 divide-y divide-zinc-100">
            {files.map(file => {
              const FileIcon = getFileIcon(file.mime_type);
              const isEditing = editingFileId === file.id;
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-4 py-3 group"
                >
                  <FileIcon size={16} className="text-zinc-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        type="text"
                        value={editingFileName}
                        onChange={e => setEditingFileName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === 'Escape') {
                            renameCancelledRef.current = true;
                            setEditingFileId(null);
                          }
                        }}
                        onBlur={() => {
                          if (renameCancelledRef.current) {
                            renameCancelledRef.current = false;
                            return;
                          }
                          const trimmed = editingFileName.trim();
                          if (trimmed && trimmed !== file.name) {
                            renameEntityFile(file.id, trimmed);
                            toast('success', 'File renamed');
                          }
                          setEditingFileId(null);
                        }}
                        className="text-sm text-zinc-700 bg-white border border-indigo-300 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-indigo-100 min-w-0 w-full"
                      />
                    ) : (
                      <p
                        className="text-sm text-zinc-700 truncate cursor-pointer hover:text-zinc-900"
                        onClick={() => { setEditingFileId(file.id); setEditingFileName(file.name); }}
                        title="Click to rename"
                      >
                        {file.name}
                      </p>
                    )}
                    <p className="text-xs text-zinc-400">{formatFileSize(file.file_size)}</p>
                  </div>
                  {!isEditing && (
                    <button
                      onClick={() => { setEditingFileId(file.id); setEditingFileName(file.name); }}
                      className="p-1.5 text-zinc-300 hover:text-indigo-500 opacity-0 group-hover:opacity-100 transition-all"
                      title="Rename file"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteFile(file.id)}
                    className="p-1.5 text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                    title="Remove file"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-zinc-200 p-8 text-center text-zinc-500">
            <Paperclip className="mx-auto mb-2" size={24} />
            <p>No files attached yet</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!deleteFileTarget}
        onClose={() => setDeleteFileTarget(null)}
        onConfirm={executeDeleteFile}
        title="Delete File"
        message="Are you sure you want to remove this file?"
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
