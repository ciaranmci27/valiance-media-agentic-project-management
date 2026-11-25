'use client';

import { Suspense } from 'react';
import { MyAssistantPage } from '@/components/assistant/MyAssistantPage';

/** My Assistant: every person's own assistant, on one plain page. */
export default function AssistantPage() {
  return (
    <Suspense fallback={null}>
      <MyAssistantPage />
    </Suspense>
  );
}
