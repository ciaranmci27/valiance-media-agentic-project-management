'use client';
import { ColorInput } from '@/components/ui/inputs/ColorInput';
import { FileInput } from '@/components/ui/inputs/FileInput';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Globe,
  Link2,
  Copy,
  Check,
  Lock,
  Pencil,
  Trash2,
  Camera,
  Loader2,
  X,
  Palette,
  MessageSquareText,
} from 'lucide-react';
import { useApp } from '@/lib/store';

import { useDemo } from '@/lib/demo-context';
import { toast } from '@/components/ui/Toast';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { AvatarCropModal } from '@/components/ui/AvatarCropModal';
import { PinInput, type PinInputRef } from '@/components/ui/PinInput';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { Button } from '@/components/ui/Button';
import { RailCard } from '@/components/projects/TabLayout';
import { createClient } from '@/lib/supabase/client';
import { siteConfig } from '@/site-config';

interface PortalSettingsPanelProps {
  projectId: string;
}

/** What turning the portal on writes: on, the project's color, a starter welcome. */
export function portalEnablePatch(projectColor: string | undefined, hasWelcomeMessage: boolean) {
  return {
    enabled: true,
    accent_color: projectColor || siteConfig.colors.brand[500],
    ...(!hasWelcomeMessage && {
      welcome_message: `Welcome to your project portal. Here you'll find the latest updates, files, and progress.`,
    }),
  };
}

/**
 * The Client portal tab's settings, as rail cards grouped by purpose: Access
 * (on/off, link, PIN), Branding and Welcome message. The page's sections are
 * PortalSectionsCard, in the main column.
 */
