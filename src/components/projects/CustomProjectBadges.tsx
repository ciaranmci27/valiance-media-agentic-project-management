'use client';

import { Fragment } from 'react';
import type { Project } from '@/lib/types';
import { useCustomProjectBadges } from '@/lib/extensions/hooks';

/**
 * The install's badges beside a project's name (projectBadges in
 * src/custom/index.ts), after the core ones. Renders nothing when the install
 * registers none; each badge decides for itself whether it applies.
 */
export function CustomProjectBadges({ project }: { project: Project }) {
  const badges = useCustomProjectBadges();
  if (!badges.length) return null;
  return (
    <>
      {badges.map(({ key, component: Badge }) => (
        <Fragment key={key}><Badge project={project} /></Fragment>
      ))}
    </>
  );
}
