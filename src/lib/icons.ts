/**
 * One icon, one meaning (DESIGN.md "Icons"). Each thing a person knows in the
 * app has exactly one icon, and an icon never stands for two things. New code
 * takes its icon from here; when a screen needs an icon for something not
 * listed, add it here first (and to DESIGN.md), never reuse one that already
 * means something else.
 */
import {
  Bell, Bot, CalendarClock, CheckSquare, CircleArrowUp, Clock, CornerUpLeft, FileText, FolderKanban, Gift,
  Hand, Inbox, KeyRound, LayoutTemplate, Mail, Megaphone, MoreHorizontal, Receipt, RefreshCw, Repeat,
  RotateCcw, Settings, Sparkles, Target, Trash2, Undo2, UserCircle, Users, Video, Webhook, Zap,
  type LucideIcon,
} from 'lucide-react';

export const ICONS = {
  /** AI: My assistant, Connect AI, and anything an AI wrote, sorted or suggested. Nothing else. */
  ai: Sparkles,
  /** An agent as a member of the team: the AI Agents home and its sidebar entry, the agents list, an agent's profile, a notice from an agent. */
  agent: Bot,
  /** Something waiting on this person: Needs you. */
  needsYou: Zap,
  notifications: Bell,
  /** What's new in a release. */
  whatsNew: Gift,
  /** Settings > Updates: installing a new release. */
  update: CircleArrowUp,
  task: CheckSquare,
  project: FolderKanban,
  inbox: Inbox,
  email: Mail,
  meeting: Video,
  lead: Target,
  contact: UserCircle,
  team: Users,
  template: LayoutTemplate,
  /** A schedule: when a template runs. */
  schedule: CalendarClock,
  /** Something that repeats (a task's Repeat row, a scheduled template's chip). */
  repeats: Repeat,
  time: Clock,
  invoice: FileText,
  billing: Receipt,
  /** An update posted to a project, an initiative or the portal. */
  postedUpdate: Megaphone,
  /** Greeting a client (the portal welcome). */
  welcome: Hand,
  apiKey: KeyRound,
  webhook: Webhook,
  settings: Settings,
  /** Undo what just happened (UndoLine, toasts). */
  undo: Undo2,
  /** Bring back an earlier state: restore from Trash, reopen, reset to defaults. */
  restore: RotateCcw,
  /** Try again, reload or ask again. */
  retry: RefreshCw,
  /** Hand something back to the agent that sent it. */
  sendBack: CornerUpLeft,
  /** Move to Trash. */
  trash: Trash2,
  /** The one row menu trigger (RowActionsMenu). */
  more: MoreHorizontal,
} as const satisfies Record<string, LucideIcon>;

export type IconMeaning = keyof typeof ICONS;

/** Each meaning in plain words, for the design page and anywhere the map is listed. */
export const ICON_MEANINGS: Record<IconMeaning, string> = {
  ai: 'AI',
  agent: 'An agent',
  needsYou: 'Needs you',
  notifications: 'Notifications',
  whatsNew: "What's new",
  update: 'Install an update',
  task: 'Task',
  project: 'Project',
  inbox: 'Inbox',
  email: 'Email',
  meeting: 'Meeting',
  lead: 'Lead',
  contact: 'Contact',
  team: 'Team',
  template: 'Template',
  schedule: 'Schedule',
  repeats: 'Repeats',
  time: 'Time',
  invoice: 'Invoice',
  billing: 'Billing',
  postedUpdate: 'Posted update',
  welcome: 'Welcome',
  apiKey: 'API key',
  webhook: 'Webhook',
  settings: 'Settings',
  undo: 'Undo',
  restore: 'Restore or reopen',
  retry: 'Try again',
  sendBack: 'Send back',
  trash: 'Move to Trash',
  more: 'More actions',
};
