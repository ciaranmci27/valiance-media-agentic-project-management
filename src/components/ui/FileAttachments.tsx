'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Upload, Download, Trash2, Pencil, File, FileText, Image, Archive, Globe, Paperclip, Eye, MoreHorizontal, Share2, ShieldOff } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/components/ui/Toast';
import { Tooltip } from '@/components/ui/Tooltip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { NewNoteModal } from '@/components/ui/NewNoteModal';
import type { EntityFileType, EntityFile } from '@/lib/types';

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
  const { getEntityFiles, addEntityFile, renameEntityFile, deleteEntityFile, updateEntityFileVisibility } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();

  const [uploading, setUploading] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState('');
  const [deleteFileTarget, setDeleteFileTarget] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, openAbove: false });
  const [previewFile, setPreviewFile] = useState<EntityFile | null>(null);
  const [showNewNote, setShowNewNote] = useState(false);
  const [noteEditMode, setNoteEditMode] = useState<{ initialFileName: string; initialContent: string; fileId: string } | undefined>(undefined);

  const renameCancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  const files = getEntityFiles(entityType, entityId);
  const isProject = entityType === 'project';

  const updateMenuPosition = useCallback(() => {
    if (!openMenuId || !triggerRefs.current[openMenuId]) return;
    const rect = triggerRefs.current[openMenuId]!.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const menuHeight = 240;
    const openAbove = spaceBelow < menuHeight + 8 && rect.top > spaceBelow;
    setMenuPos({
      top: openAbove ? rect.top - 4 : rect.bottom + 4,
      left: rect.right - 192,
      openAbove,
    });
  }, [openMenuId]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!openMenuId) return;
    updateMenuPosition();
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [openMenuId, updateMenuPosition]);

  // Close menu on click outside
  useEffect(() => {
    if (!openMenuId) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRefs.current[openMenuId] && !triggerRefs.current[openMenuId]!.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuId]);

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
        visibility: 'internal',
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
        visibility: 'internal',
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
    setOpenMenuId(null);
  };

  const executeDeleteFile = () => {
    if (deleteFileTarget) {
      deleteEntityFile(deleteFileTarget);
      toast('success', 'File removed');
    }
  };

  const handleToggleVisibility = (fileId: string, currentVisibility: string) => {
    const newVisibility = currentVisibility === 'external' ? 'internal' : 'external';
    updateEntityFileVisibility(fileId, newVisibility);
    toast('success', newVisibility === 'external' ? 'File shared to portal' : 'File removed from portal');
  };

  const handleDownload = async (fileUrl: string, fileName: string) => {
    setOpenMenuId(null);
    try {
      const res = await fetch(fileUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast('error', 'Failed to download file');
    }
  };

  const handleCreateNote = async (fileName: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const oldVisibility = noteEditMode ? files.find(f => f.id === noteEditMode.fileId)?.visibility : undefined;

    if (isDemoMode) {
      // Demo mode: safe to delete first since addEntityFile can't fail
      if (noteEditMode?.fileId) deleteEntityFile(noteEditMode.fileId);
      addEntityFile({
        entity_type: entityType,
        entity_id: entityId,
        name: fileName,
        file_url: '#',
        file_size: blob.size,
        mime_type: mimeType,
        visibility: oldVisibility || 'internal',
        uploaded_by: teamMemberId,
      });
      toast('success', noteEditMode ? 'Note updated' : 'Note created');
      setNoteEditMode(undefined);
      return;
    }

    try {
      const supabase = createClient();
      const storagePath = `${entityType}/${entityId}/${Date.now()}-${fileName}`;
      const { error: uploadError } = await supabase.storage
        .from('entity-files')
        .upload(storagePath, blob, { contentType: mimeType });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('entity-files')
        .getPublicUrl(storagePath);

      // Delete old file only after new one is successfully uploaded
      if (noteEditMode?.fileId) deleteEntityFile(noteEditMode.fileId);

      addEntityFile({
        entity_type: entityType,
        entity_id: entityId,
        name: fileName,
        file_url: urlData.publicUrl,
        file_size: blob.size,
        mime_type: mimeType,
        visibility: oldVisibility || 'internal',
        uploaded_by: teamMemberId,
      });
      toast('success', noteEditMode ? 'Note updated' : 'Note created');
    } catch {
      toast('error', 'Failed to save note');
      throw new Error('Failed to save note');
    } finally {
      setNoteEditMode(undefined);
    }
  };

  const handleEditNote = async (file: { name: string; file_url: string; mime_type: string }) => {
    setPreviewFile(null);
    // Fetch content for editing
    if (file.file_url !== '#') {
      try {
        const res = await fetch(file.file_url);
        const text = await res.text();
        const entityFile = files.find(f => f.file_url === file.file_url);
        setNoteEditMode({
          initialFileName: file.name,
          initialContent: text,
          fileId: entityFile?.id || '',
        });
        setShowNewNote(true);
      } catch {
        toast('error', 'Failed to load note for editing');
      }
    } else {
      // Demo mode file, open with empty content
      const entityFile = files.find(f => f.name === file.name);
      setNoteEditMode({
        initialFileName: file.name,
        initialContent: '',
        fileId: entityFile?.id || '',
      });
      setShowNewNote(true);
    }
  };

  const currentMenuFile = openMenuId ? files.find(f => f.id === openMenuId) : null;

  return (
    <>
      <div className="bg-white rounded-xl border border-zinc-200 flex flex-col max-h-[600px]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Paperclip size={18} className="text-zinc-500" />
            <h2 className="font-semibold text-zinc-900">
              Files ({files.length})
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setNoteEditMode(undefined); setShowNewNote(true); }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors"
            >
              <FileText size={14} />
              Note
            </button>
            <label className="cursor-pointer">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileUpload}
                disabled={uploading}
              />
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors cursor-pointer">
                <Upload size={14} />
                <span className="hidden min-[400px]:inline">{uploading ? 'Uploading...' : 'Upload'}</span>
              </span>
            </label>
          </div>
        </div>

        {files.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {files.map(file => {
              const FileIcon = getFileIcon(file.mime_type);
              const isEditing = editingFileId === file.id;
              const isExternal = file.visibility === 'external';
              const isMenuOpen = openMenuId === file.id;
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 hover:bg-zinc-100 transition-colors group"
                >
                  <div className="w-8 h-8 rounded-lg bg-white border border-zinc-200 flex items-center justify-center flex-shrink-0">
                    <FileIcon size={14} className="text-zinc-400" />
                  </div>
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
                        className="text-sm text-zinc-700 bg-white border border-brand-300 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-brand-100 min-w-0 w-full"
                      />
                    ) : (
                      <p className="text-sm text-zinc-700 truncate">
                        {file.name}
                      </p>
                    )}
                    <p className="text-xs text-zinc-400">{formatFileSize(file.file_size)} &middot; {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                  </div>
                  {!isEditing && isProject && (
                    <Tooltip content={isExternal ? 'Shared on portal (click to remove)' : 'Share to portal'}>
                      <button
                        onClick={() => handleToggleVisibility(file.id, file.visibility)}
                        className={`p-1.5 rounded-md transition-all ${
                          isExternal
                            ? 'text-white bg-brand-500 hover:bg-brand-600'
                            : 'text-zinc-300 hover:text-brand-500 hover:bg-brand-50 opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        <Globe size={14} />
                      </button>
                    </Tooltip>
                  )}
                  {!isEditing && (
                    <button
                      ref={el => { triggerRefs.current[file.id] = el; }}
                      onClick={() => setOpenMenuId(isMenuOpen ? null : file.id)}
                      className="p-1.5 text-zinc-300 hover:text-zinc-600 opacity-0 group-hover:opacity-100 data-[open]:opacity-100 transition-all rounded-md hover:bg-zinc-200"
                      data-open={isMenuOpen || undefined}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
              <Paperclip size={18} className="text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-500">No files attached yet</p>
            <p className="text-xs text-zinc-400 mt-1">Upload files to attach them to this project</p>
          </div>
        )}
      </div>

      {/* Portalled context menu */}
      {openMenuId && currentMenuFile && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] w-48 bg-white border border-zinc-200 rounded-lg shadow-lg py-1"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            transform: menuPos.openAbove ? 'translateY(-100%)' : undefined,
          }}
        >
          <button
            onClick={() => { setPreviewFile(currentMenuFile); setOpenMenuId(null); }}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <Eye size={14} className="text-zinc-400" />
            Preview
          </button>
          <button
            onClick={() => handleDownload(currentMenuFile.file_url, currentMenuFile.name)}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <Download size={14} className="text-zinc-400" />
            Download
          </button>
          <button
            onClick={() => { setEditingFileId(currentMenuFile.id); setEditingFileName(currentMenuFile.name); setOpenMenuId(null); }}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <Pencil size={14} className="text-zinc-400" />
            Rename
          </button>
          {isProject && (
            <>
              <div className="border-t border-zinc-100 my-1" />
              <button
                onClick={() => { handleToggleVisibility(currentMenuFile.id, currentMenuFile.visibility); setOpenMenuId(null); }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                {currentMenuFile.visibility === 'external' ? (
                  <>
                    <ShieldOff size={14} className="text-zinc-400" />
                    Remove from Portal
                  </>
                ) : (
                  <>
                    <Share2 size={14} className="text-zinc-400" />
                    Share to Portal
                  </>
                )}
              </button>
            </>
          )}
          <div className="border-t border-zinc-100 my-1" />
          <button
            onClick={() => handleDeleteFile(currentMenuFile.id)}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>,
        document.body
      )}

      <ConfirmDialog
        isOpen={!!deleteFileTarget}
        onClose={() => setDeleteFileTarget(null)}
        onConfirm={executeDeleteFile}
        title="Delete File"
        message="Are you sure you want to remove this file?"
        confirmLabel="Delete"
        variant="danger"
      />

      <FilePreviewModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
        onEdit={handleEditNote}
      />

      <NewNoteModal
        isOpen={showNewNote}
        onClose={() => { setShowNewNote(false); setNoteEditMode(undefined); }}
        onSave={handleCreateNote}
        editMode={noteEditMode}
      />
    </>
  );
}
