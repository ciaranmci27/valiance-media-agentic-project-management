'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { ReminderComposer, type ReminderDraft } from './ReminderComposer';

/** A quiet "Add reminder" row that opens the composer in place; Escape on an empty field folds it away. */
export function AddReminderRow({ onAdd, placeholder }: { onAdd: (draft: ReminderDraft) => void; placeholder: string }) {
  const [adding, setAdding] = useState(false);
  if (adding) {
    return <ReminderComposer onAdd={onAdd} placeholder={placeholder} autoFocus onCancel={() => setAdding(false)} />;
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="w-full flex items-center gap-2 -mx-2 px-2 py-1.5 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <Plus size={16} aria-hidden="true" />
      Add reminder
    </button>
  );
}
