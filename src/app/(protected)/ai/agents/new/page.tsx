'use client';

import { Suspense } from 'react';
import { HireFlow } from '@/components/agent/hire/HireFlow';

/** Hire an agent: the guided setup (template, identity, projects, powers, connect). */
export default function HireAgentPage() {
  // The flow reads ?project= (hiring from a project's Agents tab), which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <HireFlow />
    </Suspense>
  );
}
