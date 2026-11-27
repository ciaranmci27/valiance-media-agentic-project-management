import { redirect } from 'next/navigation';
import { legacyHireRedirect, searchParamsOf, type PageSearchParams } from '@/lib/ai-home';

/** Hiring moved to /ai/agents/new; ?project= and ?mode= come along. */
export default async function HireRedirect({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  redirect(legacyHireRedirect(searchParamsOf(await searchParams)));
}
