'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Modal from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth-context';
import { isModuleEnabled } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';

// A shortcut to a module's page works, and is listed, only while the module is on.
const SHORTCUTS: { keys: string[]; description: string; module?: ModuleId }[] = [
  { keys: ['G', 'D'], description: 'Go to Dashboard' },
  { keys: ['G', 'P'], description: 'Go to Projects' },
  { keys: ['G', 'L'], description: 'Go to Leads', module: 'sales' },
  { keys: ['G', 'C'], description: 'Go to Contacts', module: 'contacts' },
  { keys: ['G', 'T'], description: 'Go to Team' },
  { keys: ['G', 'S'], description: 'Go to Settings' },
  { keys: ['/'], description: 'Focus search' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
];

const ROUTES: Record<string, { href: string; module?: ModuleId }> = {
  d: { href: '/dashboard' },
  p: { href: '/projects' },
  l: { href: '/leads', module: 'sales' },
  c: { href: '/contacts', module: 'contacts' },
  t: { href: '/team' },
  s: { href: '/settings/account' },
};

export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const { access } = useAuth();
  const [showHelp, setShowHelp] = useState(false);
  const [pendingG, setPendingG] = useState(false);

  const isInputFocused = useCallback(() => {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || (active as HTMLElement).isContentEditable;
  }, []);

  useEffect(() => {
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.key) return;

      const key = e.key.toLowerCase();

      // Show shortcuts help
      if (key === '?' || (e.shiftKey && key === '/')) {
        e.preventDefault();
        setShowHelp(prev => !prev);
        return;
      }

      // Focus search (/ key)
      if (key === '/' && !e.shiftKey) {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder*="Search"], input[placeholder*="search"]'
        );
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
        return;
      }

      // "G" prefix for navigation
      if (key === 'g' && !pendingG) {
        setPendingG(true);
        gTimer = setTimeout(() => setPendingG(false), 1000);
        return;
      }

      if (pendingG) {
        setPendingG(false);
        if (gTimer) clearTimeout(gTimer);

        const route = ROUTES[key];
        if (route && (!route.module || isModuleEnabled(access, route.module)) && pathname !== route.href) {
          e.preventDefault();
          router.push(route.href);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [pendingG, isInputFocused, router, pathname, access]);

  return (
    <Modal
      isOpen={showHelp}
      onClose={() => setShowHelp(false)}
      title="Keyboard Shortcuts"
      size="sm"
    >
      <div className="space-y-1">
        {SHORTCUTS.filter((shortcut) => !shortcut.module || isModuleEnabled(access, shortcut.module)).map((shortcut) => (
          <div
            key={shortcut.description}
            className="flex items-center justify-between py-2 px-1"
          >
            <span className="text-sm text-zinc-300">{shortcut.description}</span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key, i) => (
                <span key={i}>
                  {i > 0 && <span className="text-xs text-zinc-500 mx-0.5">then</span>}
                  <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono font-medium text-zinc-300 bg-white/[0.06] border border-white/[0.08] rounded">
                    {key}
                  </kbd>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
