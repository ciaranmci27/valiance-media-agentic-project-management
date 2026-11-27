import { redirect } from 'next/navigation';
import { legacyAgentsRedirect } from '@/lib/ai-home';

/** Agent analytics is AI > Company AI > Analytics. Old links and bookmarks land there. */
export default function AgentAnalyticsPage() {
  redirect(legacyAgentsRedirect(new URLSearchParams({ tab: 'analytics' })));
}
