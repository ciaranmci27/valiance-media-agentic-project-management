'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { AgentProfile } from '@/components/agent/profile/AgentProfile';

/** One agent's profile. Its tab is the URL's ?tab=, which needs a Suspense boundary. */
export default function AgentProfilePage() {
  const params = useParams();
  return (
    <Suspense fallback={null}>
      <AgentProfile key={params.id as string} agentId={params.id as string} />
    </Suspense>
  );
}
