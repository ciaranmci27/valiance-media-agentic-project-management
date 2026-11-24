import { redirect } from 'next/navigation';

/**
 * Agent analytics is the Agents page's Analytics tab. Old links and
 * bookmarks land there.
 */
export default function AgentAnalyticsPage() {
  redirect('/agent?tab=analytics');
}
