'use client';

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, AlertTriangle, Check, ChevronDown, Database, Loader2, Palette, RotateCw } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { RadioGroup } from '@/components/ui/inputs/RadioGroup';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import {
  BRAND_SHADES,
  DEFAULT_BRAND,
  EMPTY_BRAND_SETTINGS,
  contrastRatio,
  generateShades,
  resolveBrand,
  type BrandScale,
  type BrandSettings,
  type BrandSettingsInput,
  type BrandShade,
  logoKindFor,
  logoKindShape,
  logoKindTheme,
  type LogoKind,
} from '@/lib/brand';
import { useBrand } from '@/lib/brand/context';
import { BRAND_LIMITS } from '@/lib/brand/validate';
import { BrandPreview } from './BrandPreview';
import { BrandTextField } from './BrandTextField';
import { HexColorField } from './HexColorField';
import { LogoField, type LogoGuard } from './LogoField';
import { logoShapeProblem } from './logo-checks';
import { measureLogoFile } from './logo-measure';
import { OutcomeLine, type Outcome } from './OutcomeLine';
import {
  EMPTY_INPUT,
  checkLogoFile,
  cleanInput,
  fetchLogoFile,
  hasCustomValues,
  removeLogo,
  sameInput,
  saveBrand,
  settingsFromBrand,
  toInput,
  uploadLogo,
  workspaceBrandRead,
} from './brand-settings';

const DESCRIPTION = 'Your company\'s name, logo and color, as the app, the client portal, emails and invoices show them.';

const URL_FIELD: Record<LogoKind, 'logoLightUrl' | 'logoDarkUrl' | 'faviconUrl' | 'squareDarkUrl'> = {
  light: 'logoLightUrl',
  dark: 'logoDarkUrl',
  favicon: 'faviconUrl',
  square_dark: 'squareDarkUrl',
};

/** Each slot's whole name, for lines and buttons. The stored kinds are older than the slots (types.ts, LOGO_KINDS). */
const LOGO_NAME: Record<LogoKind, string> = {
  light: 'Horizontal logo, light theme',
  dark: 'Horizontal logo, dark theme',
  favicon: 'Square logo, light theme',
  square_dark: 'Square logo, dark theme',
};

const SHAPE_NAME = { horizontal: 'Horizontal', square: 'Square' } as const;

interface LogoState {
  busy: boolean;
  error: string | null;
  guard: LogoGuard | null;
  outcome: Outcome | null;
}

const IDLE: LogoState = { busy: false, error: null, guard: null, outcome: null };

/**
 * Settings > Workspace > Brand: what the app, the portal, emails and invoice
 * PDFs show as the company. Text, colors and the sidebar options save
 * together from a bar that shows while anything is unsaved; logos upload on
 * their own at once. The preview shows the unsaved draft. In the demo
 * workspace everything stays on this page until a reload.
 */
