import { isModuleEnabled, type AccessContext } from '@/lib/access-control';

/** The parts of a project that go to Trash with it, naming only the parts this workspace uses. */
function projectParts(access: AccessContext | null | undefined): string {
  const parts = [
    'tasks',
    ...(isModuleEnabled(access, 'time') ? ['time'] : []),
    ...(isModuleEnabled(access, 'billing') ? ['invoices'] : []),
    'files',
    ...(isModuleEnabled(access, 'portal') ? ['the client portal'] : []),
  ];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The line a project leaves once it is in Trash, beside Undo (DESIGN.md Rule 6). */
export function projectTrashedLine(name: string | undefined, access: AccessContext | null | undefined): string {
  return `${name ? `"${name}"` : 'Project'} moved to Trash with its ${projectParts(access)}`;
}
