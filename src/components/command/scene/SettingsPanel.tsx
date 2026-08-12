'use client';

import { useEffect, useId, useRef } from 'react';
import { Settings2, Video, Gamepad2, Gauge, Sparkles, Zap, X } from 'lucide-react';
import type { CameraMode, SceneRanges, SceneSettings } from './sceneSettings';

/**
 * Every viewer control for the live floor in one place: who drives the camera,
 * look sensitivity, field of view, walking pace, and whether the auto camera
 * moves at all.
 *
 * The camera mode used to be its own always-visible pill in the opposite
 * corner. Two floating controls for one concern is one too many — and the
 * mode is the setting the others qualify (sensitivity and walk speed only mean
 * anything on foot), so it belongs at the top of this list rather than across
 * the screen from it.
 *
 * A DOM overlay rather than anything in the canvas: a slider needs to be a
 * real focusable input with a real label, and reimplementing that in WebGL
 * would lose keyboard access and screen-reader support for no benefit.
 *
 * ── Two presentations, one set of controls ───────────────────────────────────
 *
 * The whole panel used to be `hidden lg:flex`, trigger button included, so on a
 * phone there was no settings UI at all — not a cramped one, none. Nothing
 * could be changed and the camera could only be watched.
 *
 * It is now a popover on a pointer device and a bottom sheet on a touch one —
 * one or the other, chosen by input rather than by a CSS breakpoint. Rendering
 * both and hiding one with `lg:hidden` put the same controls in the DOM twice,
 * which duplicated every `useId` and left each `<label for>` pointing at two
 * inputs, one of them invisible.
 * A sheet rather than a shrunken popover because the controls sit over a canvas
 * that fills the screen: anchoring them to the bottom edge puts them under the
 * thumb and leaves the scene visible above, which is the point of changing a
 * setting here — you want to see what it did.
 *
 * Which controls appear depends on the input, not the screen width. Look
 * smoothing is the only pointer-only one left: it describes how a browser
 * delivers *mouse* movement, and the touch walker smooths at its own fixed
 * rate. Everything else applies to both, walking speed included now that a
 * thumbstick exists to set a pace for.
 */

function Slider({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs lg:text-[11px] font-medium text-zinc-200">
          {label}
        </label>
        <span className="text-[11px] lg:text-[10px] font-mono tabular-nums text-brand-300">{format(value)}</span>
      </div>
      {/* `py-2 lg:py-0` widens the grab area on touch without moving the track:
          a range input's thumb is the only hit target it has, and at the
          default height it is well under a comfortable finger. */}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full py-2 lg:py-0 accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
      />
      <p className="text-[11px] lg:text-[10px] leading-snug text-zinc-500">{hint}</p>
    </div>
  );
}

