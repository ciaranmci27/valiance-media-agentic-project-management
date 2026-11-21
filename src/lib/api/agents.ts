import type { AccessContext } from '@/lib/access-control';
import { isModuleEnabled } from '@/lib/access-control';
import { moduleOff } from './errors';

/**
 * Agent routes whose permission alone does not name the AI agents module (a
 * core permission such as audit.read or notifications.send) call this so they
 * go away with the module, like every agents permission does.
 */
export function requireAgentsEnabled(access: AccessContext) {
  if (!isModuleEnabled(access, 'agents')) throw moduleOff('agents');
}
