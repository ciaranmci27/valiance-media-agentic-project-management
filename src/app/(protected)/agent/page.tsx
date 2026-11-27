import { redirect } from 'next/navigation';
import { legacyAgentsRedirect, searchParamsOf, type PageSearchParams } from '@/lib/ai-home';

/** The old Agents page: its views live in AI > Company AI now, deep links kept. */
export default async function AgentsRedirect({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  redirect(legacyAgentsRedirect(searchParamsOf(await searchParams)));
}
