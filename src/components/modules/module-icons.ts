import { Bot, Clock, DollarSign, Globe, Inbox, KeyRound, Target, UserCircle, Webhook, type LucideIcon } from 'lucide-react';
import type { ModuleId } from '@/lib/modules/registry';

/** One icon per module, the same one its page uses in the sidebar. */
export const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  time: Clock,
  billing: DollarSign,
  contacts: UserCircle,
  sales: Target,
  portal: Globe,
  inbox: Inbox,
  agents: Bot,
  credentials: KeyRound,
  webhooks: Webhook,
};
