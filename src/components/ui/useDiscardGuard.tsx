'use client';

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

/**
 * Closing a form with unsaved edits asks first: the edits live only in the
 * form, so they cannot be brought back. Leaving the page warns too. The one
 * guard every side panel form uses (Edit project, a template, an initiative).
 * Render `dialog` beside the form (TaskPanelShell's `after`) and close with
 * `requestClose`.
 */
export function useDiscardGuard(dirty: boolean, onClose: () => void, message = 'Your edits are not saved. Discarding them cannot be undone.') {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const dialog = (
    <ConfirmDialog
      isOpen={confirmDiscard}
      onClose={() => setConfirmDiscard(false)}
      onConfirm={onClose}
      title="Discard changes?"
      message={message}
      confirmLabel="Discard"
      doubleConfirm={false}
    />
  );

  return { requestClose, dialog };
}
