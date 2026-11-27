'use client';

import { FlaskConical } from 'lucide-react';
import { useDemo } from '@/lib/demo-context';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Toggle } from '@/components/ui/inputs/Toggle';

/** Swaps live data for sample data on this device. */
export function DemoModeSection() {
  const { isDemoMode, toggleDemoMode } = useDemo();

  return (
    <section id="demo-mode" className="glass-card h-full rounded-xl p-4 lg:p-5 scroll-mt-6">
      <SettingsSectionHeader icon={FlaskConical} title="Demo mode" description="See the app with sample data, to show it or try it out." />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-zinc-300">Use sample data</p>
          <p className="mt-0.5 text-xs text-zinc-400">Replaces live data with sample data. Changes are not saved.</p>
        </div>
        <Toggle checked={isDemoMode} onChange={() => toggleDemoMode()} aria-label="Use sample data" />
      </div>
    </section>
  );
}
