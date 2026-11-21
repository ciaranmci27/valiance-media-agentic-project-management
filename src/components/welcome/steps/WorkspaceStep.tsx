'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRead } from '@/lib/query-cache';
import { BRAND_LIMITS } from '@/lib/brand/validate';
import { resolveBrand } from '@/lib/brand';
import { BrandTextField } from '@/components/settings/workspace/BrandTextField';
import { HexColorField } from '@/components/settings/workspace/HexColorField';
import { LogoField } from '@/components/settings/workspace/LogoField';
import type { Outcome } from '@/components/settings/workspace/OutcomeLine';
import { checkLogoFile, cleanInput, fetchLogoFile, removeLogo, saveBrand, toInput, uploadLogo, workspaceBrandRead } from '@/components/settings/workspace/brand-settings';
import { EnvChecksPanel, setupChecksRead } from '../setup-checks';
import { StepFrame, type WizardStepProps } from '../StepFrame';

/**
 * Step 1: the name, logo and color that make the app the company's own,
 * saved through the same routes as Settings > Workspace > Brand. The logo
 * saves when chosen; the name and color save on Continue. The setup check
 * sits on top, so a broken install says so before anything else.
 */
export function WorkspaceStep({ onNext, onSkip }: WizardStepProps) {
  const router = useRouter();
  const read = useRead(workspaceBrandRead);
  const checks = useRead(setupChecksRead);
  const data = read.data?.status === 'ready' ? read.data.data : null;

  const [name, setName] = useState<string | null>(null);
  const [color, setColor] = useState<string | null | undefined>(undefined);
  const [colorValid, setColorValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoOutcome, setLogoOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const panel = (
    <EnvChecksPanel checks={checks.data} loading={checks.loading} failed={checks.failed} onReload={checks.reload} />
  );

  const frame = { title: 'Make it yours', onSkip };

  if (read.loading) {
    return (
      <StepFrame {...frame} description="Your workspace name, logo and color." onSubmit={onNext} primaryDisabled>
        {panel}
        <div aria-busy="true" aria-label="Loading your brand" className="mt-6 h-64 rounded-xl bg-white/[0.03] motion-safe:animate-pulse" />
      </StepFrame>
    );
  }

  if (!data) {
    return (
      <StepFrame
        {...frame}
        description={read.data?.status === 'migration'
          ? `${read.data.message} You can add your brand later in Settings > Workspace.`
          : 'Your brand could not be loaded. You can add it later in Settings > Workspace.'}
        onSubmit={onNext}
      >
        {panel}
      </StepFrame>
    );
  }

  const settings = data.settings;
  const nameValue = name ?? settings.name ?? '';
  const colorValue = color === undefined ? settings.brandColor : color;
  const preview = resolveBrand({ ...settings, name: nameValue.trim() || null, brandColor: colorValue });
  const changed = (nameValue.trim() || null) !== settings.name || colorValue !== settings.brandColor;

  const upload = async (file: File) => {
    const problem = checkLogoFile('light', file);
    setLogoOutcome(null);
    if (problem) {
      setLogoError(problem);
      return;
    }
    setLogoError(null);
    setUploading(true);
    const result = await uploadLogo('light', file);
    setUploading(false);
    if (!result.ok) {
      setLogoError(`Not uploaded. ${result.message}`);
      return;
    }
    router.refresh();
  };

  const remove = async () => {
    if (!settings.logoLightUrl) return;
    setLogoError(null);
    setUploading(true);
    // Kept in memory, so Undo can upload it again.
    const file = await fetchLogoFile(settings.logoLightUrl, 'light');
    const result = await removeLogo('light');
    setUploading(false);
    if (!result.ok) {
      setLogoError(`Not removed. ${result.message}`);
      return;
    }
    setLogoOutcome({ tone: 'done', text: 'Logo removed.', onUndo: file ? () => { void upload(file); } : undefined });
    router.refresh();
  };

  const submit = async () => {
    if (!colorValid) {
      setError('Fix the brand color, or clear it to use the default.');
      return;
    }
    if (!changed) {
      onNext();
      return;
    }
    setSaving(true);
    setError(null);
    // A save sends every field, so the rest goes back as it is.
    const result = await saveBrand(cleanInput({ ...toInput(settings), name: nameValue, brandColor: colorValue }));
    setSaving(false);
    if (!result.ok) {
      setError(`Not saved. ${result.message}`);
      return;
    }
    router.refresh();
    onNext();
  };

  return (
    <StepFrame
      {...frame}
      description="Your name, logo and color show across the app, in emails and on invoices. You can change them any time in Settings."
      onSubmit={() => { void submit(); }}
      busy={saving}
      primaryDisabled={uploading}
      error={error}
    >
      {panel}
      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <BrandTextField
            label="Workspace name"
            value={nameValue}
            placeholder={data.defaults.name}
            max={BRAND_LIMITS.name}
            hint="Shows in the sidebar, the browser tab and emails."
            onChange={setName}
          />
          <HexColorField
            label="Brand color"
            value={colorValue}
            fallback={data.defaults.colors.brand[500]}
            hint="Buttons, links and selected items."
            onChange={setColor}
            onValidityChange={setColorValid}
          />
        </div>
        <LogoField
          kind="light"
          label="Logo"
          usage="Shows across the app and in emails. You can add a version for dark backgrounds later in Settings."
          url={settings.logoLightUrl}
          emptyNote="No logo yet: your name shows as text"
          name={preview.name}
          brand600={preview.colors.brand[600]}
          busy={uploading}
          error={logoError}
          outcome={logoOutcome}
          onFile={(file) => { void upload(file); }}
          onRemove={() => { void remove(); }}
        />
      </div>
    </StepFrame>
  );
}
