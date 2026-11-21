import { Bot, Crown, Shield, User, UserMinus, type LucideIcon } from 'lucide-react';
import type { TeamMember } from '@/lib/types';

type Role = TeamMember['role'];

const ROLE_ICONS: Record<Role, LucideIcon> = {
  owner: Crown,
  admin: Shield,
  member: User,
  guest: UserMinus,
  agent: Bot,
};

const ROLE_COLORS: Record<Role, string> = {
  owner: 'bg-amber-500/15 text-amber-300',
  admin: 'bg-brand-500/15 text-brand-300',
  member: 'bg-white/[0.06] text-zinc-300',
  guest: 'bg-amber-500/15 text-amber-300',
  agent: 'bg-purple-500/15 text-purple-300',
};

export const roleLabel = (role: Role) => role.charAt(0).toUpperCase() + role.slice(1);

/** A person's role as the Team page shows it: icon and name in a tinted pill. */
export function RoleChip({ role }: { role: Role }) {
  const Icon = ROLE_ICONS[role];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${ROLE_COLORS[role]}`}>
      <Icon size={12} aria-hidden="true" />
      {roleLabel(role)}
    </span>
  );
}

/** Active or Suspended. `dense` for table rows. */
export function MemberStatusChip({ status, dense = false }: { status?: TeamMember['status']; dense?: boolean }) {
  const suspended = status === 'suspended';
  return (
    <span
      className={`inline-flex items-center px-2 ${dense ? 'py-0.5' : 'py-1'} rounded-full text-xs font-medium whitespace-nowrap ${
        suspended ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'
      }`}
    >
      {suspended ? 'Suspended' : 'Active'}
    </span>
  );
}
