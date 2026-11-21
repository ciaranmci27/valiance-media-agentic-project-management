import { isModuleEnabled, type AccessContext } from '@/lib/access-control';

/**
 * What moving a project to Trash takes with it, naming only the parts this
 * workspace uses. Every delete-project dialog says the same line.
 */
export function projectTrashMessage(access: AccessContext | null | undefined): string {
  const parts = [
    'tasks',
    ...(isModuleEnabled(access, 'time') ? ['time'] : []),
    ...(isModuleEnabled(access, 'billing') ? ['invoices'] : []),
    'files',
    ...(isModuleEnabled(access, 'portal') ? ['the client portal'] : []),
  ];
  const list = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `The project goes to Trash with everything in it: ${list}.`;
}