/** One choice in a segmented row (camera mode, quality). */
function ModeOption({
  active,
  onSelect,
  icon: Icon,
  label,
}: {
  active: boolean;
  onSelect: () => void;
  icon: typeof Video;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-2.5 lg:py-1.5 text-[11px] lg:text-[10px] font-mono tracking-[0.12em] uppercase transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2 ${
        active ? 'bg-white/[0.12] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      <Icon size={13} className={active ? 'text-brand-300' : undefined} aria-hidden="true" />
      {label}
    </button>
  );
}

export function SettingsPanel({
  open,
  onOpenChange,
  settings,
  update,
  reset,
  cameraMode,
  onCameraModeChange,
  coarsePointer,
  ranges,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SceneSettings;
  update: <K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) => void;
  reset: () => void;
  cameraMode: CameraMode;
  onCameraModeChange: (mode: CameraMode) => void;
  /** Finger rather than mouse — decides the layout AND which controls apply. */
  coarsePointer: boolean;
  /** Slider bounds for the active profile: a phone allows a far wider field of view. */
  ranges: SceneRanges;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the panel — but only when it's open, so this never competes
  // with pointer-lock's own Escape handling while walking.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onOpenChange(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onOpenChange]);

  const driving = cameraMode === 'manual';
  const close = () => {
    onOpenChange(false);
    buttonRef.current?.focus();
  };

  const body = (
    <div className="flex flex-col gap-4 lg:gap-3.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs lg:text-[11px] font-medium text-zinc-200">Camera</span>
        {/* Walking first: it is the default mode on both live pages now, and
            the segment reads default-then-alternative left to right. */}
        <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1" role="group" aria-label="Camera mode">
          <ModeOption
            active={driving}
            // On a pointer device this needs the mouse and WASD, and a panel
            // full of sliders would swallow both — so choosing it closes the
            // panel rather than leaving the two fighting. On touch the sheet
            // covers the canvas you would be dragging, so it closes there too.
            onSelect={() => {
              onCameraModeChange('manual');
              onOpenChange(false);
            }}
            icon={Gamepad2}
            label={coarsePointer ? 'Walk' : 'Walking'}
          />
          <ModeOption
            active={!driving}
            onSelect={() => onCameraModeChange('auto')}
            icon={Video}
            label="Auto"
          />
        </div>
        <p className="text-[11px] lg:text-[10px] leading-snug text-zinc-500">
          {driving
            ? coarsePointer
              ? 'Drag to look, stick to walk. Tap Auto to hand it back.'
              : 'Click the scene to look around. WASD to walk, Shift to run. Esc frees the cursor; click to walk again.'
            : 'The camera tours the floor on its own.'}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs lg:text-[11px] font-medium text-zinc-200">Quality</span>
        <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1" role="group" aria-label="Render quality">
          <ModeOption
            active={settings.quality === 'performance'}
            onSelect={() => update('quality', 'performance')}
            icon={Zap}
            label="Fast"
          />
          <ModeOption
            active={settings.quality === 'balanced'}
            onSelect={() => update('quality', 'balanced')}
            icon={Gauge}
            label="Even"
          />
          <ModeOption
            active={settings.quality === 'high'}
            onSelect={() => update('quality', 'high')}
            icon={Sparkles}
            label="Sharp"
          />
        </div>
        <p className="text-[11px] lg:text-[10px] leading-snug text-zinc-500">
          Each step up draws more pixels per frame. If turning on the spot judders or the
          speed seems to pulse, step down — that means the frame rate is fighting your
          screen.
        </p>
      </div>

      <div className="h-px bg-white/[0.07]" />

      <Slider
        label="Look sensitivity"
        hint={
          coarsePointer
            ? 'How far the view turns per drag.'
            : 'How far the view turns per mouse movement, while walking.'
        }
        value={settings.lookSensitivity}
        onChange={(n) => update('lookSensitivity', n)}
        format={(n) => n.toFixed(2)}
        {...ranges.lookSensitivity}
      />

      {/* Pointer-only: this evens out how a browser delivers MOUSE movement.
          The touch walker does its own smoothing at a fixed rate. */}
      {!coarsePointer && (
        <Slider
          label="Look smoothing"
          hint="Evens out how unevenly the browser delivers mouse movement. 0 is raw input."
          value={settings.lookSmoothing}
          onChange={(n) => update('lookSmoothing', n)}
          format={(n) => (n === 0 ? 'Off' : `${Math.round(n * 1000)} ms`)}
          {...ranges.lookSmoothing}
        />
      )}

      <Slider
        label="Walking speed"
        hint={
          coarsePointer
            ? 'Top pace at full stick. Push it halfway to stroll.'
            : 'Hold Shift to move faster than this.'
        }
        value={settings.walkSpeed}
        onChange={(n) => update('walkSpeed', n)}
        format={(n) => `${n.toFixed(1)} m/s`}
        {...ranges.walkSpeed}
      />

      <Slider
        label="Field of view"
        hint="Lower is a longer lens: less distortion, tighter framing."
        value={settings.fov}
        onChange={(n) => update('fov', n)}
        format={(n) => `${n}°`}
        {...ranges.fov}
      />

      <div className="flex items-start justify-between gap-3 pt-0.5">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="auto-motion" className="text-xs lg:text-[11px] font-medium text-zinc-200">
            Auto camera motion
          </label>
          <p className="text-[11px] lg:text-[10px] leading-snug text-zinc-500">
            Off holds one composed frame instead of touring.
          </p>
        </div>
        <input
          id="auto-motion"
          type="checkbox"
          checked={settings.autoCameraMotion}
          onChange={(e) => update('autoCameraMotion', e.target.checked)}
          className="mt-0.5 h-5 w-5 lg:h-4 lg:w-4 shrink-0 accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
        />
      </div>

      <button
        type="button"
        onClick={reset}
        className="mt-0.5 rounded-lg border border-white/10 px-2.5 py-2.5 lg:py-1.5 text-[11px] lg:text-[10px] font-mono tracking-[0.14em] uppercase text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
      >
        Reset to defaults
      </button>
    </div>
  );

  const heading = (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[10px] font-mono tracking-[0.18em] uppercase text-zinc-400">Settings</h2>
      <button
        type="button"
        onClick={close}
        aria-label="Close settings"
        className="-m-2 rounded p-2 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <>
      <div className="absolute top-4 left-4 z-20 flex flex-col items-start">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-label="Settings"
          className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 px-3 py-2 lg:py-1.5 hover:bg-black/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
        >
          <Settings2 size={14} className={open ? 'text-brand-300' : 'text-zinc-400'} aria-hidden="true" />
          <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-zinc-300">Settings</span>
        </button>

        {/* Pointer only. Kept outside the panel because while you are actually
            driving the camera the panel is closed (it has to be, or it eats the
            pointer), and these are the keys you need at exactly that moment.

            Touch does not get an equivalent: the thumbstick is visible on
            screen and dragging to look is the first thing anyone tries, so the
            caption was labelling controls that already explain themselves —
            and doing it in the one corner of a phone screen there is no room
            to spare. */}
        {driving && !open && !coarsePointer && (
          <p className="mt-2 rounded-lg bg-black/50 backdrop-blur-sm border border-white/10 px-2.5 py-1.5 text-[10px] font-mono text-zinc-400 leading-snug">
            Click to look around · WASD to walk
            <br />
            Shift to run · Esc for cursor
          </p>
        )}

        {/* Pointer device: a popover hanging off the button. */}
        {open && !coarsePointer && (
          <div className="mt-2 w-64 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 p-3.5 shadow-xl">
            {heading}
            {body}
          </div>
        )}
      </div>

      {/* Touch device: a bottom sheet. Absolute rather than fixed so it stays
          inside the scene's rounded, clipped container instead of spilling over
          the page padding around it. */}
      {open && coarsePointer && (
        <>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            className="absolute inset-0 z-20 bg-black/50 backdrop-blur-[2px]"
          />
          <div
            role="dialog"
            aria-label="Settings"
            className="absolute inset-x-0 bottom-0 z-30 max-h-[80%] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-black/85 backdrop-blur-md p-4 pb-6 shadow-2xl"
          >
            {/* Grab handle: the one affordance that says "this pulls up from the
                bottom" before anything is read. */}
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/20" aria-hidden="true" />
            {heading}
            {body}
          </div>
        </>
      )}
    </>
  );
}
