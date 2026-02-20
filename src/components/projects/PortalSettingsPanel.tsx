'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Globe, Link2, RefreshCw, Copy, Check, Eye, EyeOff,
  Upload, Trash2, FileText, Image, Archive, File, ExternalLink,
  Camera, Loader2, X, Pencil, ChevronDown,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AvatarCropModal } from '@/components/ui/AvatarCropModal';
import { createClient } from '@/lib/supabase/client';

interface PortalSettingsPanelProps {
  projectId: string;
}

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

export function PortalSettingsPanel({ projectId }: PortalSettingsPanelProps) {
  const {
    getPortalSettings, getPortalFiles,
    upsertPortalSettings, regeneratePortalToken,
    addPortalFile, renamePortalFile, deletePortalFile,
    getProject,
  } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();

  const settings = getPortalSettings(projectId);
  const files = getPortalFiles(projectId);
  const project = getProject(projectId);

  const [copied, setCopied] = useState(false);
  const [copiedFileId, setCopiedFileId] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoCropFile, setLogoCropFile] = useState<File | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingFileName, setEditingFileName] = useState('');
  const [deleteFileTarget, setDeleteFileTarget] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const renameCancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Local state for text inputs to avoid writing to store on every keystroke
  const [localPin, setLocalPin] = useState(settings?.pin || '');
  const [localAccentColor, setLocalAccentColor] = useState(settings?.accent_color || '#6366F1');
  const [localWelcomeMessage, setLocalWelcomeMessage] = useState(settings?.welcome_message || '');

  // Sync local state when settings change externally
  useEffect(() => {
    setLocalPin(settings?.pin || '');
    setLocalAccentColor(settings?.accent_color || '#6366F1');
    setLocalWelcomeMessage(settings?.welcome_message || '');
  }, [settings?.pin, settings?.accent_color, settings?.welcome_message]);

  // Debounced save helper
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSettingChange = useCallback((key: string, value: any) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      upsertPortalSettings(projectId, { [key]: value });
    }, 500);
  }, [projectId, upsertPortalSettings]);

  const isEnabled = settings?.enabled ?? false;
  const portalUrl = settings?.token
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/portal/${settings.token}`
    : '';

  const handleToggleEnabled = () => {
    upsertPortalSettings(projectId, {
      enabled: !isEnabled,
      accent_color: project?.color || '#6366F1',
    });
  };

  const handleCopyLink = () => {
    if (!portalUrl) return;
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    toast('success', 'Portal link copied!');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerateToken = () => {
    if (!settings) return;
    regeneratePortalToken(projectId);
    toast('success', 'Portal link regenerated');
  };

  const handleSettingChange = (key: string, value: any) => {
    upsertPortalSettings(projectId, { [key]: value });
  };

  const handleLogoCropped = async (blob: Blob) => {
    setLogoCropFile(null);
    setUploadingLogo(true);

    if (isDemoMode) {
      const blobUrl = URL.createObjectURL(blob);
      handleSettingChange('logo_url', blobUrl);
      setUploadingLogo(false);
      toast('success', 'Logo updated');
      return;
    }

    try {
      const supabase = createClient();
      const isPng = blob.type === 'image/png';
      const ext = isPng ? 'png' : 'jpg';
      const path = `portal/${projectId}.${ext}`;
      // Remove the other format if it exists (switching between png/jpg)
      const oldPath = `portal/${projectId}.${isPng ? 'jpg' : 'png'}`;
      await supabase.storage.from('avatars').remove([oldPath]);
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType: blob.type });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(path);

      const url = `${publicUrl}?t=${Date.now()}`;
      handleSettingChange('logo_url', url);
      toast('success', 'Logo updated');
    } catch {
      toast('error', 'Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = () => {
    handleSettingChange('logo_url', '');
    toast('success', 'Logo removed');
  };

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
      // Demo mode: create a fake file entry
      addPortalFile({
        project_id: projectId,
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
      const fileName = `${projectId}/${Date.now()}-${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from('portal-files')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('portal-files')
        .getPublicUrl(fileName);

      addPortalFile({
        project_id: projectId,
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
      deletePortalFile(deleteFileTarget);
      toast('success', 'File removed');
    }
  };

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
      {/* Header with toggle */}
      <div
        onClick={() => isEnabled && setIsExpanded(e => !e)}
        className={`px-5 py-4 flex items-center justify-between ${isEnabled ? 'border-b border-zinc-100 cursor-pointer' : ''}`}
      >
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-indigo-50 rounded-md">
            <Globe size={16} className="text-indigo-600" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Client Portal</h3>
            <p className="text-xs text-zinc-500">Share project progress with your client</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isEnabled && (
            <ChevronDown
              size={16}
              className={`text-zinc-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
            />
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleToggleEnabled(); }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
              isEnabled ? 'bg-indigo-600' : 'bg-zinc-200'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                isEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {isEnabled && isExpanded && settings && (
        <div className="p-5 space-y-5">
          {/* Portal Logo + Link + PIN + Color */}
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Logo */}
            <div className="relative group flex-shrink-0">
              <div className="w-20 h-20 rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50 flex items-center justify-center">
                {settings.logo_url ? (
                  <img src={settings.logo_url} alt="Logo" className="w-full h-full object-cover" />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-white text-lg font-bold"
                    style={{ backgroundColor: settings.accent_color || '#6366F1' }}
                  >
                    {project?.name?.charAt(0) || 'P'}
                  </div>
                )}
              </div>
              {!uploadingLogo && (
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className="absolute inset-0 rounded-xl bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-all cursor-pointer"
                >
                  <Camera size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
              {uploadingLogo && (
                <div className="absolute inset-0 rounded-xl bg-black/40 flex items-center justify-center">
                  <Loader2 size={16} className="text-white animate-spin" />
                </div>
              )}
              {settings.logo_url && !uploadingLogo && (
                <button
                  type="button"
                  onClick={handleRemoveLogo}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                >
                  <X size={12} />
                </button>
              )}
              <input
                ref={logoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setLogoCropFile(file);
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />
            </div>

            {/* Link + PIN + Color */}
            <div className="flex-1 min-w-0 w-full space-y-3">
              {/* Portal Link */}
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-600 min-w-0">
                  <Link2 size={14} className="text-zinc-400 flex-shrink-0" />
                  <span className="truncate">{portalUrl}</span>
                </div>
                <button
                  onClick={handleCopyLink}
                  className="p-2 text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                </button>
                <button
                  onClick={handleRegenerateToken}
                  className="p-2 text-zinc-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                  title="Regenerate link"
                >
                  <RefreshCw size={16} />
                </button>
              </div>

              {/* PIN + Accent Color */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="relative">
                  <input
                    type={showPin ? 'text' : 'password'}
                    value={localPin}
                    onChange={e => {
                      setLocalPin(e.target.value);
                      debouncedSettingChange('pin', e.target.value || null);
                    }}
                    placeholder="PIN (open access)"
                    className="w-full px-3 py-2 pr-9 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-zinc-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  >
                    {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.accent_color || '#6366F1'}
                    onChange={e => handleSettingChange('accent_color', e.target.value)}
                    className="w-[38px] h-[38px] rounded-lg border border-zinc-200 cursor-pointer p-0.5 flex-shrink-0"
                  />
                  <input
                    type="text"
                    value={localAccentColor}
                    onChange={e => {
                      setLocalAccentColor(e.target.value);
                      debouncedSettingChange('accent_color', e.target.value);
                    }}
                    className="flex-1 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all min-w-0"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Welcome Message */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-zinc-700">Welcome Message</label>
            <textarea
              value={localWelcomeMessage}
              onChange={e => {
                setLocalWelcomeMessage(e.target.value);
                debouncedSettingChange('welcome_message', e.target.value);
              }}
              placeholder="Welcome to your project portal! Here you can track progress and download shared files."
              rows={3}
              className="w-full px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-zinc-400 resize-none"
            />
          </div>

          {/* Visibility Toggles */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide">Visible Sections</label>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'show_progress', label: 'Progress' },
                { key: 'show_proposals', label: 'Proposals' },
                { key: 'show_files', label: 'Files' },
                { key: 'show_hours', label: 'Hours' },
              ].filter(item => item.key !== 'show_hours' || project?.hourly_tracking).map(({ key, label }) => {
                const isActive = (settings as any)[key];
                return (
                  <button
                    key={key}
                    onClick={() => handleSettingChange(key, !isActive)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      isActive
                        ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                        : 'bg-zinc-50 border-zinc-200 text-zinc-400'
                    }`}
                  >
                    {isActive ? <Eye size={13} className="inline mr-1.5" /> : <EyeOff size={13} className="inline mr-1.5" />}
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Files Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Shared Files ({files.length})
              </label>
              <label className="cursor-pointer">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                  disabled={uploading}
                />
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors cursor-pointer">
                  <Upload size={14} />
                  {uploading ? 'Uploading...' : 'Upload'}
                </span>
              </label>
            </div>

            {files.length > 0 ? (
              <div className="space-y-1.5">
                {files.map(file => {
                  const FileIcon = getFileIcon(file.mime_type);
                  const isHtml = file.mime_type === 'text/html';
                  const isEditing = editingFileId === file.id;
                  return (
                    <div
                      key={file.id}
                      className="flex items-center gap-3 px-3 py-2.5 bg-zinc-50 rounded-lg group"
                    >
                      <FileIcon size={16} className="text-zinc-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
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
                                  renamePortalFile(file.id, trimmed);
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
                          {!isEditing && isHtml && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-indigo-50 text-indigo-600 rounded flex-shrink-0">
                              Web Page
                            </span>
                          )}
                          {!isEditing && isHtml && settings?.token && (
                            <button
                              onClick={() => {
                                const url = `${window.location.origin}/portal/${settings.token}/page/${file.id}`;
                                navigator.clipboard.writeText(url);
                                setCopiedFileId(file.id);
                                toast('success', 'Page link copied!');
                                setTimeout(() => setCopiedFileId(null), 2000);
                              }}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-zinc-100 text-zinc-500 hover:bg-indigo-50 hover:text-indigo-600 rounded transition-colors flex-shrink-0"
                              title="Copy page link"
                            >
                              {copiedFileId === file.id ? <Check size={10} /> : <Copy size={10} />}
                              {copiedFileId === file.id ? 'Copied' : 'Copy Link'}
                            </button>
                          )}
                        </div>
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
                      {isHtml && settings?.token && (
                        <a
                          href={`/portal/${settings.token}/page/${file.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 text-zinc-300 hover:text-indigo-500 opacity-0 group-hover:opacity-100 transition-all"
                          title="View as web page"
                        >
                          <ExternalLink size={14} />
                        </a>
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
              <p className="text-sm text-zinc-400 text-center py-4">No files shared yet</p>
            )}
          </div>
        </div>
      )}
      <AvatarCropModal
        file={logoCropFile}
        onCrop={handleLogoCropped}
        onCancel={() => setLogoCropFile(null)}
      />
      <ConfirmDialog
        isOpen={!!deleteFileTarget}
        onClose={() => setDeleteFileTarget(null)}
        onConfirm={executeDeleteFile}
        title="Delete File"
        message="Are you sure you want to remove this file from the portal?"
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
