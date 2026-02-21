'use client';

import { useEffect, useRef, useState } from 'react';

export interface TocSection {
  id: string;
  label: string;
  mobileLabel?: string;
  count?: number;
  /** Tailwind classes for the mobile pill in its default (non-active) state */
  mobilePill?: string;
}

export function DocsTocNav({
  sections,
  infoCutoff = 0,
  children,
}: {
  sections: TocSection[];
  infoCutoff?: number;
  children: React.ReactNode;
}) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '');
  const hasScrolled = useRef(false);
  const mobileNavRef = useRef<HTMLDivElement>(null);

  /* ── IntersectionObserver: track which section is in view ── */
  useEffect(() => {
    const ids = sections.map((s) => s.id);
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean) as HTMLElement[];

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      // Top 20% of viewport is the trigger zone.
      // A section becomes "active" when its top enters this zone.
      { rootMargin: '0px 0px -80% 0px' },
    );

    elements.forEach((el) => observer.observe(el));

    // Edge case: if the user is already near the bottom on load,
    // the last section might never enter the 20% zone. Handle via scroll.
    const handleScroll = () => {
      const nearBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 100;
      if (nearBottom && ids.length > 0) {
        setActiveId(ids[ids.length - 1]);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', handleScroll);
    };
    // sections are static (server-rendered props), so this runs once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Auto-scroll mobile TOC to keep active pill visible ── */
  useEffect(() => {
    // Skip the initial mount — only scroll after user interaction
    if (!hasScrolled.current) {
      hasScrolled.current = true;
      return;
    }

    const nav = mobileNavRef.current;
    if (!nav) return;

    const activeEl = nav.querySelector(`[data-section="${activeId}"]`) as HTMLElement | null;
    if (!activeEl) return;

    const navWidth = nav.clientWidth;
    const elLeft = activeEl.offsetLeft;
    const elWidth = activeEl.offsetWidth;

    // Center the active pill in the scrollable nav
    const target = elLeft - navWidth / 2 + elWidth / 2;
    nav.scrollTo({ left: target, behavior: 'smooth' });
  }, [activeId]);

  /* ── Derived slices ── */
  const infoSections = sections.slice(0, infoCutoff);
  const groupSections = sections.slice(infoCutoff);

  return (
    <>
      {/* ── Mobile TOC (horizontal scroll strip) ── */}
      <nav
        ref={mobileNavRef}
        className="lg:hidden sticky top-0 z-10 bg-white/95 backdrop-blur-sm border-b border-zinc-200 px-4 py-2.5 overflow-x-auto"
      >
        <div className="flex gap-1.5 min-w-max">
          {sections.map((s) => {
            const isActive = activeId === s.id;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                data-section={s.id}
                aria-current={isActive ? 'true' : undefined}
                className={`px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-zinc-900 text-white'
                    : s.mobilePill ?? 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {s.mobileLabel ?? s.label}
              </a>
            );
          })}
        </div>
      </nav>

      {/* ── Grid layout (sidebar + content) ── */}
      <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6 lg:grid lg:grid-cols-[220px_1fr] lg:gap-8">
        {/* Desktop sidebar TOC */}
        <aside className="hidden lg:block">
          <nav className="sticky top-6">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-3">
              On this page
            </p>
            <div className="space-y-0.5">
              {infoSections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  aria-current={activeId === s.id ? 'true' : undefined}
                  className={`block px-2.5 py-1.5 text-sm rounded-lg transition-colors ${
                    activeId === s.id
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  {s.label}
                </a>
              ))}

              {infoCutoff > 0 && <hr className="my-2.5 border-zinc-200" />}

              {groupSections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  aria-current={activeId === s.id ? 'true' : undefined}
                  className={`flex items-center justify-between px-2.5 py-1.5 text-sm rounded-lg transition-colors ${
                    activeId === s.id
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                  }`}
                >
                  <span>{s.label}</span>
                  {s.count !== undefined && (
                    <span
                      className={`text-[11px] tabular-nums ${
                        activeId === s.id ? 'text-brand-400' : 'text-zinc-400'
                      }`}
                    >
                      {s.count}
                    </span>
                  )}
                </a>
              ))}
            </div>
          </nav>
        </aside>

        {/* Server-rendered content (passed through) */}
        {children}
      </div>
    </>
  );
}
