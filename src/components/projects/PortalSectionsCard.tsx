'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, LayoutTemplate } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { isClientBillable } from '@/lib/time-entry-utils';
import { DEFAULT_SECTION_ORDER, PORTAL_SECTION_LABELS, type PortalSectionKey } from '@/lib/types';

// The portal is two columns on desktop: these fill the main column, the rest
// sit in its sidebar. Order applies within each column, top to bottom on phones.
const MAIN_COLUMN = new Set<PortalSectionKey>(['show_progress', 'show_invoices', 'show_hours', 'show_updates']);

/**
 * The client's portal page in outline: its main column and sidebar, each
 * section with its switch and a plain line saying whether the client sees it
 * right now and why. Mirrors the portal's own rules (app/portal/[token]):
 * Progress needs start and due dates, list sections need something in them.
 */
export function PortalSectionsCard({ projectId }: { projectId: string }) {
  const {
    getPortalSettings, upsertPortalSettings, getProject, getInvoicesByProject,
    getTimeEntriesByProject, getPortalUpdates, getEntityFiles,
  } = useApp();
  const settings = getPortalSettings(projectId);
  const project = getProject(projectId);

  const savedOrder = settings?.section_order ?? DEFAULT_SECTION_ORDER;
  const [order, setOrder] = useState<PortalSectionKey[]>([...savedOrder]);
  // A saved order from elsewhere replaces the local one, adjusted during render.
  const [syncedOrder, setSyncedOrder] = useState(savedOrder);
  if (savedOrder !== syncedOrder) {
    setSyncedOrder(savedOrder);
    setOrder([...savedOrder]);
  }

  // Pointer-event drag to reorder. Order only matters within a column, so a
  // row can only be dropped among its own column's rows.
  const [draggedKey, setDraggedKey] = useState<PortalSectionKey | null>(null);
  const dragKeyRef = useRef<PortalSectionKey | null>(null);
  const lastTargetRef = useRef<PortalSectionKey | null>(null);
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);

  const startDrag = useCallback(
    (key: PortalSectionKey, e: React.PointerEvent) => {
      e.preventDefault();
      dragKeyRef.current = key;
      lastTargetRef.current = null;
      setDraggedKey(key);

      const handleMove = (moveEvent: PointerEvent) => {
        const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const targetKey = el?.closest('[data-section-key]')?.getAttribute('data-section-key') as PortalSectionKey | null;
        const dragged = dragKeyRef.current;
        if (!targetKey || !dragged || targetKey === dragged || targetKey === lastTargetRef.current) return;
        if (MAIN_COLUMN.has(targetKey) !== MAIN_COLUMN.has(dragged)) return;
        lastTargetRef.current = targetKey;
        setOrder((prev) => {
          const from = prev.indexOf(dragged);
          const to = prev.indexOf(targetKey);
          if (from === -1 || to === -1 || from === to) return prev;
          const next = [...prev];
          next.splice(from, 1);
          next.splice(to, 0, dragged);
          return next;
        });
      };
      const handleUp = () => {
        document.removeEventListener('pointermove', handleMove);
        document.removeEventListener('pointerup', handleUp);
        setDraggedKey(null);
        dragKeyRef.current = null;
        lastTargetRef.current = null;
        upsertPortalSettings(projectId, { section_order: orderRef.current });
      };
      document.addEventListener('pointermove', handleMove);
      document.addEventListener('pointerup', handleUp);
    },
    [projectId, upsertPortalSettings],
  );

  if (!settings || !project) return null;

  const sentInvoices = getInvoicesByProject(projectId).filter((inv) => inv.status !== 'draft').length;
  const loggedHours = getTimeEntriesByProject(projectId).filter(isClientBillable).length;
  const updates = getPortalUpdates(projectId).length;
  const sharedFiles = getEntityFiles('project', projectId).filter((f) => f.visibility === 'external').length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // What the client sees for a section that is switched on.
  const status = (key: PortalSectionKey): { text: string; showing: boolean } => {
    switch (key) {
      case 'show_progress':
        if (project.status === 'completed') return { text: 'Shows the project as complete', showing: true };
        return project.start_date && project.due_date
          ? { text: 'A ring from kickoff to the due date', showing: true }
          : { text: 'Hidden until the project has a start and due date', showing: false };
      case 'show_invoices':
        return sentInvoices > 0
          ? { text: `Showing ${plural(sentInvoices, 'invoice')}`, showing: true }
          : { text: 'Hidden until an invoice is sent', showing: false };
      case 'show_hours':
        return loggedHours > 0
          ? { text: `Showing ${plural(loggedHours, 'session')}`, showing: true }
          : { text: 'Hidden until billable hours are logged', showing: false };
      case 'show_updates':
        return updates > 0
          ? { text: `Showing ${plural(updates, 'update')}`, showing: true }
          : { text: 'Hidden until you post an update', showing: false };
      case 'show_files':
        return sharedFiles > 0
          ? { text: `${plural(sharedFiles, 'shared file')}`, showing: true }
          : { text: 'Shows "No files shared yet"', showing: true };
      case 'show_credentials':
        return { text: 'Client can send you logins', showing: true };
    }
  };

  const visible = order.filter((key) => key !== 'show_hours' || project.hourly_tracking);
  const column = (main: boolean) => visible.filter((key) => MAIN_COLUMN.has(key) === main);

  const renderRow = (key: PortalSectionKey) => {
    const on = !!settings[key];
    const { text, showing } = status(key);
    return (
      <li
        key={key}
        data-section-key={key}
        className={`flex items-center gap-2 rounded-lg border px-2 py-2.5 transition-all ${
          on ? 'border-white/[0.08] bg-white/[0.03]' : 'border-white/[0.05] bg-transparent'
        } ${draggedKey === key ? 'ring-2 ring-brand-500/30 opacity-70' : ''}`}
      >
        <span
          onPointerDown={(e) => startDrag(key, e)}
          className="px-1 py-1 cursor-grab active:cursor-grabbing touch-none select-none text-zinc-600 hover:text-zinc-400"
          aria-hidden="true"
        >
          <GripVertical size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${on ? 'text-zinc-100' : 'text-zinc-500'}`}>{PORTAL_SECTION_LABELS[key]}</p>
          <p className={`text-xs truncate ${!on ? 'text-zinc-600' : showing ? 'text-zinc-500' : 'text-amber-300/80'}`} title={on ? text : 'Off'}>
            {on ? text : 'Off'}
          </p>
        </div>
        <Toggle
          size="sm"
          checked={on}
          onChange={(next) => upsertPortalSettings(projectId, { [key]: next })}
          aria-label={`Show ${PORTAL_SECTION_LABELS[key]} on the portal`}
          className="flex-shrink-0"
        />
      </li>
    );
  };

  return (
    <section className="glass-card rounded-xl">
      <div className="px-5 pt-4 pb-1 flex items-center gap-2">
        <LayoutTemplate size={16} className="text-zinc-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">Portal page</h2>
      </div>
      <p className="px-5 pb-4 text-xs text-zinc-500">
        What your client sees and in what order. Drag to reorder within a column.
      </p>
      <div className="px-5 pb-5 grid grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-5">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Main column</h3>
          <ul className="space-y-2">{column(true).map(renderRow)}</ul>
        </div>
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Sidebar</h3>
          <ul className="space-y-2">{column(false).map(renderRow)}</ul>
        </div>
      </div>
    </section>
  );
}
