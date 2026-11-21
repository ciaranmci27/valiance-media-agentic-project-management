import { Bot, Clock, DollarSign, Globe, Inbox, KeyRound, Target, UserCircle, WalletCards, Webhook, type LucideIcon } from 'lucide-react';
import type { ModuleId } from '@/lib/modules/registry';

/** One icon per module, the same one its page uses in the sidebar. */
export const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  time: Clock,
  billing: DollarSign,
  // The payroll panel's own icon.
  team_pay: WalletCards,
  contacts: UserCircle,
  sales: Target,
  portal: Globe,
  inbox: Inbox,
  agents: Bot,
  credentials: KeyRound,
  webhooks: Webhook,
};
