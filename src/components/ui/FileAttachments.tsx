'use client';
import { FileInput } from '@/components/ui/inputs/FileInput';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload,
  Download,
  Trash2,
  Pencil,
  File,
  FileText,
  Image,
  Archive,
  Globe,
  Paperclip,
  Eye,
  MoreHorizontal,
  Share2,
  ShieldOff,
} from 'lucide-react';
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
import { hasPermission } from '@/lib/access-control';
import { EmptyCard, NoMatches, SubNav, TabToolbar, ToolbarButton } from '@/components/projects/TabLayout';

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
  /** 'list' (default): a compact card for a detail page's side panel.
   *  'grid': a whole tab of its own, with a toolbar and thumbnail cards. */
  layout?: 'list' | 'grid';
}

export function FileAttachments({ entityType, entityId, layout = 'list' }: FileAttachmentsProps) {
  const {
    getEntityFiles,
    addEntityFile,
    renameEntityFile,
    replaceEntityFileContent,
    deleteEntityFile,
    updateEntityFileVisibility,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const canUpload = hasPermission(access, 'files.upload');
  const canManageFiles = hasPermission(access, 'files.manage');
  const canDeleteFile = (file: EntityFile) =>
    canManageFiles || (file.uploaded_by === teamMemberId && file.visibility === 'internal');
  const { isDemoMode } = useDemo();

  const [uploading, setUploading] = useState(false);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState('');
  const [deleteFileTarget, setDeleteFileTarget] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, openAbove: false });
  const [previewFile, setPreviewFile] = useState<EntityFile | null>(null);
  const [gridQuery, setGridQuery] = useState('');
  const [gridKind, setGridKind] = useState<'all' | 'images' | 'docs' | 'portal'>('all');
  const [showNewNote, setShowNewNote] = useState(false);
  const [noteEditMode, setNoteEditMode] = useState<
    { initialFileName: string; initialContent: string; fileId: string } | undefined
  >(undefined);

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
        triggerRefs.current[openMenuId] &&
        !triggerRefs.current[openMenuId]!.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
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

      const { data: urlData } = supabase.storage.from('entity-files').getPublicUrl(fileName);

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
    toast(
      'success',
      newVisibility === 'external' ? 'File shared to portal' : 'File removed from portal',
    );
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

  // Throws on failure so NewNoteModal stays open with the draft intact; every
  // failure path has already told the user.
  const handleCreateNote = async (fileName: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const editingId = noteEditMode?.fileId;

    let fileUrl = '#';
    let storagePath: string | null = null;
    const supabase = isDemoMode ? null : createClient();
    if (supabase) {
      storagePath = `${entityType}/${entityId}/${Date.now()}-${fileName}`;
      const { error: uploadError } = await supabase.storage
        .from('entity-files')
        .upload(storagePath, blob, { contentType: mimeType });
      if (uploadError) {
        toast('error', 'Failed to save note');
        throw uploadError;
      }
      fileUrl = supabase.storage.from('entity-files').getPublicUrl(storagePath).data.publicUrl;
    }

    // An edit updates the existing row in place: nothing is removed until the
    // new content is saved, and the note keeps its id and visibility.
    const noteContent = { name: fileName, file_url: fileUrl, file_size: blob.size, mime_type: mimeType };
    const saved = editingId
      ? await replaceEntityFileContent(editingId, noteContent)
      : await addEntityFile({
          ...noteContent,
          entity_type: entityType,
          entity_id: entityId,
          visibility: 'internal',
          uploaded_by: teamMemberId,
        });

    if (!saved) {
      // The row never pointed at this upload; do not leave it behind.
      if (supabase && storagePath) {
        supabase.storage.from('entity-files').remove([storagePath]).then(() => {}, () => {});
      }
      throw new Error('Failed to save note');
    }

    toast('success', editingId ? 'Note updated' : 'Note created');
    setNoteEditMode(undefined);
  };

  const handleEditNote = async (file: { name: string; file_url: string; mime_type: string }) => {
    setPreviewFile(null);
    // Fetch content for editing
    if (file.file_url !== '#') {
      try {
        const res = await fetch(file.file_url);
        const text = await res.text();
        const entityFile = files.find((f) => f.file_url === file.file_url);
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
      const entityFile = files.find((f) => f.name === file.name);
      setNoteEditMode({
        initialFileName: file.name,
        initialContent: '',
        fileId: entityFile?.id || '',
      });
      setShowNewNote(true);
    }
  };

  const currentMenuFile = openMenuId ? files.find((f) => f.id === openMenuId) : null;

  const renameInput = (file: EntityFile) => (
    <input
      autoFocus
      type="text"
      aria-label="File name"
      value={editingFileName}
      onChange={(e) => setEditingFileName(e.target.value)}
      onKeyDown={(e) => {
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
      className="text-sm text-zinc-300 bg-surface-raised border border-brand-500/30 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-brand-500/30 min-w-0 w-full"
    />
  );

  const menuTrigger = (file: EntityFile, className: string) => (
    <button
      ref={(el) => {
        triggerRefs.current[file.id] = el;
      }}
      type="button"
      aria-label={`Actions for ${file.name}`}
      aria-haspopup="menu"
      aria-expanded={openMenuId === file.id}
      onClick={() => setOpenMenuId(openMenuId === file.id ? null : file.id)}
      className={className}
      data-open={openMenuId === file.id || undefined}
    >
      <MoreHorizontal size={16} />
    </button>
  );

  const fileInput = (
    <FileInput ref={fileInputRef} className="hidden" onChange={handleFileUpload} disabled={uploading} />
  );

  const newNote = () => {
    setNoteEditMode(undefined);
    setShowNewNote(true);
  };

  // ── Grid: the Files tab ──
  const isImage = (file: EntityFile) => file.mime_type.startsWith('image/');
  const matchesKind = (file: EntityFile) =>
    gridKind === 'all'
      ? true
      : gridKind === 'images'
        ? isImage(file)
        : gridKind === 'portal'
          ? file.visibility === 'external'
          : !isImage(file);
  const query = gridQuery.trim().toLowerCase();
  const gridFiles = files.filter((f) => matchesKind(f) && (!query || f.name.toLowerCase().includes(query)));
  const kindCounts = {
    all: files.length,
    images: files.filter(isImage).length,
    docs: files.filter((f) => !isImage(f)).length,
    portal: files.filter((f) => f.visibility === 'external').length,
  };

  const gridBody = (
    <>
      <TabToolbar
        search={files.length > 0 ? { value: gridQuery, onChange: setGridQuery, placeholder: 'Search files' } : undefined}
        filters={
          files.length > 0 && (
            <SubNav
              label="Show files"
              active={gridKind}
              onChange={setGridKind}
              items={[
                { key: 'all', label: 'All', count: kindCounts.all },
                { key: 'images', label: 'Images', count: kindCounts.images },
                { key: 'docs', label: 'Documents', count: kindCounts.docs },
                ...(isProject ? [{ key: 'portal' as const, label: 'On portal', count: kindCounts.portal }] : []),
              ]}
            />
          )
        }
        actions={
          canUpload && (
            <>
              {fileInput}
              <ToolbarButton variant="secondary" icon={<FileText />} label="New note" onClick={newNote} />
            </>
          )
        }
        primary={
          canUpload && (
            <ToolbarButton
              icon={<Upload />}
              label={uploading ? 'Uploading' : 'Upload'}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            />
          )
        }
      />

      {files.length === 0 ? (
        <EmptyCard
          icon={<Paperclip />}
          title="No files yet"
          description={canUpload ? 'Upload files or write a note to keep them with this project.' : 'No files are available for this project.'}
        />
      ) : gridFiles.length === 0 ? (
        <div className="glass-card rounded-xl"><NoMatches>No files match.</NoMatches></div>
      ) : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4">
          {gridFiles.map((file) => {
            const FileIcon = getFileIcon(file.mime_type);
            const showThumb = isImage(file) && file.file_url && file.file_url !== '#';
            const isExternal = file.visibility === 'external';
            return (
              <li key={file.id} className="group glass-card rounded-xl overflow-hidden flex flex-col min-w-0">
                <button
                  type="button"
                  onClick={() => setPreviewFile(file)}
                  aria-label={`Preview ${file.name}`}
                  className="relative aspect-[4/3] bg-white/[0.03] flex items-center justify-center overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                >
                  {showThumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={file.file_url}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                    />
                  ) : (
                    <FileIcon size={28} className="text-zinc-500" aria-hidden="true" />
                  )}
                  {isExternal && (
                    <span className="absolute top-2 left-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] font-medium text-white">
                      <Globe size={10} aria-hidden="true" />
                      On portal
                    </span>
                  )}
                </button>
                <div className="flex items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    {editingFileId === file.id ? renameInput(file) : (
                      <p className="text-sm text-zinc-200 truncate" title={file.name}>{file.name}</p>
                    )}
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {formatFileSize(file.file_size)} ·{' '}
                      {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  {editingFileId !== file.id &&
                    menuTrigger(
                      file,
                      'p-1 -mr-1 text-zinc-500 hover:text-zinc-200 rounded-md hover:bg-white/[0.08] transition-all flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  const listBody = (
      <div className="glass-card rounded-xl flex flex-col max-h-[600px]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Paperclip size={18} className="text-zinc-400" />
            <h2 className="font-semibold text-white">Files ({files.length})</h2>
          </div>
          {canUpload && (
            <div className="flex items-center gap-2">
              <button
                onClick={newNote}
                className="liquid-glass inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors"
              >
                <FileText size={14} />
                Note
              </button>
              <label className="cursor-pointer">
                {fileInput}
                <span className="liquid-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white rounded-lg transition-colors cursor-pointer">
                  <Upload size={14} />
                  <span className="hidden min-[400px]:inline">
                    {uploading ? 'Uploading...' : 'Upload'}
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

        {files.length > 0 ? (
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {files.map((file) => {
              const FileIcon = getFileIcon(file.mime_type);
              const isEditing = editingFileId === file.id;
              const isExternal = file.visibility === 'external';
              return (
                <div
                  key={file.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors group"
                >
                  <div className="w-8 h-8 rounded-lg bg-surface-raised border border-white/[0.08] flex items-center justify-center flex-shrink-0">
                    <FileIcon size={14} className="text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {isEditing ? renameInput(file) : (
                      <p className="text-sm text-zinc-300 truncate">{file.name}</p>
                    )}
                    <p className="text-xs text-zinc-500">
                      {formatFileSize(file.file_size)} &middot;{' '}
                      {new Date(file.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  {!isEditing && isProject && canManageFiles && (
                    <Tooltip
                      content={
                        isExternal ? 'Shared on portal (click to remove)' : 'Share to portal'
                      }
                    >
                      <button
                        onClick={() => handleToggleVisibility(file.id, file.visibility)}
                        className={`p-1.5 rounded-md transition-all ${
                          isExternal
                            ? 'text-white bg-brand-500 hover:bg-brand-600'
                            : 'text-zinc-600 hover:text-brand-500 hover:bg-brand-500/15 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100'
                        }`}
                      >
                        <Globe size={14} />
                      </button>
                    </Tooltip>
                  )}
                  {!isEditing &&
                    menuTrigger(
                      file,
                      'p-1.5 text-zinc-600 hover:text-zinc-300 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 data-[open]:opacity-100 transition-all rounded-md hover:bg-white/[0.08]',
                    )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <Paperclip size={18} className="text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-400">No files attached yet</p>
            <p className="text-xs text-zinc-500 mt-1">
              {canUpload
                ? 'Upload files to attach them to this project'
                : 'No files are available for this project'}
            </p>
          </div>
        )}
      </div>
  );

  return (
    <>
      {layout === 'grid' ? gridBody : listBody}

      {/* Portalled context menu */}
      {openMenuId &&
        currentMenuFile &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] w-48 bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg py-1"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              transform: menuPos.openAbove ? 'translateY(-100%)' : undefined,
            }}
          >
            <button
              onClick={() => {
                setPreviewFile(currentMenuFile);
                setOpenMenuId(null);
              }}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.03] transition-colors"
            >
              <Eye size={14} className="text-zinc-500" />
              Preview
            </button>
            <button
              onClick={() => handleDownload(currentMenuFile.file_url, currentMenuFile.name)}
              className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.03] transition-colors"
            >
              <Download size={14} className="text-zinc-500" />
              Download
            </button>
            {canManageFiles && (
              <button
                onClick={() => {
                  setEditingFileId(currentMenuFile.id);
                  setEditingFileName(currentMenuFile.name);
                  setOpenMenuId(null);
                }}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.03] transition-colors"
              >
                <Pencil size={14} className="text-zinc-500" />
                Rename
              </button>
            )}
            {isProject && canManageFiles && (
              <>
                <div className="border-t border-white/[0.06] my-1" />
                <button
                  onClick={() => {
                    handleToggleVisibility(currentMenuFile.id, currentMenuFile.visibility);
                    setOpenMenuId(null);
                  }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.03] transition-colors"
                >
                  {currentMenuFile.visibility === 'external' ? (
                    <>
                      <ShieldOff size={14} className="text-zinc-500" />
                      Remove from Portal
                    </>
                  ) : (
                    <>
                      <Share2 size={14} className="text-zinc-500" />
                      Share to Portal
                    </>
                  )}
                </button>
              </>
            )}
            {canDeleteFile(currentMenuFile) && (
              <>
                <div className="border-t border-white/[0.06] my-1" />
                <button
                  onClick={() => handleDeleteFile(currentMenuFile.id)}
                  className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-red-400 hover:bg-red-500/15 transition-colors"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </>
            )}
          </div>,
          document.body,
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
        onClose={() => {
          setShowNewNote(false);
          setNoteEditMode(undefined);
        }}
        onSave={handleCreateNote}
        editMode={noteEditMode}
      />
    </>
  );
}
