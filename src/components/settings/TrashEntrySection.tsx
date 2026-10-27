import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/** Everyone: what you deleted (and may restore) waits in Trash. */
export function TrashEntrySection() {
  return (
    <section id="trash" className="glass-card rounded-xl p-4 lg:p-6 scroll-mt-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-brand-500/15 rounded-lg">
            <Trash2 className="text-brand-300" size={20} aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-semibold text-white">Trash</h2>
            <p className="text-sm text-zinc-400">Deleted projects, tasks, invoices and more. Nothing is ever permanently deleted, so you can restore any of it.</p>
          </div>
        </div>
        <Button href="/settings/trash" variant="secondary" className="sm:flex-shrink-0">Open Trash</Button>
      </div>
    </section>
  );
}
