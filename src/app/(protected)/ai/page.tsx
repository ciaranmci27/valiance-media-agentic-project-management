'use client';

import { Suspense } from 'react';
import { ModulePage } from '@/components/modules/ModuleGate';
import { AiHomePage } from '@/components/ai/AiHomePage';

/** AI: your assistant, the company's agents and their setup, in one place (lib/ai-home). */
export default function AiPage() {
  // The open part is the URL's ?tab=, which needs a Suspense boundary.
  return (
    <ModulePage module="agents">
      <Suspense fallback={null}>
        <AiHomePage />
      </Suspense>
    </ModulePage>
  );
}
