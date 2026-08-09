'use client';

import dynamic from 'next/dynamic';

const Lab = dynamic(() => import('./LabScene'), { ssr: false });

export function LabClient({ clip }: { clip?: string }) {
  return <Lab clip={clip} />;
}
