import { redirect } from 'next/navigation';
import { legacyAssistantSettingsRedirect } from '@/lib/ai-home';

/** Settings > Assistants is AI > Setup now. */
export default function AssistantsSettingsRedirect() {
  redirect(legacyAssistantSettingsRedirect());
}
