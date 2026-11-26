import type { ChatAdapter } from './adapter';
import { discordAdapter } from './discord';
import { slackAdapter } from './slack';
import { telegramAdapter } from './telegram';

export { chatHttp, ChatProviderError, type ChatAdapter, type ChatCredentials, type ParsedInbound } from './adapter';

/** Every provider with an adapter. A new one is a file here and a line below. */
const ADAPTERS: Record<string, ChatAdapter> = {
  slack: slackAdapter,
  telegram: telegramAdapter,
  discord: discordAdapter,
};

/** The adapter for a provider, or null when none exists yet (teams, custom). */
export function chatAdapter(provider: string): ChatAdapter | null {
  return ADAPTERS[provider] ?? null;
}
