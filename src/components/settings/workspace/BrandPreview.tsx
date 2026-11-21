'use client';

import type { CSSProperties } from 'react';
import { FolderKanban, Inbox, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { BRAND_SHADES, type Brand } from '@/lib/brand';
import { faviconLetter } from './brand-settings';
import { EMAIL_CARD, EMAIL_INK, EMAIL_RULE } from './brand-paper';

/** Every brand variable, for a subtree that must show the draft rather than the saved brand. */
function allVars(brand: Brand): CSSProperties {
  const vars: Record<string, string> = { '--color-accent': brand.colors.accent };
  for (const shade of BRAND_SHADES) vars[`--color-brand-${shade}`] = brand.colors.brand[shade];
  return vars as CSSProperties;
}

/**
 * The page-surface part of the preview. The light theme points the text
 * shades (200 to 400) at darker ones so links stay legible on white; an
 * inline value would undo that, so those three go through classes that keep
 * the remap in light and use the draft in dark.
 */
function surfaceVars(brand: Brand): CSSProperties {
  const scale = brand.colors.brand;
  return {
    '--color-accent': brand.colors.accent,
    '--color-brand-50': scale[50],
    '--color-brand-100': scale[100],
    '--color-brand-500': scale[500],
    '--color-brand-600': scale[600],
    '--color-brand-700': scale[700],
    '--pv-200': scale[200],
    '--pv-300': scale[300],
    '--pv-400': scale[400],
  } as CSSProperties;
}

const SURFACE_TEXT_SHADES =
  '[--color-brand-200:var(--color-brand-700)] [--color-brand-300:var(--color-brand-700)] [--color-brand-400:var(--color-brand-600)] '
  + 'dark:[--color-brand-200:var(--pv-200)] dark:[--color-brand-300:var(--pv-300)] dark:[--color-brand-400:var(--pv-400)]';

/**
 * What the brand looks like before it is saved: the browser tab, the
 * always-dark sidebar, the app's controls in the brand color, and an email
 * header on white. Pictures only: nothing in it can be focused or clicked.
 */
export function BrandPreview({ brand, dirty }: { brand: Brand; dirty: boolean }) {
  const sidebarLogo = brand.logos.dark ?? brand.logos.light;
  const title = `${brand.name} | ${brand.tagline}`;

  return (
    <div role="group" aria-labelledby="brand-preview-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id="brand-preview-title" className="text-xs font-medium uppercase tracking-wide text-zinc-400">Preview</h3>
        {dirty && (
          <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-200">Unsaved</span>
        )}
      </div>
      <p className="sr-only">How your name, logo and colors look in the app and in emails. It updates as you edit.</p>

      <div aria-hidden="true" inert className={`grid gap-3 ${SURFACE_TEXT_SHADES}`} style={surfaceVars(brand)}>
        {/* Browser tab: the favicon, then name and tagline as the tab title. */}
        <div>
          <p className="mb-1.5 text-[11px] text-zinc-400">Browser tab</p>
          <div className="flex items-end rounded-lg bg-white/[0.03] px-2 pt-2 ring-1 ring-inset ring-white/[0.06]">
            <div className="flex min-w-0 max-w-full items-center gap-2 rounded-t-md bg-white/[0.07] px-2.5 py-1.5">
              {brand.logos.favicon ? (
                // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is
                <img src={brand.logos.favicon} alt="" className="h-4 w-4 flex-shrink-0 object-contain" />
              ) : (
                <span
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[10px] font-bold leading-none text-white"
                  style={{ background: brand.colors.brand[600], borderRadius: '22%' }}
                >
                  {faviconLetter(brand.name)}
                </span>
              )}
              <span className="min-w-0 truncate text-xs text-zinc-200">{title}</span>
            </div>
          </div>
        </div>

        {/* Sidebar: always dark, with the draft's own shades (inline beats the dark theme's injected ones). */}
        <div>
          <p className="mb-1.5 text-[11px] text-zinc-400">Sidebar</p>
          <div data-theme="dark" style={allVars(brand)} className="glass-sidebar overflow-hidden rounded-xl border border-white/[0.06]">
            <div className="flex h-16 items-center border-b border-white/[0.06] px-5">
              {sidebarLogo ? (
                <div className="flex w-full min-w-0 flex-col">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is */}
                  <img src={sidebarLogo} alt="" className={`h-9 w-full object-contain ${brand.invertLogoInSidebar ? 'invert' : ''}`} />
                  {brand.showNameUnderLogo && (
                    <span className="w-full truncate text-center text-[7px] font-semibold uppercase tracking-[0.2em] text-white">{brand.name}</span>
                  )}
                </div>
              ) : (
                <span className="min-w-0 truncate text-lg font-bold tracking-tight text-white">{brand.name}</span>
              )}
            </div>
            <ul className="space-y-0.5 p-2">
              <li className="flex items-center gap-3 rounded-lg bg-brand-500/15 px-3 py-2 text-brand-300 glow-brand-soft">
                <LayoutDashboard size={16} />
                <span className="text-sm font-medium">Dashboard</span>
              </li>
              <li className="flex items-center gap-3 rounded-lg px-3 py-2 text-zinc-400">
                <FolderKanban size={16} />
                <span className="text-sm font-medium">Projects</span>
              </li>
              <li className="flex items-center gap-3 rounded-lg px-3 py-2 text-zinc-400">
                <Inbox size={16} />
                <span className="text-sm font-medium">Inbox</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Controls on the page: the two buttons, a link, and the focus ring. */}
        <div>
          <p className="mb-1.5 text-[11px] text-zinc-400">Buttons and links</p>
          <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.06]">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" tabIndex={-1}>Primary</Button>
              <Button size="sm" variant="secondary" tabIndex={-1}>Secondary</Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-400">
              Open the <span className="text-brand-300 underline underline-offset-2">Website redesign</span> project.
            </p>
            <div className="mt-3 flex items-center gap-2.5">
              <span className="rounded-md px-2.5 py-1 text-xs text-zinc-200 outline outline-2 outline-offset-2 outline-brand-400">Focused</span>
              <span className="text-[11px] text-zinc-400">Keyboard focus ring</span>
            </div>
          </div>
        </div>

        {/* Email header: emails are dark in every theme, with the dark logo (the light one when there is none). */}
        <div>
          <p className="mb-1.5 text-[11px] text-zinc-400">Email</p>
          <div className="overflow-hidden rounded-xl px-5 py-4" style={{ background: EMAIL_CARD, color: EMAIL_INK, boxShadow: `inset 0 0 0 1px ${EMAIL_RULE}` }}>
            {brand.logos.dark ? (
              // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host, shown as is
              <img src={brand.logos.dark} alt="" className="h-[30px] w-auto max-w-[220px] object-contain object-left" />
            ) : (
              <p className="truncate text-lg font-semibold leading-[30px]">{brand.name}</p>
            )}
            <div className="mt-4 h-px" style={{ background: EMAIL_RULE }} />
            <div className="mt-4 space-y-2">
              <div className="h-2 w-3/4 rounded-full" style={{ background: EMAIL_RULE }} />
              <div className="h-2 w-1/2 rounded-full" style={{ background: EMAIL_RULE }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
