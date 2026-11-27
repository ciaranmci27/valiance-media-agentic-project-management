import 'server-only';
import type { HttpMethod } from '../core';
import * as assistantSettings from '@/app/api/v1/assistants/settings/route';
import * as assistantStatus from '@/app/api/v1/assistants/status/route';
import * as assistantBind from '@/app/api/v1/assistants/bind/route';
import * as assistantSetup from '@/app/api/v1/assistant-setups/[id]/route';
import * as myAssistant from '@/app/api/v1/me/assistant/route';
import * as myAssistantUndo from '@/app/api/v1/me/assistant/undo/route';
import * as myAssistantActivity from '@/app/api/v1/me/assistant/activity/route';
import * as myPersonalAgents from '@/app/api/v1/me/personal-agents/route';
import * as chatConnections from '@/app/api/v1/chat/connections/route';
import * as chatConnection from '@/app/api/v1/chat/connections/[id]/route';
import * as chatConnectionAgents from '@/app/api/v1/chat/connections/[id]/agents/route';
import * as chatChannels from '@/app/api/v1/chat/connections/[id]/channels/route';
import * as chatChannel from '@/app/api/v1/chat/connections/[id]/channels/[channelId]/route';

/** Assistants and chat connections: the v1 route module behind each tool path (routes.ts merges these). */
export const ASSISTANTS_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  // Assistants
  '/api/v1/assistants/settings': assistantSettings,
  '/api/v1/assistants/status': assistantStatus,
  '/api/v1/assistants/bind': assistantBind,
  // Assistant setups (the collection is in handlers.ts)
  '/api/v1/assistant-setups/{id}': assistantSetup,
  // My assistant
  '/api/v1/me/assistant': myAssistant,
  '/api/v1/me/assistant/undo': myAssistantUndo,
  '/api/v1/me/assistant/activity': myAssistantActivity,
  '/api/v1/me/personal-agents': myPersonalAgents,
  // Chat connections
  '/api/v1/chat/connections': chatConnections,
  '/api/v1/chat/connections/{id}': chatConnection,
  '/api/v1/chat/connections/{id}/agents': chatConnectionAgents,
  '/api/v1/chat/connections/{id}/channels': chatChannels,
  '/api/v1/chat/connections/{id}/channels/{channelId}': chatChannel,
};
