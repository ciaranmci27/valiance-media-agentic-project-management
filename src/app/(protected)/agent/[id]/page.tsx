import { redirect } from 'next/navigation';
import { legacyAgentProfileRedirect, searchParamsOf, type PageSearchParams } from '@/lib/ai-home';

/** An agent's page moved to /ai/agents/<id>; its tab and other params come along. */
export default async function AgentProfileRedirect({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<PageSearchParams> }) {
  const { id } = await params;
  redirect(legacyAgentProfileRedirect(decodeURIComponent(id), searchParamsOf(await searchParams)));
}
