'use client';

import type { ComponentProps } from 'react';
import { SaveBar } from '@/components/ui/SaveBar';

/**
 * The SaveBar (DESIGN.md Rule 8) at the foot of a Settings card: pulled out
 * to the card's edges (the card is `p-4 lg:p-5`, Rule 17) and pinned to the bottom of
 * the screen while the card scrolls past. Shown only while something changed.
 * Render it as the card's last child, so it sticks inside the card.
 */
export function SettingsSaveBar(props: Omit<ComponentProps<typeof SaveBar>, 'placement' | 'className'>) {
  return <SaveBar {...props} placement="screen" className="-mx-4 -mb-4 mt-6 lg:-mx-5 lg:-mb-5" />;
}
