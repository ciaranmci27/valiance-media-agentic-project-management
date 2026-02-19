'use client';

import { useState } from 'react';
import { siteConfig } from '@/site-config';

export function Logo({ className }: { className?: string }) {
  const [src, setSrc] = useState('/logos/logo.svg');
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
      src={src}
      alt={siteConfig.name}
      className={className}
      onError={() => {
        if (src === '/logos/logo.svg') {
          setSrc('/logos/logo.png');
        } else {
          setImgFailed(true);
        }
      }}
    />
  );
}
