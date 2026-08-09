'use client';

import { useEffect, useId, useRef } from 'react';
import { Settings2, Video, Gamepad2, Gauge, Sparkles, Zap, X } from 'lucide-react';
import {
  SETTINGS_RANGES,
  type CameraMode,
  type SceneSettings,
} from './sceneSettings';

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
        <label htmlFor={id} className="text-[11px] font-medium text-zinc-200">
          {label}
        </label>
        <span className="text-[10px] font-mono tabular-nums text-brand-300">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
      />
      <p className="text-[10px] leading-snug text-zinc-500">{hint}</p>
    </div>
  );
}

/** One of the two camera-mode choices. */
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
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-mono tracking-[0.12em] uppercase transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2 ${
        active ? 'bg-white/[0.12] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      <Icon size={12} className={active ? 'text-brand-300' : undefined} aria-hidden="true" />
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SceneSettings;
  update: <K extends keyof SceneSettings>(key: K, value: SceneSettings[K]) => void;
  reset: () => void;
  cameraMode: CameraMode;
  onCameraModeChange: (mode: CameraMode) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
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

  const walking = cameraMode === 'manual';

  return (
    <div className="hidden lg:flex absolute top-4 left-4 z-20 flex-col items-start">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Settings"
        className="flex items-center gap-2 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 px-3 py-1.5 hover:bg-black/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
      >
        <Settings2 size={13} className={open ? 'text-brand-300' : 'text-zinc-400'} aria-hidden="true" />
        <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-zinc-300">Settings</span>
      </button>

      {/* Kept outside the panel: while you are actually walking the panel is
          closed (it has to be, or it eats the pointer), and these are the keys
          you need at exactly that moment. */}
      {walking && !open && (
        <p className="mt-2 rounded-lg bg-black/50 backdrop-blur-sm border border-white/10 px-2.5 py-1.5 text-[10px] font-mono text-zinc-400 leading-snug">
          Click to look around · WASD to walk
          <br />
          Shift to run · Esc for auto
        </p>
      )}

      {open && (
        <div
          ref={panelRef}
          className="mt-2 w-64 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 p-3.5 shadow-xl"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[10px] font-mono tracking-[0.18em] uppercase text-zinc-400">Settings</h2>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                buttonRef.current?.focus();
              }}
              aria-label="Close settings"
              className="rounded p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-zinc-200">Camera</span>
              <div className="flex gap-1 rounded-lg bg-white/[0.04] p-1" role="group" aria-label="Camera mode">
                <ModeOption
                  active={!walking}
                  onSelect={() => onCameraModeChange('auto')}
                  icon={Video}
                  label="Auto"
                />
                <ModeOption
                  active={walking}
                  // Walking needs the pointer, and a panel full of sliders
                  // would swallow both it and WASD — so choosing it closes
                  // the panel rather than leaving the two fighting.
                  onSelect={() => {
                    onCameraModeChange('manual');
                    onOpenChange(false);
                  }}
                  icon={Gamepad2}
                  label="Walking"
                />
              </div>
              <p className="text-[10px] leading-snug text-zinc-500">
                {walking
                  ? 'Click the scene to look around. WASD to walk, Shift to run, Esc to hand back.'
                  : 'The camera tours the floor on its own.'}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-zinc-200">Quality</span>
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
              <p className="text-[10px] leading-snug text-zinc-500">
                Each step up draws more pixels per frame. If turning on the spot judders or the
                speed seems to pulse, step down — that means the frame rate is fighting your
                monitor.
              </p>
            </div>

            <div className="h-px bg-white/[0.07]" />

            <Slider
              label="Look sensitivity"
              hint="How far the view turns per mouse movement, while walking."
              value={settings.lookSensitivity}
              onChange={(n) => update('lookSensitivity', n)}
              format={(n) => n.toFixed(2)}
              {...SETTINGS_RANGES.lookSensitivity}
            />
            <Slider
              label="Look smoothing"
              hint="Evens out how unevenly the browser delivers mouse movement. 0 is raw input."
              value={settings.lookSmoothing}
              onChange={(n) => update('lookSmoothing', n)}
              format={(n) => (n === 0 ? 'Off' : `${Math.round(n * 1000)} ms`)}
              {...SETTINGS_RANGES.lookSmoothing}
            />
            <Slider
              label="Field of view"
              hint="Lower is a longer lens: less distortion, tighter framing."
              value={settings.fov}
              onChange={(n) => update('fov', n)}
              format={(n) => `${n}°`}
              {...SETTINGS_RANGES.fov}
            />
            <Slider
              label="Walking speed"
              hint="Hold Shift to move faster than this."
              value={settings.walkSpeed}
              onChange={(n) => update('walkSpeed', n)}
              format={(n) => `${n.toFixed(1)} m/s`}
              {...SETTINGS_RANGES.walkSpeed}
            />

            <div className="flex items-start justify-between gap-3 pt-0.5">
              <div className="flex flex-col gap-0.5">
                <label htmlFor="auto-motion" className="text-[11px] font-medium text-zinc-200">
                  Auto camera motion
                </label>
                <p className="text-[10px] leading-snug text-zinc-500">
                  Off holds one composed frame instead of touring.
                </p>
              </div>
              <input
                id="auto-motion"
                type="checkbox"
                checked={settings.autoCameraMotion}
                onChange={(e) => update('autoCameraMotion', e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
              />
            </div>

            <button
              type="button"
              onClick={reset}
              className="mt-0.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-mono tracking-[0.14em] uppercase text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
