'use client';

import { FlaskConical } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';

/** Swaps live data for sample data on this device. */
export function DemoModeSection() {
  const { isDemoMode, toggleDemoMode } = useDemo();

  return (
    <section id="demo-mode" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-amber-500/15 rounded-lg">
          <FlaskConical className="text-amber-400" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-white">Demo Mode</h2>
          <p className="text-sm text-zinc-400">View the app with sample data</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-zinc-300">Enable demo mode</p>
          <p className="text-xs text-zinc-400 mt-0.5">
            Replaces live data with sample data. Changes won&apos;t be saved.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isDemoMode}
          aria-label="Enable demo mode"
          onClick={toggleDemoMode}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            isDemoMode ? 'bg-amber-500' : 'bg-white/[0.08]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-surface-raised transition-transform ${
              isDemoMode ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </section>
  );
}
