import { redirect } from 'next/navigation';
import { legacyAssistantRedirect, searchParamsOf, type PageSearchParams } from '@/lib/ai-home';

/** My Assistant is AI > Your assistant now. */
export default async function AssistantRedirect({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  redirect(legacyAssistantRedirect(searchParamsOf(await searchParams)));
}
