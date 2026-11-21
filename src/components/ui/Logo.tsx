'use client';

import { useState } from 'react';
import { useBrand } from '@/lib/brand/context';

/**
 * The workspace's logo from Settings > Workspace > Brand. `variant="dark"`
 * picks the logo drawn for dark backgrounds (the light one when none is
 * uploaded). With no logo, or one that fails to load, it shows the name as
 * text in the same place, keeping `className` so visibility classes still
 * apply. `invert` flips the image only, never the name text.
 */
export function Logo({ className, variant, invert = false }: { className?: string; variant?: 'dark'; invert?: boolean }) {
  const brand = useBrand();
  const src = variant === 'dark' ? brand.logos.dark : brand.logos.light;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!src || failedSrc === src) {
    return (
      <span className={className}>
        <span className="font-bold tracking-tight whitespace-nowrap">{brand.name}</span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- an uploaded file of any size, served from storage
    <img
      src={src}
      alt={brand.name}
      className={`object-contain ${className ?? ''}${invert ? ' invert' : ''}`.trim()}
      onError={() => setFailedSrc(src)}
    />
  );
}
