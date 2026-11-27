/**
 * The logo bank (DESIGN.md Rule 20): every provider the app connects to or
 * names on a screen, by one id, with its label and how its mark is colored.
 * The marks themselves (SVG paths) are in components/ui/logos/marks.ts; the
 * one component that draws them is ProviderLogo. Pure, so the server, the
 * browser and the tests read the same rules.
 *
 * Only providers the app integrates with, or has reserved for an adapter,
 * belong here (chat apps, sign-in, email, AI tools and models, the release
 * repository and hosting). Anything else falls back to a neutral initials
 * tile, never a generic icon.
 */

export const LOGO_IDS = [
  // Chat apps.
  'telegram', 'slack', 'discord',
  // Google: sign-in, Gmail sending and forwarding, Meet notes, Gemini.
  'google', 'gmail', 'google-meet', 'gemini',
  // AI tools and model providers (Connect AI, hiring, provider plans).
  'claude', 'anthropic', 'openai',
  // Email sending and the inbound relay.
  'resend',
  // The release repository, hosting and the database (Settings > Updates, setup).
  'github', 'vercel', 'supabase',
] as const;

export type LogoId = (typeof LOGO_IDS)[number];

export interface LogoInfo {
  id: LogoId;
  label: string;
  /**
   * 'brand': the mark keeps its own color(s) in both themes. 'ink': a black
   * or white mark, drawn in the theme's ink (white on dark, near-black on
   * light) on a subtle tile, so it reads in both themes.
   */
  tone: 'brand' | 'ink';
}

export const LOGOS: Record<LogoId, LogoInfo> = {
  telegram: { id: 'telegram', label: 'Telegram', tone: 'brand' },
  slack: { id: 'slack', label: 'Slack', tone: 'brand' },
  discord: { id: 'discord', label: 'Discord', tone: 'brand' },
  google: { id: 'google', label: 'Google', tone: 'brand' },
  gmail: { id: 'gmail', label: 'Gmail', tone: 'brand' },
  'google-meet': { id: 'google-meet', label: 'Google Meet', tone: 'brand' },
  gemini: { id: 'gemini', label: 'Gemini', tone: 'brand' },
  claude: { id: 'claude', label: 'Claude', tone: 'brand' },
  anthropic: { id: 'anthropic', label: 'Anthropic', tone: 'ink' },
  openai: { id: 'openai', label: 'OpenAI', tone: 'ink' },
  resend: { id: 'resend', label: 'Resend', tone: 'ink' },
  github: { id: 'github', label: 'GitHub', tone: 'ink' },
  vercel: { id: 'vercel', label: 'Vercel', tone: 'ink' },
  supabase: { id: 'supabase', label: 'Supabase', tone: 'brand' },
};

/**
 * Other names the app uses for a provider in the bank, each with the label
 * it reads as there: Connect AI's tools, Gemini as an AI provider.
 */
const ALIASES: Record<string, { id: LogoId; label: string }> = {
  chatgpt: { id: 'openai', label: 'ChatGPT' },
  codex: { id: 'openai', label: 'Codex' },
  'claude-code': { id: 'claude', label: 'Claude Code' },
  'google-ai': { id: 'gemini', label: 'Gemini' },
  'google-gemini': { id: 'gemini', label: 'Gemini' },
};

/** A provider key as the app stores it ("Google Meet", "custom.mattermost", "claude_code") in the bank's form. */
export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/^custom\./, '').replace(/[\s_]+/g, '-');
}

/** The bank's logo for a provider key, with the label it reads as; null when the bank has none. */
export function resolveLogo(provider: string | null | undefined): { id: LogoId; label: string } | null {
  if (!provider) return null;
  const key = normalizeProvider(provider);
  if ((LOGO_IDS as readonly string[]).includes(key)) return { id: key as LogoId, label: LOGOS[key as LogoId].label };
  return ALIASES[key] ?? null;
}

/** A provider's name in words: the bank's label, else the key made readable ("custom.mattermost" reads "Mattermost"). */
export function logoLabel(provider: string): string {
  const known = resolveLogo(provider);
  if (known) return known.label;
  const words = normalizeProvider(provider).split('-').filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || provider.trim();
}

/** The neutral tile's letters for a provider the bank lacks: one per word, at most two ("Zoho Mail" reads ZM). */
export function logoInitials(name: string): string {
  const words = logoLabel(name).split(/[\s.-]+/).filter((word) => /[a-z0-9]/i.test(word));
  const letters = words.slice(0, 2).map((word) => (word.match(/[a-z0-9]/i)?.[0] ?? '').toUpperCase()).join('');
  return letters || '?';
}

// ── State badge ──────────────────────────────────────────────────────────

export const LOGO_BADGES = ['done', 'waiting', 'problem'] as const;
export type LogoBadge = (typeof LOGO_BADGES)[number];

/** The badge in words, for the logo's accessible name ("Telegram, connected"). */
export const LOGO_BADGE_WORDS: Record<LogoBadge, string> = {
  done: 'connected',
  waiting: 'waiting',
  problem: 'needs attention',
};

/**
 * A chat connection's health (chatConnectionHealth) as its logo's badge:
 * connected is done, waiting and needs agents wait, failing checks are a
 * problem; off and quiet carry none (their label says so).
 */
export function connectionHealthBadge(health: string): LogoBadge | null {
  if (health === 'connected') return 'done';
  if (health === 'waiting' || health === 'needs_agents') return 'waiting';
  if (health === 'not_receiving') return 'problem';
  return null;
}

/** A logo's accessible name: the provider, and its state when it carries a badge. */
export function logoAccessibleName(label: string, badge?: LogoBadge | null): string {
  return badge ? `${label}, ${LOGO_BADGE_WORDS[badge]}` : label;
}

// ── Provider picker ──────────────────────────────────────────────────────

/** The value ProviderPicker gives for "Other" when it asks for no name. */
export const OTHER_PROVIDER = 'other';

export interface ProviderChoice {
  /** What the picker gives when this is chosen (the provider key the app stores). */
  value: string;
  label: string;
  /** The bank logo to show; left out, the value is looked up in the bank. */
  logo?: string;
  description?: string;
  /** A reason it cannot be picked now ("Coming soon", "Already connected"). */
  meta?: string | null;
  disabled?: boolean;
}

/**
 * What a picker shows for a value: the choice it names (matched by value,
 * ignoring case and spacing), or Other with the typed name. `otherPicked`
 * is Other chosen with no name typed yet.
 */
export function providerPickerState(choices: readonly ProviderChoice[], value: string, otherPicked: boolean): { selected: string | null; otherName: string } {
  const typed = value.trim();
  const match = typed ? choices.find((choice) => normalizeProvider(choice.value) === normalizeProvider(typed)) : undefined;
  if (match) return { selected: match.value, otherName: '' };
  if (typed && typed !== OTHER_PROVIDER) return { selected: OTHER_PROVIDER, otherName: value };
  if (otherPicked || typed === OTHER_PROVIDER) return { selected: OTHER_PROVIDER, otherName: '' };
  return { selected: null, otherName: '' };
}

/**
 * The AI providers a subscription plan is for, by the provider key agents
 * report with their usage (agent_runs.provider, or the part of the model
 * before its slash): plans match runs by that key.
 */
export const AI_PROVIDER_CHOICES: readonly ProviderChoice[] = [
  { value: 'anthropic', label: 'Anthropic', logo: 'claude', description: 'Claude' },
  { value: 'openai', label: 'OpenAI', logo: 'openai', description: 'ChatGPT, Codex' },
  { value: 'google', label: 'Google', logo: 'gemini', description: 'Gemini' },
];
