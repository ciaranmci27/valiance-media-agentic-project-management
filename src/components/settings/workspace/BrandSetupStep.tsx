'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useRead } from '@/lib/query-cache';
import { BRAND_LIMITS } from '@/lib/brand/validate';
import { resolveBrand } from '@/lib/brand';
import { BrandTextField } from './BrandTextField';
import { HexColorField } from './HexColorField';
import { LogoField } from './LogoField';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import { checkLogoFile, cleanInput, fetchLogoFile, removeLogo, saveBrand, toInput, uploadLogo, workspaceBrandRead } from './brand-settings';

export const BRAND_SETTINGS_HREF = '/settings/workspace#brand';

/**
 * The first-run card's second step: the name, the logo and the color, the
 * three things that make the app look like the company's own. Saved through
 * the same routes as Settings > Workspace > Brand; Skip leaves the defaults.
 * Shows nothing while the brand cannot be saved (the migration has not run).
 */
export function BrandSetupStep({ onSkip }: { onSkip: () => void }) {
  const router = useRouter();
  const read = useRead(workspaceBrandRead);
  const data = read.data?.status === 'ready' ? read.data.data : null;

  const [name, setName] = useState<string | null>(null);
  const [color, setColor] = useState<string | null | undefined>(undefined);
  const [colorValid, setColorValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoOutcome, setLogoOutcome] = useState<Outcome | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [saved, setSaved] = useState(false);

  if (read.loading) {
    return (
      <div aria-busy="true" aria-label="Loading brand" className="mt-4 h-40 rounded-xl bg-white/[0.03] ring-1 ring-inset ring-white/[0.06] motion-safe:animate-pulse" />
    );
  }
  if (!data) return null;

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

  const save = async () => {
    if (saving || !colorValid) return;
    setSaving(true);
    // A save sends every field, so the rest goes back as it is.
    const result = await saveBrand(cleanInput({ ...toInput(settings), name: nameValue, brandColor: colorValue }));
    setSaving(false);
    if (!result.ok) {
      setOutcome({ tone: 'error', text: `Not saved. ${result.message}` });
      return;
    }
    setSaved(true);
    setOutcome({ tone: 'done', text: 'Brand saved. Everyone sees it now.' });
    router.refresh();
  };

  if (saved) {
    return (
      <div className="mt-4">
        {outcome && <OutcomeLine outcome={outcome} />}
        <div className="mt-3 -ml-2.5">
          <Button href={BRAND_SETTINGS_HREF} variant="ghost" size="sm">
            Tagline, favicon and more in Brand settings
            <ArrowRight size={13} aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby="brand-setup-title" className="mt-5 border-t border-white/[0.06] pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="brand-setup-title" className="text-sm font-medium text-zinc-100">Add your brand</h3>
        <span className="text-[11px] text-zinc-400">Last step</span>
      </div>
      <p className="mt-0.5 text-xs text-zinc-400">Your name, logo and color, for the app, emails and invoices. You can change them any time in Settings.</p>

      <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="space-y-5">
          <BrandTextField
            label="Name"
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
          usage="Emails, invoices and light pages. Add a dark version in Settings."
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

      {outcome && <OutcomeLine outcome={outcome} className="mt-4" />}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!changed && settings.logoLightUrl ? (
          // Only the logo changed, and it saved on upload: nothing left to save.
          <Button size="sm" onClick={onSkip}>Done</Button>
        ) : (
          <Button
            size="sm"
            onClick={() => { void save(); }}
            disabled={saving || !colorValid || !changed}
            icon={saving ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
          >
            {saving ? 'Saving...' : 'Save brand'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onSkip} disabled={saving}>Skip for now</Button>
      </div>
    </div>
  );
}
