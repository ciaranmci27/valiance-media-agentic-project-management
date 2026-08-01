'use client';

import { useState } from 'react';
import { siteConfig } from '@/site-config';

/**
 * Bumped when the bytes behind a logo URL change. The route revalidates via
 * ETag now, so this is not needed for ordinary updates; it exists because the
 * dark variant briefly shipped with `Cache-Control: immutable`, which pins the
 * old image in every browser that loaded it for a full day. Those entries are
 * keyed on the old URL, so moving off it is the only way to reach them.
 */
const ASSET_VERSION = 2;

/**
 * `variant="dark"` requests the lockup drawn for dark chrome: the mark as the
 * brand draws it, paired with a light wordmark. The route falls back to the
 * standard logo if the brand has not supplied one, so it is always safe to ask
 * for.
 */
export function Logo({ className, variant }: { className?: string; variant?: 'dark' }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (imgFailed) {
    return (
      <span className="font-bold tracking-tight" aria-label={siteConfig.name}>
        {siteConfig.name}
      </span>
    );
  }

  return (
    <img
      src={variant === 'dark' ? `/api/logo?variant=dark&v=${ASSET_VERSION}` : '/api/logo'}
      alt={siteConfig.name}
      className={className}
      onError={() => setImgFailed(true)}
    />
  );
}
