'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** Ref to the trigger element the menu anchors to. Read inside effects, never during render. */
  anchorRef: { readonly current: HTMLElement | null };
  open: boolean;
  onClose: () => void;
  /** Horizontal alignment relative to the anchor. */
  align?: 'start' | 'end';
  /** Menu width in px (clamped to the viewport). Defaults to 256. */
  width?: number;
  /** Match the anchor's width instead of `width` (for full-width select/search dropdowns). */
  matchAnchorWidth?: boolean;
  /** Gap below the anchor in px. */
  gap?: number;
  /** Classes for the menu surface (background, border, radius, shadow, etc.). */
  className?: string;
  /** Clicks inside elements matching this selector won't close the popover (e.g. nested portals). */
  ignoreOutsideSelector?: string;
  children: ReactNode;
}

interface Pos { top: number; left: number; width: number; maxHeight: number }

/**
 * A menu/dropdown surface rendered through a portal to `document.body` with
 * `position: fixed`, so it can never be clipped by an ancestor's `overflow`,
 * `transform`, or `backdrop-filter` stacking context. This is the reason iOS
 * Safari clipped the old inline `absolute` menus while desktop Chrome didn't.
 *
 * The caller controls open state and the trigger; this handles positioning,
 * outside-click, Escape, and repositioning on scroll/resize.
 */
export function Popover({
  anchorRef,
  open,
  onClose,
  align = 'end',
  width = 256,
  matchAnchorWidth = false,
  gap = 6,
  className = '',
  ignoreOutsideSelector,
  children,
}: PopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(matchAnchorWidth ? rect.width : width, vw - 16);
    let left = align === 'end' ? rect.right - w : rect.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const top = rect.bottom + gap;
    setPos({ top, left, width: w, maxHeight: Math.max(120, vh - top - 8) });
  }, [anchorRef, align, width, matchAnchorWidth, gap]);

  useLayoutEffect(() => {
    if (!open) return;
    // Measure the anchor's layout and position the menu before paint.
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      if (ignoreOutsideSelector && (target as HTMLElement).closest?.(ignoreOutsideSelector)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef, onClose, ignoreOutsideSelector]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={`fixed z-[9999] overflow-y-auto animate-scaleIn ${className}`}
      style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  );
}