export function BrandSection() {
  const router = useRouter();
  const live = useBrand();
  const { isDemoMode } = useDemo();
  const read = useRead(isDemoMode ? null : workspaceBrandRead);

  const local = isDemoMode || read.data?.status === 'local';
  const migration = read.data?.status === 'migration' ? read.data.message : null;
  const ready = read.data?.status === 'ready' ? read.data.data : null;

  // The demo workspace has no database: its "saved" brand lives here.
  const [localSettings, setLocalSettings] = useState<BrandSettings | null>(null);
  const saved: BrandSettings = local
    ? localSettings ?? settingsFromBrand(live)
    : ready?.settings ?? EMPTY_BRAND_SETTINGS;
  const defaults = ready?.defaults ?? DEFAULT_BRAND;
  const savedInput = toInput(saved);

  const [draft, setDraft] = useState<BrandSettingsInput | null>(null);
  const form = draft ?? savedInput;
  const dirty = draft !== null && !sameInput(draft, savedInput);
  // Colors whose hex is half typed or wrong: saving waits for them.
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  // Bumped to start the fields fresh (Discard, Reset), dropping half-typed text.
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [bar, setBar] = useState<Outcome | null>(null);
  const [resetLine, setResetLine] = useState<Outcome | null>(null);
  const [logos, setLogos] = useState<Record<LogoKind, LogoState>>({ light: IDLE, dark: IDLE, favicon: IDLE, square_dark: IDLE });
  // Open by itself while any shade is changed by hand, until the Owner toggles it.
  const [shadesToggled, setShadesToggled] = useState<boolean | null>(null);
  const shadesId = useId();

  const preview = resolveBrand({ ...saved, ...cleanInput(form) });
  const generated: BrandScale = form.brandColor ? generateShades(form.brandColor) : defaults.colors.brand;
  const accentFallback = form.brandColor ? preview.colors.brand[700] : defaults.colors.accent;
  const overrides = form.brandShades ?? {};
  const overrideCount = BRAND_SHADES.filter((shade) => overrides[shade]).length;
  const shadesOpen = shadesToggled ?? overrideCount > 0;
  const locked = !!migration || saving;

  // A saved line goes after a few seconds; errors and Undo lines stay until the next change.
  useEffect(() => {
    if (bar?.tone !== 'done') return;
    const timer = window.setTimeout(() => setBar(null), 6000);
    return () => window.clearTimeout(timer);
  }, [bar]);

  // Leaving with unsaved edits asks first (the browser's own prompt).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = (patch: Partial<BrandSettingsInput>) => {
    setDraft((previous) => ({ ...(previous ?? savedInput), ...patch }));
    setBar(null);
    setResetLine(null);
  };

  const validity = (key: string) => (valid: boolean) => {
    setInvalid((previous) => {
      if (valid === !previous.has(key)) return previous;
      const next = new Set(previous);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startFresh = () => {
    setDraft(null);
    setInvalid(new Set());
    setFormKey((key) => key + 1);
  };

  const save = async () => {
    if (!dirty || saving || invalid.size > 0 || migration) return;
    const input = cleanInput(form);
    if (local) {
      setLocalSettings({ ...saved, ...input });
      setDraft(null);
      setBar({ tone: 'done', text: 'Brand saved on this page. The demo workspace keeps it until you reload.' });
      return;
    }
    setSaving(true);
    const result = await saveBrand(input);
    setSaving(false);
    if (result.ok) {
      // Edits typed while it saved stay as the next draft.
      setDraft((current) => (current && !sameInput(current, input) ? current : null));
      setBar({ tone: 'done', text: 'Brand saved. Everyone sees it now.' });
      router.refresh();
    } else if (!result.migration) {
      setBar({ tone: 'error', text: `Not saved. ${result.message}` });
    }
  };

  const discard = () => {
    startFresh();
    setBar(null);
  };

  const applyWhole = async (input: BrandSettingsInput): Promise<string | null> => {
    if (local) {
      setLocalSettings({ ...saved, ...input });
      return null;
    }
    setSaving(true);
    const result = await saveBrand(input);
    setSaving(false);
    if (!result.ok) return result.message;
    router.refresh();
    return null;
  };

  const restore = async (previous: BrandSettingsInput) => {
    const error = await applyWhole(previous);
    startFresh();
    setResetLine(error
      ? { tone: 'error', text: `Not undone. ${error}`, onRetry: () => { void restore(previous); } }
      : { tone: 'done', text: 'Undone. Your brand is back.' });
  };

  const resetAll = async () => {
    if (locked) return;
    const previous = savedInput;
    setBar(null);
    const error = await applyWhole(EMPTY_INPUT);
    if (error) {
      setResetLine({ tone: 'error', text: `Not reset, so nothing changed. ${error}`, onRetry: () => { void resetAll(); } });
      return;
    }
    startFresh();
    setShadesToggled(null);
    setResetLine({
      tone: 'done',
      text: 'Name, colors and sidebar options are back to the defaults. Logos stay.',
      onUndo: () => { void restore(previous); },
    });
  };

  const setLogo = (kind: LogoKind, next: Partial<LogoState>) => {
    setLogos((previous) => ({ ...previous, [kind]: { ...IDLE, ...next } }));
  };

  const upload = async (kind: LogoKind, file: File, doneText = `${LOGO_NAME[kind]} saved. Everyone sees it now.`, checkShape = true) => {
    const problem = checkLogoFile(kind, file);
    if (problem) {
      setLogo(kind, { error: problem });
      return;
    }
    // A square image on a horizontal slot (or a wide one on a square slot): say so, and offer the slot it fits.
    if (checkShape) {
      const measure = await measureLogoFile(file);
      const wrong = logoShapeProblem(logoKindShape(kind), measure);
      if (wrong) {
        const target = wrong.belongs === logoKindShape(kind) ? null : logoKindFor(wrong.belongs, logoKindTheme(kind));
        // An ICO only fits a square slot, so it is never offered a horizontal one.
        const fits = target && !checkLogoFile(target, file);
        setLogo(kind, {
          guard: {
            text: wrong.text,
            actionLabel: fits ? `Add it to ${SHAPE_NAME[wrong.belongs]}` : null,
            onAction: fits ? () => { setLogo(kind, {}); void upload(target, file, undefined, false); } : undefined,
          },
        });
        return;
      }
    }
    if (local) {
      const url = URL.createObjectURL(file);
      setLocalSettings((previous) => ({ ...(previous ?? saved), [URL_FIELD[kind]]: url }));
      setLogo(kind, { outcome: { tone: 'done', text: 'Shown on this page only. The demo workspace keeps it until you reload.' } });
      return;
    }
    setLogo(kind, { busy: true });
    const result = await uploadLogo(kind, file);
    if (result.ok) {
      setLogo(kind, { outcome: { tone: 'done', text: doneText } });
      router.refresh();
    } else {
      setLogo(kind, { error: result.migration ? null : `Not uploaded. ${result.message}` });
    }
  };

  const remove = async (kind: LogoKind) => {
    const url = saved[URL_FIELD[kind]];
    if (!url) return;
    if (local) {
      setLocalSettings((previous) => ({ ...(previous ?? saved), [URL_FIELD[kind]]: null }));
      setLogo(kind, {
        outcome: {
          tone: 'done',
          text: `${LOGO_NAME[kind]} removed.`,
          onUndo: () => {
            setLocalSettings((previous) => ({ ...(previous ?? saved), [URL_FIELD[kind]]: url }));
            setLogo(kind, { outcome: { tone: 'done', text: `${LOGO_NAME[kind]} is back.` } });
          },
        },
      });
      return;
    }
    setLogo(kind, { busy: true });
    // Kept in memory, so Undo can upload it again.
    const file = await fetchLogoFile(url, kind);
    const result = await removeLogo(kind);
    if (!result.ok) {
      setLogo(kind, { error: result.migration ? null : `Not removed. ${result.message}` });
      return;
    }
    setLogo(kind, {
      outcome: {
        tone: 'done',
        text: `${LOGO_NAME[kind]} removed.`,
        onUndo: file ? () => { void upload(kind, file, `${LOGO_NAME[kind]} is back.`); } : undefined,
      },
    });
    router.refresh();
  };

  const setShade = (shade: BrandShade, value: string | null) => {
    const next: Partial<BrandScale> = { ...(form.brandShades ?? {}) };
    if (value) next[shade] = value;
    else delete next[shade];
    edit({ brandShades: Object.keys(next).length > 0 ? next : null });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Ctrl+S or Cmd+S saves while focus is anywhere in the section.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && dirty) {
      event.preventDefault();
      void save();
    }
  };

  const loading = !local && read.loading;
  const failed = !local && read.failed;

  return (
    <section className="glass-card @container rounded-xl p-4 lg:p-6" onKeyDown={onKeyDown}>
      <SettingsSectionHeader icon={Palette} title="Brand" description={DESCRIPTION} />

      {local && <p className="-mt-3 mb-6 text-xs text-zinc-400">Demo workspace: changes last until you reload.</p>}

      {loading ? (
        <BrandSkeleton />
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-red-500/[0.1] px-3.5 py-3">
          <p className="min-w-0 flex-1 text-sm text-zinc-200">Couldn&apos;t load your brand.</p>
          <Button size="sm" variant="secondary" onClick={read.reload} icon={<RotateCw size={13} aria-hidden="true" />}>Try again</Button>
        </div>
      ) : (
        <>
          {migration && (
            <div role="status" className="mb-6 flex items-start gap-3 rounded-lg bg-amber-500/[0.1] px-3.5 py-3">
              <Database size={16} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">{migration}</p>
                <p className="mt-0.5 text-xs text-zinc-400">The brand can be set once the database is up to date. Until then, the app uses the defaults.</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-8 @2xl:grid-cols-[minmax(0,1fr)_17.5rem] @2xl:gap-10">
            <fieldset key={formKey} disabled={!!migration} className="min-w-0">
              <legend className="sr-only">Brand settings</legend>

              <Group title="Name" first>
                <BrandTextField
                  label="Name"
                  value={form.name ?? ''}
                  placeholder={defaults.name}
                  max={BRAND_LIMITS.name}
                  hint="Shows in the sidebar, on the sign-in page, in the browser tab and in emails."
                  onChange={(name) => edit({ name })}
                />
                <BrandTextField
                  label="Tagline"
                  value={form.tagline ?? ''}
                  placeholder={defaults.tagline}
                  max={BRAND_LIMITS.tagline}
                  hint="The second half of the browser tab title."
                  onChange={(tagline) => edit({ tagline })}
                />
                <BrandTextField
                  label="Description"
                  multiline
                  value={form.description ?? ''}
                  placeholder={defaults.description}
                  max={BRAND_LIMITS.description}
                  hint="Shows in link previews when someone shares a link to the app."
                  onChange={(description) => edit({ description })}
                />
              </Group>

              <Group title="Logo">
                <p className="-mt-2 text-xs leading-relaxed text-zinc-400">
                  A horizontal logo for the sidebar, sign-in page, emails and invoices, and a square one for the browser tab.
                  Each has a light and a dark theme version. Leave a dark one empty and the light one is used.
                </p>
                <LogoSlots title="Horizontal">
                  <LogoField
                    kind="light"
                    label="Light theme"
                    fullName={LOGO_NAME.light}
                    usage="Used in the sign-in page in light mode and light invoice PDFs."
                    url={saved.logoLightUrl}
                    emptyNote="Empty, so your name shows as text"
                    name={preview.name}
                    brand600={preview.colors.brand[600]}
                    disabled={!!migration}
                    {...logos.light}
                    onFile={(file) => { void upload('light', file); }}
                    onRemove={() => { void remove('light'); }}
                  />
                  <LogoField
                    kind="dark"
                    label="Dark theme"
                    fullName={LOGO_NAME.dark}
                    usage="Used in the sidebar, the client portal, emails and standard invoice PDFs."
                    url={saved.logoDarkUrl}
                    fallbackUrl={saved.logoLightUrl}
                    emptyNote="Empty, so your name shows as text"
                    fallbackNote="Empty, so the light theme logo is used"
                    name={preview.name}
                    brand600={preview.colors.brand[600]}
                    invert={form.invertLogoInSidebar}
                    disabled={!!migration}
                    {...logos.dark}
                    onFile={(file) => { void upload('dark', file); }}
                    onRemove={() => { void remove('dark'); }}
                  />
                </LogoSlots>
                <LogoSlots title="Square">
                  <LogoField
                    kind="favicon"
                    label="Light theme"
                    fullName={LOGO_NAME.favicon}
                    usage="Used as the browser tab icon (the favicon) and on the loading screen."
                    url={saved.faviconUrl}
                    cropUrl={saved.logoLightUrl}
                    emptyNote="Empty, so the tab icon is your name's first letter on your color"
                    fallbackNote="Empty, so the tab icon is a square crop of your horizontal logo"
                    name={preview.name}
                    brand600={preview.colors.brand[600]}
                    disabled={!!migration}
                    {...logos.favicon}
                    onFile={(file) => { void upload('favicon', file); }}
                    onRemove={() => { void remove('favicon'); }}
                  />
                  <LogoField
                    kind="square_dark"
                    label="Dark theme"
                    fullName={LOGO_NAME.square_dark}
                    usage="Used as the tab icon in a dark browser and on the loading screen in dark mode."
                    url={saved.squareDarkUrl}
                    fallbackUrl={saved.faviconUrl}
                    cropUrl={saved.faviconUrl ? null : saved.logoLightUrl}
                    emptyNote="Empty, so the light theme tab icon is used"
                    fallbackNote="Empty, so the light theme square logo is used"
                    name={preview.name}
                    brand600={preview.colors.brand[600]}
                    disabled={!!migration}
                    {...logos.square_dark}
                    onFile={(file) => { void upload('square_dark', file); }}
                    onRemove={() => { void remove('square_dark'); }}
                  />
                </LogoSlots>
              </Group>

              <Group title="Color">
                <div>
                  <HexColorField
                    label="Brand color"
                    value={form.brandColor}
                    fallback={defaults.colors.brand[500]}
                    hint="Buttons, links, selected items and focus rings. The lighter and darker shades below are made from it."
                    onChange={(brandColor) => edit({ brandColor })}
                    onValidityChange={validity('brand')}
                    disabled={!!migration}
                  />
                  <ShadeStrip scale={preview.colors.brand} overrides={overrides} />
                  <ContrastLine shade600={preview.colors.brand[600]} />

                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="-ml-2.5"
                      aria-expanded={shadesOpen}
                      aria-controls={shadesId}
                      onClick={() => setShadesToggled(!shadesOpen)}
                      icon={<ChevronDown size={13} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${shadesOpen ? 'rotate-180' : ''}`} />}
                    >
                      Customize shades{overrideCount > 0 ? ` (${overrideCount} changed)` : ''}
                    </Button>
                    {shadesOpen && (
                      <div id={shadesId} className="mt-3 rounded-xl bg-white/[0.03] p-3.5 ring-1 ring-inset ring-white/[0.06]">
                        <p className="text-xs text-zinc-400">Change one shade if it doesn&apos;t look right. Leave a shade empty to use the one made from your brand color.</p>
                        <div className="mt-3.5 grid grid-cols-1 gap-4 @md:grid-cols-2">
                          {BRAND_SHADES.map((shade) => (
                            <HexColorField
                              key={shade}
                              size="sm"
                              label={`Shade ${shade}`}
                              value={overrides[shade] ?? null}
                              fallback={generated[shade]}
                              resetLabel="Reset"
                              onChange={(value) => setShade(shade, value)}
                              onValidityChange={validity(`shade-${shade}`)}
                              disabled={!!migration}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <HexColorField
                  label="Accent color"
                  value={form.accentColor}
                  fallback={accentFallback}
                  hint="Used sparingly, like the Dashboard welcome. Left empty, it is your brand's darkest shade."
                  onChange={(accentColor) => edit({ accentColor })}
                  onValidityChange={validity('accent')}
                  disabled={!!migration}
                />
              </Group>

              <Group title="Sidebar">
                <ul className="divide-y divide-white/[0.06]">
                  <SwitchRow
                    label="Show the name under the logo"
                    description="Prints your name in small letters under the logo, for a mark without words."
                    checked={form.showNameUnderLogo}
                    onChange={(showNameUnderLogo) => edit({ showNameUnderLogo })}
                  />
                  <SwitchRow
                    label="Invert the logo in the sidebar"
                    description="Flips the logo's colors, so a dark logo shows on the dark sidebar. Not needed with a dark-background logo."
                    checked={form.invertLogoInSidebar}
                    onChange={(invertLogoInSidebar) => edit({ invertLogoInSidebar })}
                  />
                  <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="text-sm font-medium text-zinc-100">Projects item</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                        Page opens the Projects page, for many client projects. Menu folds every active project under Projects, so a team with a few opens one from anywhere.
                      </p>
                    </div>
                    <RadioGroup
                      ariaLabel="Projects item"
                      orientation="horizontal"
                      className="mt-0.5 flex-shrink-0"
                      value={form.sidebarProjects}
                      onChange={(sidebarProjects) => edit({ sidebarProjects })}
                      options={[
                        { value: 'list', label: 'Page' },
                        { value: 'menu', label: 'Menu' },
                      ]}
                    />
                  </li>
                  <SwitchRow
                    label="Show active projects"
                    description="Lists your first five active projects in their own section below the menu, one click from any page."
                    checked={form.sidebarActiveProjects}
                    onChange={(sidebarActiveProjects) => edit({ sidebarActiveProjects })}
                  />
                </ul>
              </Group>
            </fieldset>

            <aside aria-label="Preview" className="min-w-0 @2xl:sticky @2xl:top-6 @2xl:self-start">
              <BrandPreview brand={preview} dirty={dirty} />
            </aside>
          </div>

          <div className="mt-8 border-t border-white/[0.06] pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">Reset to default</p>
                <p className="mt-0.5 text-xs text-zinc-400">Sets the name, colors and sidebar options back to the defaults (the Projects page, with active projects shown). Logos stay; remove them one by one above.</p>
              </div>
              <Button
                variant="secondary"
                onClick={() => { void resetAll(); }}
                disabled={locked || (!hasCustomValues(savedInput) && !dirty)}
              >
                Reset
              </Button>
            </div>
            {resetLine && <OutcomeLine outcome={resetLine} busy={saving} className="mt-3" />}
          </div>

          {(dirty || bar) && (
            <SaveBar
              dirty={dirty}
              saving={saving}
              blocked={migration
                ? 'Your changes can be saved once the database is up to date.'
                : invalid.size > 0 ? 'Fix the color marked in red to save.' : null}
              outcome={bar}
              onSave={() => { void save(); }}
              onDiscard={discard}
            />
          )}
        </>
      )}
    </section>
  );
}

function Group({ title, first = false, children }: { title: string; first?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={first ? '' : 'mt-8 border-t border-white/[0.06] pt-6'}>
      <h3 id={id} className="text-sm font-semibold text-white">{title}</h3>
      <div className="mt-4 space-y-6">{children}</div>
    </div>
  );
}

/** One logo shape's two slots, light theme then dark. */
function LogoSlots({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <h4 id={id} className="text-xs font-medium text-zinc-300">{title}</h4>
      <div className="mt-3 space-y-5">{children}</div>
    </div>
  );
}

/** The 50 to 700 scale as it will be used, a dot marking each shade changed by hand. */
function ShadeStrip({ scale, overrides }: { scale: BrandScale; overrides: Partial<BrandScale> }) {
  return (
    <div className="mt-4">
      <ul aria-label="Shades made from your brand color" className="grid grid-cols-8 gap-1">
        {BRAND_SHADES.map((shade) => (
          <li key={shade} className="min-w-0">
            <span
              role="img"
              aria-label={`Shade ${shade}: ${scale[shade]}${overrides[shade] ? ', changed by hand' : ''}`}
              className="relative block h-8 rounded-md ring-1 ring-inset ring-black/10"
              style={{ background: scale[shade] }}
            >
              {overrides[shade] && (
                <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
              )}
            </span>
            <span aria-hidden="true" className="mt-1 block text-center text-[11px] tabular-nums text-zinc-400">{shade}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether white text reads on the primary button (brand 600, see .liquid-primary). */
function ContrastLine({ shade600 }: { shade600: string }) {
  const ratio = contrastRatio('#FFFFFF', shade600);
  const level = ratio >= 4.5 ? 'good' : ratio >= 3 ? 'light' : 'poor';
  const copy = {
    good: 'White text on buttons: easy to read',
    light: 'White text on buttons: a little light. A darker color reads better.',
    poor: 'White text on buttons: hard to read. Pick a darker color.',
  }[level];
  const Icon = level === 'good' ? Check : level === 'light' ? AlertTriangle : AlertCircle;
  return (
    <p
      className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs text-zinc-200 ${
        level === 'good' ? 'bg-white/[0.03]' : level === 'light' ? 'bg-amber-500/[0.1]' : 'bg-red-500/[0.1]'
      }`}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className={`mt-px flex-shrink-0 ${level === 'good' ? 'text-emerald-300' : level === 'light' ? 'text-amber-300' : 'text-red-300'}`}
      />
      {/* Only the verdict is announced, so dragging the picker doesn't read out every ratio. */}
      <span aria-live="polite" className="min-w-0 flex-1">{copy}</span>
      <span className="flex-shrink-0 tabular-nums text-zinc-400">{ratio.toFixed(1)} to 1</span>
    </p>
  );
}

function SwitchRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <li className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="text-sm font-medium text-zinc-100">{label}</p>
        <p id={`${id}-description`} className="mt-0.5 text-xs leading-relaxed text-zinc-400">{description}</p>
      </div>
      <Toggle
        checked={checked}
        onChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="mt-0.5 flex-shrink-0"
      />
    </li>
  );
}

/**
 * Pinned to the bottom of the screen while anything is unsaved: what is
 * pending, Discard and Save. After a save it is the one line that says so.
 */
export function SaveBar({ dirty, saving, blocked, outcome, onSave, onDiscard }: {
  dirty: boolean;
  saving: boolean;
  /** Why Save is off, when it is (a color still marked red, the database not ready). */
  blocked: string | null;
  outcome: Outcome | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const error = outcome?.tone === 'error';
  const message = error ? outcome.text : dirty ? blocked ?? 'You have unsaved changes.' : outcome?.text ?? '';
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-6">
      <div className="glass-strong pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-3 shadow-[var(--shadow-overlay)] motion-safe:animate-fadeIn">
        <p role={error ? 'alert' : 'status'} className="flex min-w-0 flex-1 items-center gap-2 text-sm text-zinc-200">
          {error && <AlertCircle size={14} className="flex-shrink-0 text-red-300" aria-hidden="true" />}
          {!error && !dirty && <Check size={14} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />}
          <span className="min-w-0">{message}</span>
        </p>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>
            <Button
              onClick={onSave}
              disabled={saving || !!blocked}
              icon={saving ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : undefined}
            >
              {saving ? 'Saving...' : error ? 'Try again' : 'Save'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The page's own shape while the first read is out: four groups beside the preview. */
function BrandSkeleton() {
  const field = (key: string, wide = false) => (
    <div key={key} className="space-y-2">
      <div className="h-3 w-24 rounded bg-white/[0.06]" />
      <div className={`h-9 rounded-input bg-white/[0.03] ring-1 ring-inset ring-white/[0.06] ${wide ? 'h-[60px]' : ''}`} />
      <div className="h-2.5 w-3/4 rounded bg-white/[0.04]" />
    </div>
  );
  return (
    <div aria-busy="true" aria-label="Loading brand" className="grid grid-cols-1 gap-8 @2xl:grid-cols-[minmax(0,1fr)_17.5rem] @2xl:gap-10">
      <div className="min-w-0 motion-safe:animate-pulse">
        <div className="h-3 w-12 rounded bg-white/[0.05]" />
        <div className="mt-4 space-y-6">{['name', 'tagline'].map((key) => field(key))}{field('description', true)}</div>
        <div className="mt-8 border-t border-white/[0.06] pt-6">
          <div className="h-3 w-12 rounded bg-white/[0.05]" />
          <div className="mt-4 space-y-6">
            {['light', 'dark', 'favicon', 'square_dark'].map((key) => (
              <div key={key} className="space-y-2">
                <div className="h-3 w-40 rounded bg-white/[0.06]" />
                <div className="h-[90px] rounded-xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]" />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-8 border-t border-white/[0.06] pt-6">
          <div className="h-3 w-12 rounded bg-white/[0.05]" />
          <div className="mt-4 h-9 w-56 rounded-input bg-white/[0.03]" />
          <div className="mt-4 grid grid-cols-8 gap-1">
            {BRAND_SHADES.map((shade) => <div key={shade} className="h-8 rounded-md bg-white/[0.04]" />)}
          </div>
        </div>
      </div>
      <div className="min-w-0 space-y-3 motion-safe:animate-pulse">
        <div className="h-3 w-16 rounded bg-white/[0.05]" />
        <div className="h-10 rounded-lg bg-white/[0.03]" />
        <div className="h-[170px] rounded-xl bg-white/[0.03]" />
        <div className="h-[118px] rounded-xl bg-white/[0.03]" />
        <div className="h-[110px] rounded-xl bg-white/[0.03]" />
      </div>
    </div>
  );
}