export function PortalSettingsPanel({ projectId }: PortalSettingsPanelProps) {
  const { getPortalSettings, upsertPortalSettings, updatePortalSlug, getProject } = useApp();
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
  const [localAccentColor, setLocalAccentColor] = useState(
    settings?.accent_color || siteConfig.colors.brand[500],
  );
  const [localWelcomeMessage, setLocalWelcomeMessage] = useState(settings?.welcome_message || '');
  // Sync local state when settings change externally
  useEffect(() => {
    setLocalSlug(settings?.token || '');
    setLocalPin(settings?.pin || '');
    setLocalAccentColor(settings?.accent_color || siteConfig.colors.brand[500]);
    setLocalWelcomeMessage(settings?.welcome_message || '');
  }, [
    settings?.token,
    settings?.pin,
    settings?.accent_color,
    settings?.welcome_message,
  ]);

  // Debounced save helper
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSettingChange = useCallback(
    (key: string, value: any) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        upsertPortalSettings(projectId, { [key]: value });
      }, 500);
    },
    [projectId, upsertPortalSettings],
  );

  const isEnabled = settings?.enabled ?? false;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const portalUrl = settings?.token ? `${origin}/portal/${settings.token}` : '';

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
    upsertPortalSettings(
      projectId,
      isEnabled ? { enabled: false } : portalEnablePatch(project?.color, !!settings?.welcome_message),
    );
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

      const {
        data: { publicUrl },
      } = supabase.storage.from('avatars').getPublicUrl(path);

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

  if (!settings) return null;

  const iconButton =
    'p-2 rounded-lg text-zinc-400 hover:text-brand-300 hover:bg-white/[0.06] transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

  return (
    <>
      {/* Access: who can open it, and where */}
      <RailCard
        title="Access"
        icon={<Globe size={16} className="text-zinc-400" aria-hidden="true" />}
        action={
          <Toggle
            size="sm"
            checked={isEnabled}
            onChange={handleToggleEnabled}
            label={isEnabled ? 'Live' : 'Off'}
          />
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1.5">Link</p>
            {editingSlug ? (
              <div className="space-y-1.5">
                <p className="text-xs text-zinc-500 truncate">{origin}/portal/</p>
                <div className="flex items-center gap-1">
                  <input
                    ref={slugInputRef}
                    type="text"
                    aria-label="Portal link ending"
                    value={localSlug}
                    onChange={(e) => setLocalSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSlugSave();
                      if (e.key === 'Escape') {
                        setLocalSlug(settings.token || '');
                        setEditingSlug(false);
                      }
                    }}
                    className="flex-1 min-w-0 px-3 py-2 bg-surface-raised border border-brand-500/30 ring-2 ring-brand-500/30 rounded-lg text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
                    placeholder="project-slug"
                    autoFocus
                  />
                  <Tooltip content="Save link">
                    <button type="button" aria-label="Save link" onClick={handleSlugSave} className={iconButton}>
                      <Check size={16} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 bg-white/[0.03] border border-white/[0.08] rounded-lg text-sm text-zinc-300">
                  <Link2 size={14} className="text-zinc-500 flex-shrink-0" aria-hidden="true" />
                  <span className="truncate" title={portalUrl}>{portalUrl.replace(/^https?:\/\//, '')}</span>
                </div>
                <Tooltip content="Edit link">
                  <button
                    type="button"
                    aria-label="Edit link"
                    onClick={() => {
                      setLocalSlug(settings.token || '');
                      setEditingSlug(true);
                    }}
                    className={iconButton}
                  >
                    <Pencil size={15} />
                  </button>
                </Tooltip>
                <Tooltip content="Copy link">
                  <button type="button" aria-label="Copy link" onClick={handleCopyLink} className={iconButton}>
                    {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-1.5">PIN</p>
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
                  <Button
                    type="button"
                    size="sm"
                    className="flex-shrink-0"
                    onClick={() => {
                      upsertPortalSettings(projectId, { pin: localPin });
                      setPinConfirmed(false);
                      toast('success', 'Portal PIN updated');
                    }}
                  >
                    Save
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-zinc-300">
                  {localPin ? 'Clients enter a 4-digit PIN' : 'Anyone with the link can open it'}
                </p>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowPinConfirm(true)}
                    className="inline-flex h-8 items-center gap-1.5 px-2.5 text-sm bg-surface-raised border border-white/[0.08] rounded-lg hover:border-white/[0.12] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Lock size={13} className="text-zinc-500" aria-hidden="true" />
                    <span className={localPin ? 'text-zinc-300 font-medium tracking-wider' : 'text-zinc-400'}>
                      {localPin ? '••••' : 'Set PIN'}
                    </span>
                  </button>
                  {localPin && (
                    <Tooltip content="Remove PIN">
                      <button
                        type="button"
                        aria-label="Remove PIN"
                        onClick={() => setShowDeletePinConfirm(true)}
                        className="p-1.5 text-zinc-500 hover:text-red-400 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </RailCard>

      {/* Branding: how it looks to the client */}
      <RailCard title="Branding" icon={<Palette size={16} className="text-zinc-400" aria-hidden="true" />}>
        <div className="flex items-start gap-4">
          <div className="relative group flex-shrink-0">
            <div className="w-[72px] h-[72px] rounded-xl overflow-hidden border border-white/[0.08] bg-white/[0.03] flex items-center justify-center">
              {settings.logo_url ? (
                <img src={settings.logo_url} alt="Portal logo" className="w-full h-full object-cover" />
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
                aria-label={settings.logo_url ? 'Change logo' : 'Upload logo'}
                onClick={() => logoInputRef.current?.click()}
                className="absolute inset-0 rounded-xl bg-black/30 sm:bg-black/0 sm:group-hover:bg-black/40 sm:focus-visible:bg-black/40 flex items-center justify-center transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <Camera size={16} className="text-white sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100 transition-opacity" />
              </button>
            )}
            {uploadingLogo && (
              <div className="absolute inset-0 rounded-xl bg-black/40 flex items-center justify-center">
                <Loader2 size={16} className="text-white animate-spin" aria-hidden="true" />
              </div>
            )}
            {settings.logo_url && !uploadingLogo && (
              <button
                type="button"
                aria-label="Remove logo"
                onClick={handleRemoveLogo}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-red-600"
              >
                <X size={12} />
              </button>
            )}
            <FileInput
              ref={logoInputRef}
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
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-500 mb-1.5">Accent color</p>
            <div className="flex items-center gap-2">
              <ColorInput
                ariaLabel="Portal accent color"
                value={localAccentColor}
                onChange={(nextValue) => {
                  setLocalAccentColor(nextValue);
                  debouncedSettingChange('accent_color', nextValue);
                }}
              />
              <div className="w-24">
                <TextInput
                  aria-label="Accent color hex"
                  value={localAccentColor}
                  onChange={(v) => {
                    setLocalAccentColor(v);
                    debouncedSettingChange('accent_color', v);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </RailCard>

      <RailCard title="Welcome message" icon={<MessageSquareText size={16} className="text-zinc-400" aria-hidden="true" />}>
        <Textarea
          aria-label="Welcome message"
          value={localWelcomeMessage}
          onChange={(v) => {
            setLocalWelcomeMessage(v);
            debouncedSettingChange('welcome_message', v);
          }}
          placeholder="Welcome to your project portal! Here you can track progress and download shared files."
          rows={4}
          size="sm"
        />
      </RailCard>

      <AvatarCropModal file={logoCropFile} onCrop={handleLogoCropped} onCancel={() => setLogoCropFile(null)} />
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
    </>
  );
}
