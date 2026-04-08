'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Globe, Link2, Copy, Check, Eye, EyeOff, Lock, Pencil,
  Trash2, ExternalLink,
  Camera, Loader2, X, GripVertical,
} from 'lucide-react';
import { useApp } from '@/lib/store';
import { DEFAULT_SECTION_ORDER, PORTAL_SECTION_LABELS, type PortalSectionKey } from '@/lib/types';
import { useDemo } from '@/lib/demo-context';
import { toast } from '@/components/ui/Toast';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { AvatarCropModal } from '@/components/ui/AvatarCropModal';
import { PinInput, type PinInputRef } from '@/components/ui/PinInput';
import { createClient } from '@/lib/supabase/client';
import { siteConfig } from '@/site-config';

interface PortalSettingsPanelProps {
  projectId: string;
}

export function PortalSettingsPanel({ projectId }: PortalSettingsPanelProps) {
  const {
    getPortalSettings,
    upsertPortalSettings,
    updatePortalSlug,
    getProject,
  } = useApp();
  const { isDemoMode } = useDemo();

  const settings = getPortalSettings(projectId);
  const project = getProject(projectId);

  const [copied, setCopied] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoCropFile, setLogoCropFile] = useState<File | null>(null);
  const [pinConfirmed, setPinConfirmed] = useState(false);
  const [showPinConfirm, setShowPinConfirm] = useState(false);
  const [showDeletePinConfirm, setShowDeletePinConfirm] = useState(false);
  const pinInputRef = useRef<PinInputRef>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Local state for text inputs to avoid writing to store on every keystroke
  const [localSlug, setLocalSlug] = useState(settings?.token || '');
  const [editingSlug, setEditingSlug] = useState(false);
  const slugInputRef = useRef<HTMLInputElement>(null);
  const [localPin, setLocalPin] = useState(settings?.pin || '');
  const [localAccentColor, setLocalAccentColor] = useState(settings?.accent_color || siteConfig.colors.brand[500]);
  const [localWelcomeMessage, setLocalWelcomeMessage] = useState(settings?.welcome_message || '');
  const [sectionOrder, setSectionOrder] = useState<PortalSectionKey[]>(settings?.section_order ?? [...DEFAULT_SECTION_ORDER]);
  const [draggedKey, setDraggedKey] = useState<PortalSectionKey | null>(null);
  const dragKeyRef = useRef<PortalSectionKey | null>(null);
  const lastTargetRef = useRef<PortalSectionKey | null>(null);
  const sectionOrderRef = useRef(sectionOrder);
  sectionOrderRef.current = sectionOrder;

  // Sync local state when settings change externally
  useEffect(() => {
    setLocalSlug(settings?.token || '');
    setLocalPin(settings?.pin || '');
    setLocalAccentColor(settings?.accent_color || siteConfig.colors.brand[500]);
    setLocalWelcomeMessage(settings?.welcome_message || '');
    setSectionOrder(settings?.section_order ?? [...DEFAULT_SECTION_ORDER]);
  }, [settings?.token, settings?.pin, settings?.accent_color, settings?.welcome_message, settings?.section_order]);

  // Pointer-event based drag for section reordering
  const handleSectionDragStart = useCallback((key: PortalSectionKey, e: React.PointerEvent) => {
    e.preventDefault();
    dragKeyRef.current = key;
    lastTargetRef.current = null;
    setDraggedKey(key);

    const handleMove = (moveEvent: PointerEvent) => {
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const target = el?.closest('[data-section-key]');
      const targetKey = target?.getAttribute('data-section-key') as PortalSectionKey | null;
      if (!targetKey || targetKey === dragKeyRef.current || targetKey === lastTargetRef.current) return;
      lastTargetRef.current = targetKey;

      setSectionOrder(prev => {
        const dragged = dragKeyRef.current!;
        const fromIdx = prev.indexOf(dragged);
        const toIdx = prev.indexOf(targetKey);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
        const next = [...prev];
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, dragged);
        return next;
      });
    };

    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      setDraggedKey(null);
      dragKeyRef.current = null;
      lastTargetRef.current = null;
      upsertPortalSettings(projectId, { section_order: sectionOrderRef.current });
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [projectId, upsertPortalSettings]);

  // Debounced save helper
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSettingChange = useCallback((key: string, value: any) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      upsertPortalSettings(projectId, { [key]: value });
    }, 500);
  }, [projectId, upsertPortalSettings]);

  const isEnabled = settings?.enabled ?? false;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const portalUrl = settings?.token
    ? `${origin}/portal/${settings.token}`
    : '';

  const handleSlugSave = () => {
    const trimmed = localSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (!trimmed || trimmed === settings?.token) {
      setLocalSlug(settings?.token || '');
      setEditingSlug(false);
      return;
    }
    updatePortalSlug(projectId, trimmed);
    setEditingSlug(false);
  };

  const handleToggleEnabled = () => {
    const turning_on = !isEnabled;
    const needsDefaultMessage = turning_on && !settings?.welcome_message;
    upsertPortalSettings(projectId, {
      enabled: turning_on,
      accent_color: project?.color || siteConfig.colors.brand[500],
      ...(needsDefaultMessage && {
        welcome_message: `Welcome to your project portal. Here you'll find the latest updates, files, and progress.`,
      }),
    });
  };

  const handleCopyLink = () => {
    if (!portalUrl) return;
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    toast('success', 'Portal link copied!');
    setTimeout(() => setCopied(false), 2000);
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

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden flex flex-col max-h-[600px]">
      {/* Header with toggle */}
      <div
        className={`px-5 py-4 flex items-center justify-between flex-shrink-0 ${isEnabled ? 'border-b border-zinc-100' : ''}`}
      >
        <div className="flex items-center gap-2">
          <Globe size={18} className="text-zinc-500" />
          <h2 className="font-semibold text-zinc-900">Client Portal</h2>
        </div>
        <button
          onClick={handleToggleEnabled}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
            isEnabled ? 'bg-brand-600' : 'bg-zinc-200'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              isEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {isEnabled && settings && (
        <div className="p-5 space-y-5 flex-1 overflow-y-auto">
          {/* Portal Logo + Link + PIN + Color */}
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Logo */}
            <div className="relative group flex-shrink-0">
              <div className="w-[88px] h-[88px] rounded-xl overflow-hidden border border-zinc-200 bg-zinc-50 flex items-center justify-center">
                {settings.logo_url ? (
                  <img src={settings.logo_url} alt="Logo" className="w-full h-full object-cover" />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center text-white text-lg font-bold"
                    style={{ backgroundColor: settings.accent_color || siteConfig.colors.brand[500] }}
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
                {editingSlug ? (
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-white border border-brand-300 ring-2 ring-brand-100 rounded-lg text-sm min-w-0">
                    <Link2 size={14} className="text-zinc-400 flex-shrink-0" />
                    <div className="flex-1 flex items-center min-w-0">
                      <span className="text-zinc-400 flex-shrink-0">{origin}/portal/</span>
                      <input
                        ref={slugInputRef}
                        type="text"
                        value={localSlug}
                        onChange={e => setLocalSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSlugSave();
                          if (e.key === 'Escape') { setLocalSlug(settings?.token || ''); setEditingSlug(false); }
                        }}
                        className="flex-1 min-w-0 bg-transparent text-zinc-800 outline-none placeholder:text-zinc-300"
                        placeholder="project-slug"
                        autoFocus
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-600 min-w-0">
                    <Link2 size={14} className="text-zinc-400 flex-shrink-0" />
                    <span className="truncate">{portalUrl}</span>
                  </div>
                )}
                <Tooltip content={editingSlug ? 'Save slug' : 'Edit slug'}>
                  <button
                    onClick={() => {
                      if (editingSlug) {
                        handleSlugSave();
                      } else {
                        setLocalSlug(settings?.token || '');
                        setEditingSlug(true);
                      }
                    }}
                    className={`p-2 rounded-lg transition-colors ${editingSlug ? 'text-brand-600 hover:bg-brand-50' : 'text-zinc-500 hover:text-brand-600 hover:bg-brand-50'}`}
                  >
                    {editingSlug ? <Check size={16} /> : <Pencil size={16} />}
                  </button>
                </Tooltip>
                <Tooltip content="Copy link">
                  <button
                    onClick={handleCopyLink}
                    className="p-2 text-zinc-500 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                  >
                    {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                  </button>
                </Tooltip>
                <Tooltip content="View portal">
                  <button
                    onClick={() => portalUrl && window.open(portalUrl, '_blank', 'noopener,noreferrer')}
                    className="p-2 text-zinc-500 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                  >
                    <Eye size={16} />
                  </button>
                </Tooltip>
              </div>

              {/* Accent Color + PIN */}
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={localAccentColor}
                  onChange={e => {
                    setLocalAccentColor(e.target.value);
                    debouncedSettingChange('accent_color', e.target.value);
                  }}
                  className="w-[38px] h-[38px] rounded-lg border border-zinc-200 cursor-pointer p-0.5 flex-shrink-0"
                />
                <div className="w-24">
                  <TextInput
                    value={localAccentColor}
                    onChange={v => {
                      setLocalAccentColor(v);
                      debouncedSettingChange('accent_color', v);
                    }}
                    size="sm"
                  />
                </div>
                <div className="h-5 w-px bg-zinc-200 flex-shrink-0" />
                {pinConfirmed ? (
                  <div className="flex items-center gap-2">
                    <PinInput
                      ref={pinInputRef}
                      value={localPin}
                      onChange={setLocalPin}
                      onSubmit={(val) => {
                        upsertPortalSettings(projectId, { pin: val });
                        setPinConfirmed(false);
                        toast('success', 'Portal PIN updated');
                      }}
                      size="sm"
                      autoFocus
                    />
                    {localPin.length === 4 && (
                      <button
                        type="button"
                        onClick={() => {
                          upsertPortalSettings(projectId, { pin: localPin });
                          setPinConfirmed(false);
                          toast('success', 'Portal PIN updated');
                        }}
                        className="px-2.5 py-1.5 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors flex-shrink-0"
                      >
                        Save
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowPinConfirm(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg hover:border-zinc-300 transition-colors flex-shrink-0"
                  >
                    <Lock size={13} className="text-zinc-400" />
                    <span className={localPin ? 'text-zinc-700 font-medium tracking-wider' : 'text-zinc-400'}>{localPin ? '••••' : 'Set PIN'}</span>
                  </button>
                )}
                {localPin && !pinConfirmed && (
                  <Tooltip content="Remove PIN">
                    <button
                      type="button"
                      onClick={() => setShowDeletePinConfirm(true)}
                      className="p-1.5 text-zinc-300 hover:text-red-500 rounded-md transition-colors flex-shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>

          {/* Welcome Message */}
          <Textarea
            label="Welcome Message"
            value={localWelcomeMessage}
            onChange={v => {
              setLocalWelcomeMessage(v);
              debouncedSettingChange('welcome_message', v);
            }}
            placeholder="Welcome to your project portal! Here you can track progress and download shared files."
            rows={3}
            size="sm"
          />

          {/* Visibility Toggles (drag to reorder) */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-500 uppercase tracking-wide">Visible Sections</label>
            <div className="flex flex-wrap gap-2">
              {sectionOrder
                .filter(key => key !== 'show_hours' || project?.hourly_tracking)
                .map((key) => {
                  const isActive = (settings as any)[key];
                  const isDragging = draggedKey === key;
                  return (
                    <div
                      key={key}
                      data-section-key={key}
                      className={`flex items-center rounded-lg border transition-all ${
                        isActive
                          ? 'bg-brand-50 border-brand-200 text-brand-700'
                          : 'bg-zinc-50 border-zinc-200 text-zinc-400'
                      } ${isDragging ? 'shadow-md ring-2 ring-brand-200 z-10 opacity-70' : ''}`}
                    >
                      <span
                        onPointerDown={(e) => handleSectionDragStart(key, e)}
                        className="pl-2 pr-0.5 py-1.5 cursor-grab active:cursor-grabbing touch-none select-none"
                      >
                        <GripVertical size={12} className={isActive ? 'text-brand-300' : 'text-zinc-300'} />
                      </span>
                      <button
                        onClick={() => handleSettingChange(key, !isActive)}
                        className="pr-3 pl-0.5 py-1.5 text-sm flex items-center gap-1.5"
                      >
                        {isActive ? <Eye size={13} /> : <EyeOff size={13} />}
                        {PORTAL_SECTION_LABELS[key]}
                      </button>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
      <AvatarCropModal
        file={logoCropFile}
        onCrop={handleLogoCropped}
        onCancel={() => setLogoCropFile(null)}
      />
      <ConfirmDialog
        isOpen={showPinConfirm}
        onClose={() => setShowPinConfirm(false)}
        onConfirm={() => {
          setPinConfirmed(true);
          setShowPinConfirm(false);
          setTimeout(() => pinInputRef.current?.focus(), 50);
        }}
        title="Set Portal PIN"
        message="Enter a 4-digit PIN to require clients to authenticate before accessing the portal. You can remove it later to restore open access."
        confirmLabel="Continue"
        variant="default"
      />
      <ConfirmDialog
        isOpen={showDeletePinConfirm}
        onClose={() => setShowDeletePinConfirm(false)}
        onConfirm={() => {
          setLocalPin('');
          upsertPortalSettings(projectId, { pin: null });
          setPinConfirmed(false);
          setShowDeletePinConfirm(false);
          toast('success', 'PIN removed, portal is now open access');
        }}
        title="Remove Portal PIN"
        message="This will remove the PIN requirement. Anyone with the portal link will be able to access it without authentication."
        confirmLabel="Remove PIN"
        variant="default"
      />
    </div>
  );
}
