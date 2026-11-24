import { redirect } from 'next/navigation';

/**
 * Agent analytics is the Agents page's Usage tab now. Old links and
 * bookmarks land there.
 */
export default function AgentAnalyticsPage() {
  redirect('/agent?tab=usage');
}
