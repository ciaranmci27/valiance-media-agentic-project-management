import { MODULE_IDS, type ModuleId } from '@/lib/modules/registry';

/**
 * First-run setup. On a fresh install with nobody on the team, every visit
 * goes to the wizard's first step, where the Owner makes their account
 * (lib/setup/first-owner.ts). After that, while the workspace has no
 * setup_completed_at, the Owner is taken to the rest of the wizard (/welcome)
 * from anywhere in the app until they finish it; there is no skipping it.
 * Nobody else ever sees it. Once setup is done the wizard sends people to
 * the Dashboard, except an Owner opening it as a preview (?preview=1).
 */

export const WELCOME_PATH = '/welcome';
export const AFTER_SETUP_PATH = '/dashboard';

export interface SetupGateInput {
  role: string | null | undefined;
  /** Undefined while the setup state is still loading (or could not be read). */
  setupCompleted: boolean | undefined;
  pathname: string;
  demo: boolean;
  /** An Owner looking at the wizard after setup (/welcome?preview=1), from Settings > Workspace. */
  preview?: boolean;
}

/** The wizard itself (not /welcome/set-password, the signed-out page for invited people). */
export function isWelcomePath(pathname: string): boolean {
  return pathname === WELCOME_PATH;
}

/** Where this person should be instead of `pathname`, or null to stay. */
export function setupRedirect({ role, setupCompleted, pathname, demo, preview = false }: SetupGateInput): string | null {
  const onWelcome = isWelcomePath(pathname);
  // A preview is only ever an Owner's, and only once setup is done (before
  // that, the wizard itself is where they are going anyway).
  if (onWelcome && preview && !demo && role === 'owner' && setupCompleted === true) return null;
  const needsSetup = !demo && role === 'owner' && setupCompleted === false;
  if (needsSetup) return onWelcome ? null : WELCOME_PATH;
  // Unknown yet: an Owner waits on the wizard rather than bouncing off it.
  if (onWelcome && role === 'owner' && setupCompleted === undefined && !demo) return null;
  return onWelcome ? AFTER_SETUP_PATH : null;
}

/** Whether the shell must wait before showing a page: an Owner's setup state is not known yet. */
export function setupPending({ role, setupCompleted, demo }: Omit<SetupGateInput, 'pathname'>): boolean {
  return !demo && role === 'owner' && setupCompleted === undefined;
}

export type WizardStepId = 'account' | 'workspace' | 'usage' | 'billing' | 'email' | 'team' | 'projects' | 'done';

/**
 * The wizard's steps for the switched-on modules: Billing details only with
 * Client invoicing on. Your account comes first: it is made before signing
 * in (/welcome/create-account), so inside the app it always shows as done.
 */
export function wizardSteps(modules: readonly ModuleId[] = MODULE_IDS): WizardStepId[] {
  return [
    'account',
    'workspace',
    'usage',
    ...(modules.includes('billing') ? ['billing' as const] : []),
    'email',
    'team',
    'projects',
    'done',
  ];
}

export interface GettingStartedInput {
  brandSet: boolean;
  /** People other than the Owners and agents. */
  teamInvited: boolean;
  hasProject: boolean;
  billingOn: boolean;
  billingDetailsSet: boolean;
}

export type GettingStartedItem = 'brand' | 'team' | 'project' | 'billing';

/** The Dashboard checklist after setup: what is still left to do, in order. */
export function gettingStartedLeft(input: GettingStartedInput): GettingStartedItem[] {
  const left: GettingStartedItem[] = [];
  if (!input.brandSet) left.push('brand');
  if (!input.teamInvited) left.push('team');
  if (!input.hasProject) left.push('project');
  if (input.billingOn && !input.billingDetailsSet) left.push('billing');
  return left;
}
