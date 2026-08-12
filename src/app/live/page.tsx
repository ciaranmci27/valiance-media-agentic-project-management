import type { Metadata } from 'next';
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
  title: 'Agent Live — Simulation',
  description: 'Walk the agent floor: a real-time 3D simulation of an autonomous dev team at work.',
};

export default function LiveSimPage() {
  return <LiveSimClient />;
}
