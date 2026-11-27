import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';

/** Everyone: what you deleted (and may restore) waits in Trash. */
export function TrashEntrySection() {
  return (
    <section id="trash" className="glass-card h-full rounded-xl p-4 lg:p-5 scroll-mt-6">
      <SettingsSectionHeader
        icon={Trash2}
        title="Trash"
        description="Deleted projects, tasks, files and more. Nothing is ever permanently deleted, so you can restore any of it."
        action={<Button href="/settings/trash" size="sm" variant="secondary" className="flex-shrink-0">Open Trash</Button>}
      />
    </section>
  );
}
