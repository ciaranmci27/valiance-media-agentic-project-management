'use client';

import { Suspense } from 'react';
import { ProjectSetupFlow } from '@/components/projects/setup/ProjectSetupFlow';

/** Set up a project: basics, brief, agents, people. Reads ?client= (from a contact), so it needs a Suspense boundary. */
export default function NewProjectPage() {
  return (
    <Suspense fallback={null}>
      <ProjectSetupFlow />
    </Suspense>
  );
}
