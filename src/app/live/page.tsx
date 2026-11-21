import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getServiceClient } from '@/lib/api/supabase-service';
import { moduleEnabled } from '@/lib/modules/server';
import { LiveSimClient } from './live-client';

/**
 * The public face of /agent/live.
 *
 * Anyone who follows a shared link to the floor lands here: signed-in members
 * fall through the middleware to the real page under (protected), and
 * anonymous visitors are rewritten to this one — same address in the bar,
 * different floor behind it. It also answers /live directly, so the short
 * link works too.
 *
 * Everything real about this page is in `LiveSimClient`; this file exists to
 * be a server component with metadata, and to hold the explanation of how the
 * two-audience routing works in one place.
 */
export const metadata: Metadata = {
  title: 'Agent Simulator',
  description: 'Walk the floor: a live, read-only 3D view of an autonomous dev team at work.',
};

// Whether the floor exists depends on the AI agents module, read per request.
export const dynamic = 'force-dynamic';

export default async function LiveSimPage() {
  // The floor is the AI agents module's: switched off, the link is not found.
  // Demo mode has no database and keeps its switches in the browser.
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true' && !(await moduleEnabled(getServiceClient(), 'agents'))) {
    notFound();
  }
  return <LiveSimClient />;
}
