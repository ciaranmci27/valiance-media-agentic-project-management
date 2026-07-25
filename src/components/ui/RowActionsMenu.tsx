'use client';

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'success';
}

interface RowActionsMenuProps {
  actions: RowAction[];
  /** Accessible label for the trigger, e.g. "Actions for Jane Doe" */
  label?: string;
}

const MENU_WIDTH = 176;

/**
 * A "..." trigger that opens a dropdown menu rendered through a portal, so it
 * never gets clipped by a table's overflow container. Used for per-row actions
 * (edit / delete / convert, etc.).
 */
export function RowActionsMenu({ actions, label = 'Row actions' }: RowActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estHeight = actions.length * 40 + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < estHeight && rect.top > estHeight;
    setPos({
      top: openAbove ? rect.top - estHeight - 4 : rect.bottom + 4,
      left: Math.max(8, rect.right - MENU_WIDTH),
    });
  }, [actions.length]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onScroll = () => updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePosition]);

  const variantClass = (variant?: RowAction['variant']) => {
    switch (variant) {
      case 'danger': return 'text-red-400 hover:bg-red-500/10';
      case 'success': return 'text-emerald-400 hover:bg-emerald-500/10';
      default: return 'text-zinc-200 hover:bg-white/[0.06]';
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v); }}
        className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]"
      >
        <MoreVertical size={16} />
      </button>

      {open && createPortal(
        <>
          <div
            className="fixed inset-0 z-[9998] cursor-default"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
          />
          <div
            role="menu"
            className="fixed z-[9999] bg-surface-overlay rounded-lg shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] border border-white/10 py-1 animate-scaleIn origin-top-right"
            style={{ top: pos.top, left: pos.left, minWidth: MENU_WIDTH }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setOpen(false);
                  action.onClick();
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${variantClass(action.variant)}`}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
