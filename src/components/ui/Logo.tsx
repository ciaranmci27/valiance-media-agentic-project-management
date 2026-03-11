'use client';

import { useState } from 'react';
import { siteConfig } from '@/site-config';

export function Logo({ className }: { className?: string }) {
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
      src="/api/logo"
      alt={siteConfig.name}
      className={className}
      onError={() => setImgFailed(true)}
    />
  );
}
